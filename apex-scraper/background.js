// Apex Scraper v6 — Background queue engine.
//
// INTEGRITY: this engine never produces fake records. A URL ends in exactly
// one of: a real extracted record (status ok/partial), or an honest failure
// record (status failed/blocked + failReason). No mock data, no random values.
//
// Two-tier scraping:
//   Tier 1 — offscreen fetch + DOMParser (fast, low footprint)
//   Tier 2 — live hidden-tab render + injected extractor (beats bot walls and
//            JS-rendered marketplaces; uses the user's real browser session)

let queue = [];
let currentIndex = 0;     // next task to hand out (resume pointer)
let completedCount = 0;   // tasks fully finished (drives progress/completion)
let isScraping = false;
let isPaused = false;
let delayMs = 1000;
let concurrency = 3;

let resultsBuffer = [];
const CHUNK_FLUSH_SIZE = 50;
let chunkIndex = 0;
let totalSavedResultsCount = 0;
let selfHealedCount = 0;   // records rescued by Tier-2 or with real derivations
let failedCount = 0;       // honest failures

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_RECREATION_INTERVAL = 250;
let offscreenPagesParsedCount = 0;

const TAB_MODE_MAX_CONCURRENT = 2;   // protects device performance
const TAB_LOAD_TIMEOUT_MS = 30000;
const TAB_SETTLE_MS = 2500;          // let client-side prices hydrate
let activeTabSlots = 0;

// ---------------------------------------------------------------- keep-alive
chrome.alarms.create('apex_keep_alive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'apex_keep_alive') {
    chrome.storage.local.get(['isScraping'], (data) => {
      if (data.isScraping && !isScraping) restoreStateAndProcess();
    });
  }
});

// ------------------------------------------------------------ offscreen mgmt
async function setupOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Parse fetched marketplace HTML into structured product data'
  });
}

async function closeOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) await chrome.offscreen.closeDocument();
}

let isRecycling = false;
async function recycleOffscreenDocument() {
  if (isRecycling) return;
  isRecycling = true;
  try {
    await closeOffscreenDocument();
    await setupOffscreenDocument();
  } catch (e) {
    console.error('[Apex] offscreen recycle failed:', e);
  } finally {
    isRecycling = false;
  }
}

// -------------------------------------------------------------- chunk store
async function clearAllScrapedChunks() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const keysToRemove = Object.keys(items).filter(key =>
        key.startsWith('sleepwell_chunk_') ||
        ['totalSavedResultsCount', 'chunkIndex', 'resultsBuffer', 'selfHealedCount', 'failedCount'].includes(key)
      );
      chrome.storage.local.remove(keysToRemove, () => resolve());
    });
  });
}

async function flushBufferToDisk() {
  if (resultsBuffer.length === 0) return;
  return new Promise((resolve) => {
    const key = `sleepwell_chunk_${chunkIndex}`;
    const payload = {};
    payload[key] = resultsBuffer;
    totalSavedResultsCount += resultsBuffer.length;
    chunkIndex++;
    payload['chunkIndex'] = chunkIndex;
    payload['totalSavedResultsCount'] = totalSavedResultsCount;
    payload['selfHealedCount'] = selfHealedCount;
    payload['failedCount'] = failedCount;
    payload['resultsBuffer'] = [];
    payload['currentIndex'] = currentIndex;
    payload['completedCount'] = completedCount;
    chrome.storage.local.set(payload, () => {
      resultsBuffer = [];
      resolve();
    });
  });
}

async function addResultToBuffer(data) {
  data.scrapeTime = new Date().toLocaleString();
  data.scrapeDate = new Date().toISOString().slice(0, 10);
  resultsBuffer.push(data);

  if ((data.corrections_made && data.corrections_made.length > 0) || data.rescuedByTabRender) selfHealedCount++;
  if (data.status === 'failed' || data.status === 'blocked') failedCount++;

  if (resultsBuffer.length >= CHUNK_FLUSH_SIZE) {
    await flushBufferToDisk();
  } else if (currentIndex % 25 === 0) {
    await chrome.storage.local.set({
      resultsBuffer, currentIndex, completedCount, selfHealedCount, failedCount
    });
  }
}

async function restoreStateAndProcess() {
  chrome.storage.local.get([
    'queue', 'currentIndex', 'completedCount', 'isScraping', 'isPaused',
    'concurrency', 'delayMs', 'chunkIndex',
    'totalSavedResultsCount', 'resultsBuffer', 'selfHealedCount', 'failedCount'
  ], async (data) => {
    if (data.isScraping && data.queue && data.queue.length > 0) {
      queue = data.queue;
      currentIndex = data.currentIndex || 0;
      completedCount = data.completedCount || currentIndex || 0;
      isScraping = true;
      isPaused = data.isPaused || false;
      concurrency = data.concurrency || 3;
      delayMs = data.delayMs || 1000;
      chunkIndex = data.chunkIndex || 0;
      totalSavedResultsCount = data.totalSavedResultsCount || 0;
      resultsBuffer = data.resultsBuffer || [];
      selfHealedCount = data.selfHealedCount || 0;
      failedCount = data.failedCount || 0;
      if (!isPaused) processQueueInParallel();
    }
  });
}

// ----------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false; // not for us

  if (message.action === 'start_scraping') {
    isScraping = true;
    isPaused = false;
    currentIndex = 0;
    completedCount = 0;
    chunkIndex = 0;
    totalSavedResultsCount = 0;
    selfHealedCount = 0;
    failedCount = 0;
    resultsBuffer = [];
    queue = message.links.map(url => ({ url }));
    delayMs = message.delay || 1000;
    concurrency = Math.min(message.concurrency || 3, 6);

    chrome.storage.local.set({
      queue, currentIndex, completedCount, isScraping, isPaused, concurrency, delayMs,
      chunkIndex, totalSavedResultsCount, selfHealedCount, failedCount, resultsBuffer
    }).then(async () => {
      await clearAllScrapedChunks();
      processQueueInParallel();
    });
    sendResponse({ status: 'started' });
    return false;
  }
  if (message.action === 'pause_scraping') {
    isPaused = true;
    chrome.storage.local.set({ isPaused: true }).then(() =>
      flushBufferToDisk().then(() => sendResponse({ status: 'paused' })));
    return true;
  }
  if (message.action === 'resume_scraping') {
    chrome.storage.local.get(['isPaused'], (data) => {
      if (data.isPaused) {
        isPaused = false;
        isScraping = true;
        chrome.storage.local.set({ isPaused: false }).then(() => {
          restoreStateAndProcess();
          sendResponse({ status: 'resumed' });
        });
      } else sendResponse({ status: 'not_paused' });
    });
    return true;
  }
  if (message.action === 'stop_scraping') {
    isScraping = false;
    isPaused = false;
    flushBufferToDisk().then(() => {
      chrome.storage.local.set({ isScraping: false, isPaused: false, currentIndex, completedCount });
      closeOffscreenDocument();
      sendResponse({ status: 'stopped' });
    });
    return true;
  }
  if (message.action === 'get_state') {
    if (queue.length > 0) {
      // Live in-memory view (most accurate while the service worker is alive)
      sendResponse({
        isScraping, isPaused,
        processed: completedCount,
        total: queue.length,
        isComplete: completedCount >= queue.length,
        selfHealedCount, failedCount
      });
      return false;
    }
    chrome.storage.local.get([
      'isScraping', 'isPaused', 'currentIndex', 'completedCount', 'queue',
      'totalSavedResultsCount', 'resultsBuffer', 'selfHealedCount', 'failedCount'
    ], (data) => {
      const activeQ = data.queue || [];
      const totalProcessed = data.completedCount ?? data.currentIndex ?? 0;
      sendResponse({
        isScraping: data.isScraping || false,
        isPaused: data.isPaused || false,
        processed: totalProcessed,
        total: activeQ.length,
        isComplete: (totalProcessed >= activeQ.length) && activeQ.length > 0,
        selfHealedCount: data.selfHealedCount || 0,
        failedCount: data.failedCount || 0
      });
    });
    return true;
  }
  if (message.action === 'get_results') {
    chrome.storage.local.get(null, (data) => {
      const allResults = [];
      const totalChunks = data.chunkIndex || 0;
      for (let i = 0; i < totalChunks; i++) {
        const chunk = data[`sleepwell_chunk_${i}`];
        if (Array.isArray(chunk)) allResults.push(...chunk);
      }
      if (Array.isArray(resultsBuffer) && resultsBuffer.length > 0) allResults.push(...resultsBuffer);
      else if (Array.isArray(data.resultsBuffer) && data.resultsBuffer.length > 0) allResults.push(...data.resultsBuffer);
      sendResponse({ results: allResults });
    });
    return true;
  }
  if (message.action === 'heartbeat_ping') {
    sendResponse({ status: 'pong' });
    return false;
  }
  return false;
});

// ------------------------------------------------------------- queue engine
async function processQueueInParallel() {
  await setupOffscreenDocument();

  const workerCount = Math.min(concurrency, Math.max(1, queue.length - currentIndex));
  sendLog(`[Engine] ${workerCount} parallel workers · queue ${queue.length} URLs · stagger ${delayMs / 1000}s · Tier-2 tab fallback armed.`);

  const workers = [];
  for (let i = 0; i < workerCount; i++) workers.push(runWorker(i));
  await Promise.all(workers);

  if (completedCount >= queue.length && isScraping) {
    isScraping = false;
    await flushBufferToDisk();
    await chrome.storage.local.set({ isScraping: false, isPaused: false, currentIndex, completedCount, selfHealedCount, failedCount });
    chrome.runtime.sendMessage({
      action: 'progress_update',
      processed: completedCount, total: queue.length,
      isComplete: true, selfHealedCount, failedCount
    }).catch(() => {});
    sendLog(`[Engine] Run complete. ${completedCount - failedCount}/${queue.length} captured, ${failedCount} honest failures (see Failed sheet), ${selfHealedCount} self-healed.`, 'success');
    await closeOffscreenDocument();
  }
}

function getNextTask() {
  if (currentIndex < queue.length) {
    const task = queue[currentIndex];
    const index = currentIndex;
    currentIndex++;
    return { task, index };
  }
  return null;
}

async function runWorker(workerId) {
  while (isScraping && !isPaused) {
    const item = getNextTask();
    if (!item) break;
    await processTask(item.task, item.index, workerId);
    if (currentIndex < queue.length && !isPaused && isScraping) {
      await sleep(delayMs + Math.random() * 500);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendLog(message, type) {
  chrome.runtime.sendMessage({ action: 'log', message, type: type || 'info' }).catch(() => {});
}

function sendProgress() {
  // isComplete is driven by completedCount so a slow Tier-2 rescue on an
  // earlier index can never be skipped by a fast finish on the last index.
  if (completedCount % 5 === 0 || completedCount >= queue.length || completedCount === 1) {
    chrome.runtime.sendMessage({
      action: 'progress_update',
      processed: completedCount, total: queue.length,
      isComplete: completedCount >= queue.length,
      selfHealedCount, failedCount
    }).catch(() => {});
  }
}

function isUsable(rec) {
  return rec && (rec.status === 'ok' || rec.status === 'partial');
}

async function processTask(task, index, workerId) {
  const url = task.url;
  let record = null;

  // ---------- Tier 1: offscreen fetch, with retry + backoff ----------
  for (let attempt = 0; attempt < 2 && isScraping && !isPaused; attempt++) {
    try {
      offscreenPagesParsedCount++;
      if (offscreenPagesParsedCount >= OFFSCREEN_RECREATION_INTERVAL) {
        offscreenPagesParsedCount = 0;
        await recycleOffscreenDocument();
      }
      record = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'scrape_url', url });
    } catch (e) {
      await recycleOffscreenDocument();
      record = { url, status: 'failed', failReason: 'Offscreen worker error: ' + e.message };
    }
    if (record && record.status === 'ok') break;
    if (record && record.status === 'blocked') break; // re-fetching a bot wall is pointless — go to Tier 2
    if (attempt === 0) await sleep(1200 + Math.random() * 800);
  }

  // ---------- Tier 2: live tab render for blocked / JS-rendered pages ----------
  if (!record || record.status !== 'ok') {
    const reason = record ? (record.failReason || record.status) : 'no response';
    sendLog(`[W${workerId}] Tier-1 incomplete for #${index + 1} (${reason}). Escalating to live-tab render…`, 'warning');
    const tabRecord = await scrapeViaTab(url);
    if (tabRecord && tabRecord.status === 'ok') {
      tabRecord.rescuedByTabRender = true;
      if (!tabRecord.corrections_made) tabRecord.corrections_made = [];
      tabRecord.corrections_made.push('Recovered via live-tab render after fetch-mode failure');
      record = tabRecord;
    } else if (tabRecord && isUsable(tabRecord) && isUsable(record)) {
      const score = r => ['title', 'price', 'mrp', 'rating', 'reviewCount', 'brand'].filter(k => r[k]).length;
      if (score(tabRecord) > score(record)) {
        tabRecord.rescuedByTabRender = true;
        record = tabRecord;
      }
    } else if (!isUsable(record) && tabRecord) {
      record = tabRecord; // carry the more informative result, even if partial/failed
      if (isUsable(tabRecord)) record.rescuedByTabRender = true;
    }
  }

  if (!record) {
    record = { url, status: 'failed', failReason: 'All scrape tiers exhausted with no response' };
  }

  // Honest bookkeeping — failures are recorded as failures, never invented.
  await addResultToBuffer(record);
  completedCount++;

  if (index === 0 || (index + 1) % 10 === 0 || (index + 1) === queue.length || !isUsable(record)) {
    if (isUsable(record)) {
      sendLog(`[W${workerId}] ✅ ${index + 1}/${queue.length} · ${record.brand || '?'} · ${record.currency || ''} ${record.price || 'n/a'} · ${record.status}`, 'success');
    } else {
      sendLog(`[W${workerId}] ❌ ${index + 1}/${queue.length} failed: ${record.failReason}`, 'error');
    }
  }
  sendProgress();
}

// ----------------------------------------------------- Tier 2: tab renderer
async function scrapeViaTab(url) {
  while (activeTabSlots >= TAB_MODE_MAX_CONCURRENT) await sleep(400);
  activeTabSlots++;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, TAB_LOAD_TIMEOUT_MS);
    await sleep(TAB_SETTLE_MS); // allow client-side price hydration

    await chrome.scripting.executeScript({ target: { tabId }, files: ['extractor.js'] });
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          return self.ApexExtractor.extract(document, document.documentElement.outerHTML, location.href);
        } catch (e) {
          return { url: location.href, status: 'failed', failReason: 'In-page extraction error: ' + e.message };
        }
      }
    });

    const result = injection && injection[0] ? injection[0].result : null;
    return result || { url, status: 'failed', failReason: 'Tab injection returned no result' };
  } catch (e) {
    return { url, status: 'failed', failReason: 'Tab render error: ' + e.message };
  } finally {
    if (tabId !== null) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
    activeTabSlots--;
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

// Open dashboard in full tab
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'popup.html' });
});
