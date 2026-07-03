/*
 * Rivalry Radar — background service worker (THE ORCHESTRATOR).
 *
 * Drives the all-day, READ-ONLY scan loop. On a timer it cycles through the
 * (enabled-marketplace x keyword) work queue, points a pinned scanner tab at a
 * SEARCH-results page, waits for load, asks the content script to read the DOM,
 * classifies each placement's brand, tallies counts, and stores a Scan record.
 *
 * ============================ SAFETY INVARIANT ============================
 * STRICTLY READ-ONLY. This worker NEVER clicks, taps, focuses-to-activate,
 * submits, window.opens, navigates to, or dispatches synthetic events on any
 * ad, sponsored card, product link, or button. The ONLY navigation it performs
 * is setting a scanner tab's URL to a marketplace SEARCH page. Product URLs are
 * captured as strings only and are never opened. No IP/VPN rotation, no
 * bot-evasion — and none may ever be added.
 * =========================================================================
 *
 * Plain module. Spine libs are loaded first via importScripts and attach to
 * the global self.RR — we only ever read/call RR.*; we never redefine it.
 */
importScripts('../lib/constants.js', '../lib/storage.js', '../lib/match.js');

(function () {
  'use strict';

  const ALARM = 'rr_cycle';
  const REVIEW_ALARM = 'rr_reviews';
  const TAB_LOAD_TIMEOUT_MS = 15000; // fallback if 'complete' never fires
  const SETTLE_MS = 1200; // let lazy content settle after load
  const REVIEW_SETTLE_MS = 1500; // reviews pages need a touch more settle
  const SCRAPE_RETRIES = 3;
  const SCRAPE_GAP_MS = 700;

  // Guard so two cycles (alarm + SCAN_NOW) can't interleave and thrash tabs.
  let cycleBusy = false;
  // Independent guard for the review-harvest loop (alarm + REVIEWS_NOW).
  let reviewBusy = false;

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cadenceMinutes(cfg) {
    // chrome.alarms enforces a 30s floor; mirror that with 0.5 min.
    return Math.max(0.5, (Number(cfg.cadenceSec) || RR.DEFAULTS.cadenceSec) / 60);
  }

  function reviewCadenceMinutes(cfg) {
    // Never harvest more often than the configured floor (politeness).
    return Math.max(
      RR.LIMITS.MIN_REVIEW_CADENCE_MIN,
      Number(cfg.reviewCadenceMin) || RR.DEFAULTS.reviewCadenceMin
    );
  }

  // Build the (keyword x enabled-marketplace) work queue, INTERLEAVED by keyword
  // so platforms alternate (kw1·amazon, kw1·flipkart, kw2·amazon, ...) — ensures
  // BOTH marketplaces get scanned promptly instead of all of one platform first.
  function buildQueue(config) {
    const q = [];
    for (const keyword of config.keywords) {
      for (const market of RR.MARKETS) {
        if (config.marketplaces[market]) q.push({ market, keyword });
      }
    }
    return q;
  }

  // Tiny deterministic string hash (FNV-1a, 32-bit) -> short base36 string.
  // Used only to build a STABLE per-review dedup id. No randomness/time.
  function stableHash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  async function safeLog(line, level) {
    try {
      await RR.storage.log(line, level);
    } catch (e) {
      /* never let logging kill the loop */
    }
  }

  function broadcastStateChanged() {
    try {
      // No UI listener is fine; swallow the resulting rejection.
      const p = chrome.runtime.sendMessage({ type: RR.MSG.STATE_CHANGED });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  async function getTab(tabId) {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch (e) {
      return null; // tab was closed
    }
  }

  // Ensure a pinned, background scanner tab exists for a marketplace. Returns the
  // tabId. Navigation happens per-page in scrapeSearchPages() — SEARCH pages only,
  // never a product/ad URL.
  async function ensureScannerTab(market) {
    const state = await RR.storage.getState();
    const tabs = Object.assign({ amazon: null, flipkart: null }, state.scannerTabs);
    let tabId = tabs[market];
    const existing = await getTab(tabId);
    if (!existing) {
      const created = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
      tabId = created.id;
      tabs[market] = tabId;
      await RR.storage.setState({ scannerTabs: tabs });
    }
    return tabId;
  }

  // Ensure a DEDICATED, pinned, background review-scanner tab exists for a
  // marketplace (separate from the SoV scannerTabs). Returns the tabId. We do
  // NOT navigate it here — the caller points it at canonical RR.REVIEWS_URL.*
  // pages only (never an ad/product link).
  async function ensureReviewTab(market) {
    const state = await RR.storage.getState();
    const tabs = Object.assign({ amazon: null, flipkart: null }, state.reviewTabs);

    let tabId = tabs[market];
    let existing = await getTab(tabId);

    if (!existing) {
      const created = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
      tabId = created.id;
      tabs[market] = tabId;
      await RR.storage.setState({ reviewTabs: tabs });
    }
    return tabId;
  }

  // Resolve once the given tab reaches status 'complete' (or on timeout).
  function waitTabComplete(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch (e) {
          /* ignore */
        }
        clearTimeout(timer);
        resolve(reason);
      };
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === 'complete') finish('complete');
      };
      const timer = setTimeout(() => finish('timeout'), TAB_LOAD_TIMEOUT_MS);
      try {
        chrome.tabs.onUpdated.addListener(onUpdated);
      } catch (e) {
        finish('error');
        return;
      }
      // If it's already complete (fast cache hit) we'd otherwise wait for the
      // timeout — probe current status once.
      getTab(tabId).then((t) => {
        if (t && t.status === 'complete') finish('already');
      });
    });
  }

  // Ask the content script to read the DOM. Retries a few times because the
  // content script may not be injected yet right after a navigation.
  async function sendScrape(tabId, keyword, market) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SCRAPE_RETRIES; attempt++) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, {
          type: RR.MSG.SCRAPE,
          keyword,
          marketplace: market,
        });
        if (resp && resp.ok) return resp;
        lastErr = new Error('scrape responded not-ok');
      } catch (e) {
        lastErr = e;
      }
      if (attempt < SCRAPE_RETRIES) await sleep(SCRAPE_GAP_MS);
    }
    throw lastErr || new Error('scrape failed');
  }

  // Ask the reviews content script to read a product's negative reviews. Retried
  // because the content script may not be injected yet right after navigation.
  async function sendScrapeReviews(tabId, market, itemId, brand, keyword, max) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SCRAPE_RETRIES; attempt++) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, {
          type: RR.MSG.SCRAPE_REVIEWS,
          marketplace: market,
          itemId,
          brand,
          keyword,
          max,
        });
        if (resp && resp.ok) return resp;
        lastErr = new Error('scrape-reviews responded not-ok');
      } catch (e) {
        lastErr = e;
      }
      if (attempt < SCRAPE_RETRIES) await sleep(SCRAPE_GAP_MS);
    }
    throw lastErr || new Error('scrape-reviews failed');
  }

  // Navigate the scanner tab through pages 1..N of a keyword's SEARCH results,
  // scraping each, and return the merged raw placements + the page-1 URL. Only
  // SEARCH pages are loaded here (never a product/ad link).
  async function scrapeSearchPages(tabId, market, keyword, pages) {
    const merged = [];
    let firstUrl = RR.SEARCH_URL[market](keyword, 1);
    for (let p = 1; p <= pages; p++) {
      const url = RR.SEARCH_URL[market](keyword, p);
      try {
        await chrome.tabs.update(tabId, { url });
        try { await waitTabComplete(tabId); } catch (e) { /* proceed to scrape */ }
        await sleep(SETTLE_MS);
        const resp = await sendScrape(tabId, keyword, market);
        if (p === 1 && resp && resp.url) firstUrl = resp.url;
        const arr = resp && Array.isArray(resp.placements) ? resp.placements : [];
        merged.push(...arr);
        if (arr.length === 0) break; // no more results (e.g. page 2 doesn't exist)
      } catch (e) {
        if (p === 1) throw e; // page 1 failing = cycle failure
        await safeLog(`page ${p} scrape skipped for ${market} "${keyword}": ${e && e.message}`, 'warn');
        break; // a later page failing: keep what we already have
      }
    }
    return { placements: merged, url: firstUrl };
  }

  // ---------------------------------------------------------------- the cycle
  async function runCycle() {
    if (cycleBusy) return;
    cycleBusy = true;
    try {
      const config = await RR.storage.getConfig();
      let state = await RR.storage.getState();

      // Build work queue, interleaved by keyword so both marketplaces alternate.
      const queue = buildQueue(config);
      if (queue.length === 0) {
        await safeLog('cycle skipped: no enabled marketplaces or no keywords', 'warn');
        return;
      }

      // Pick round-robin item, advance + persist cursor immediately so a crash
      // mid-cycle still moves us forward next time.
      const cursor = ((Number(state.cursor) || 0) % queue.length + queue.length) % queue.length;
      const item = queue[cursor];
      const nextCursor = (cursor + 1) % queue.length;
      state = await RR.storage.setState({ cursor: nextCursor });

      const { market, keyword } = item;
      const pages = config.pagesPerKeyword || 1;

      // 1) Ensure scanner tab (per-page navigation happens in scrapeSearchPages).
      let tabId;
      try {
        tabId = await ensureScannerTab(market);
      } catch (e) {
        await safeLog(`could not open ${market} scanner tab: ${e && e.message}`, 'err');
        await RR.storage.setState({ errorCount: (state.errorCount || 0) + 1 });
        broadcastStateChanged();
        return;
      }

      // 2) Scrape the first `pages` search-result pages and merge them.
      let scrape;
      try {
        scrape = await scrapeSearchPages(tabId, market, keyword, pages);
      } catch (e) {
        await safeLog(`scrape failed for ${market} "${keyword}": ${e && e.message}`, 'warn');
        state = await RR.storage.setState({ errorCount: (state.errorCount || 0) + 1 });
        broadcastStateChanged();
        return; // abort this cycle gracefully; loop continues next tick
      }

      const rawPlacements = Array.isArray(scrape.placements) ? scrape.placements : [];
      const scanUrl = scrape.url || RR.SEARCH_URL[market](keyword, 1);

      // 4) Classify each placement + tally counts. Re-number rank/adRank
      //    continuously across the merged pages so positions stay accurate.
      const counts = RR.emptyCounts();
      let adRankCounter = 0;
      const placements = rawPlacements.map((p, i) => {
        const brandText = p && p.brand && String(p.brand).length ? p.brand : (p && p.title) || '';
        const classification = RR.match.classify(brandText, config);
        const sponsored = !!(p && p.sponsored);
        const rank = i + 1;
        const adRank = sponsored ? ++adRankCounter : null;

        counts.total += 1;
        if (sponsored) {
          counts.sponsored += 1;
          // mine/competitor/excluded count SPONSORED placements (ad share-of-voice).
          if (classification === RR.CLASS.MINE) counts.mine += 1;
          else if (classification === RR.CLASS.EXCLUDED) counts.excluded += 1;
          else counts.competitor += 1;
        }

        return Object.assign({}, p, { rank, adRank, sponsored, classification });
      });

      // 5) Build the Scan record EXACTLY per the constants.js contract.
      const ts = Date.now();
      const scan = {
        id: `${ts}|${market}|${keyword}`,
        ts,
        iso: new Date(ts).toISOString(),
        marketplace: market,
        keyword,
        url: scanUrl,
        counts,
        placements,
      };

      try {
        await RR.storage.addScan(scan);
      } catch (e) {
        await safeLog(`failed to store scan for ${market} "${keyword}": ${e && e.message}`, 'err');
        broadcastStateChanged();
        return;
      }

      await safeLog(
        `scanned ${market} "${keyword}" (${pages}p): ${counts.total} results, ${counts.sponsored} ads, ${counts.competitor} competitor`
      );

      // 6) Update state.
      const cadenceMs = config.cadenceSec * 1000;
      await RR.storage.setState({
        lastScanAt: ts,
        nextScanAt: ts + cadenceMs,
        scanCount: (state.scanCount || 0) + 1,
        currentKeyword: keyword,
        currentMarket: market,
      });

      broadcastStateChanged();
    } catch (e) {
      // Absolute backstop: one bad cycle must never kill the loop.
      await safeLog(`cycle error: ${e && e.message ? e.message : e}`, 'err');
      try {
        const s = await RR.storage.getState();
        await RR.storage.setState({ errorCount: (s.errorCount || 0) + 1 });
      } catch (e2) {
        /* ignore */
      }
      broadcastStateChanged();
    } finally {
      cycleBusy = false;
    }
  }

  // ------------------------------------------------------- the review cycle
  // Harvest COMPETITOR negative reviews for the next (market,keyword) item.
  //
  // SAFETY: the review tab is navigated ONLY to RR.REVIEWS_URL.* (a product's
  // canonical reviews page, built from ASIN/pid). There is NO code path here
  // that clicks an ad / product link or opens p.url directly. Only competitor
  // products (classification === 'competitor') with an itemId are harvested —
  // 'mine' and 'excluded' products are never touched.
  async function runReviewCycle() {
    if (reviewBusy) return;
    reviewBusy = true;
    let totalAdded = 0;
    try {
      const config = await RR.storage.getConfig();
      if (!config.reviewsEnabled) return;
      let state = await RR.storage.getState();

      // Build the SAME interleaved work queue as runCycle.
      const queue = buildQueue(config);
      if (queue.length === 0) {
        await safeLog('review cycle skipped: no enabled marketplaces or no keywords', 'warn');
        return;
      }

      // Pick round-robin item, advance + persist cursor immediately.
      const cursor =
        ((Number(state.reviewCursor) || 0) % queue.length + queue.length) % queue.length;
      const item = queue[cursor];
      const nextCursor = (cursor + 1) % queue.length;
      state = await RR.storage.setState({ reviewCursor: nextCursor });

      const { market, keyword } = item;

      // Learn the competitors for this (market,keyword) from the latest SoV scan.
      const latest = await RR.storage.latestScanFor(market, keyword);
      if (!latest) {
        await safeLog(`no SoV scan yet for ${market} '${keyword}' — skipping reviews`, 'warn');
        return;
      }

      const placements = Array.isArray(latest.placements) ? latest.placements : [];
      const competitors = placements
        .filter((p) => p && p.classification === RR.CLASS.COMPETITOR && p.itemId)
        .slice(0, config.productsPerReviewCycle);

      if (competitors.length === 0) {
        await safeLog(`no competitor products to harvest for ${market} '${keyword}'`, 'info');
      }

      // Dedicated review tab for this marketplace (separate from scannerTabs).
      let reviewTab;
      try {
        reviewTab = await ensureReviewTab(market);
      } catch (e) {
        await safeLog(`could not open ${market} review tab: ${e && e.message}`, 'err');
        state = await RR.storage.setState({ reviewErrorCount: (state.reviewErrorCount || 0) + 1 });
        broadcastStateChanged();
        return;
      }

      for (let index = 0; index < competitors.length; index++) {
        const p = competitors[index];
        try {
          // Build the CANONICAL reviews URL — NOT an ad click, bills no one.
          const url =
            market === RR.MARKET.AMAZON
              ? RR.REVIEWS_URL.amazon(p.itemId)
              : RR.REVIEWS_URL.flipkart(p.url, p.itemId);
          if (!url) {
            await safeLog(`no reviews URL for ${market} ${p.brand || ''} (${p.itemId}) — skipping`, 'warn');
            continue;
          }

          await chrome.tabs.update(reviewTab, { url });
          try {
            await waitTabComplete(reviewTab);
          } catch (e) {
            /* timeout already resolved — proceed to scrape */
          }
          await sleep(REVIEW_SETTLE_MS);

          let resp;
          try {
            resp = await sendScrapeReviews(
              reviewTab,
              market,
              p.itemId,
              p.brand,
              keyword,
              config.reviewsPerProduct
            );
          } catch (e) {
            await safeLog(
              `reviews scrape failed ${market} ${p.brand || ''} (${p.itemId}): ${e && e.message}`,
              'warn'
            );
            state = await RR.storage.setState({
              reviewErrorCount: (state.reviewErrorCount || 0) + 1,
            });
            continue; // one bad product must not abort the whole cycle
          }

          const rawReviews = Array.isArray(resp.reviews) ? resp.reviews : [];
          const ts = Date.now();
          const iso = new Date(ts).toISOString();
          const records = [];
          for (const r of rawReviews) {
            if (!r) continue;
            const rating = Number(r.rating);
            // Keep ONLY negative reviews.
            if (!(rating <= RR.NEG_STARS)) continue;
            const hash = stableHash(
              `${r.reviewText || ''}|${r.author || ''}|${r.reviewDate || ''}`
            );
            records.push({
              id: `${market}|${p.itemId}|${hash}`,
              ts,
              iso,
              marketplace: market,
              keyword,
              brand: p.brand || '',
              classification: RR.CLASS.COMPETITOR,
              itemId: p.itemId,
              productTitle: p.title || '',
              productUrl: p.url || '',
              wasSponsored: !!p.sponsored,
              rating,
              reviewTitle: r.reviewTitle || '',
              reviewText: r.reviewText || '',
              reviewDate: r.reviewDate || '',
              author: r.author || '',
              helpful: r.helpful == null ? null : Number(r.helpful),
            });
          }

          let added = 0;
          try {
            added = await RR.storage.addReviews(records);
          } catch (e) {
            await safeLog(`failed to store reviews for ${market} (${p.itemId}): ${e && e.message}`, 'err');
          }
          totalAdded += added;

          const titleTrunc = String(p.title || '').slice(0, 60);
          await safeLog(
            `reviews ${market} ${p.brand || ''}: +${added} negative (${rawReviews.length} seen) — ${titleTrunc}`
          );

          // GENTLE, human-ish delay between products (politeness, NOT evasion).
          if (index < competitors.length - 1) {
            await sleep(4000 + (index % 4) * 1200);
          }
        } catch (e) {
          // Per-product backstop: never let one product kill the cycle.
          await safeLog(`review product error ${market} (${p && p.itemId}): ${e && e.message}`, 'err');
          try {
            const s = await RR.storage.getState();
            await RR.storage.setState({ reviewErrorCount: (s.reviewErrorCount || 0) + 1 });
          } catch (e2) {
            /* ignore */
          }
        }
      }

      // Update review state.
      const now = Date.now();
      const cadenceMs = reviewCadenceMinutes(config) * 60000;
      const cur = await RR.storage.getState();
      await RR.storage.setState({
        lastReviewAt: now,
        nextReviewAt: now + cadenceMs,
        reviewCount: (cur.reviewCount || 0) + totalAdded,
        reviewCursor: cur.reviewCursor, // already advanced + persisted above
      });

      broadcastStateChanged();
    } catch (e) {
      // Absolute backstop: one bad review cycle must never kill either loop.
      await safeLog(`review cycle error: ${e && e.message ? e.message : e}`, 'err');
      try {
        const s = await RR.storage.getState();
        await RR.storage.setState({ reviewErrorCount: (s.reviewErrorCount || 0) + 1 });
      } catch (e2) {
        /* ignore */
      }
      broadcastStateChanged();
    } finally {
      reviewBusy = false;
    }
  }

  // ---------------------------------------------------------------- lifecycle
  async function startLoop() {
    const cfg = await RR.storage.getConfig();
    const ts = Date.now();
    await RR.storage.setState({
      running: true,
      startedAt: ts,
      nextScanAt: ts + cfg.cadenceSec * 1000,
    });
    try {
      await chrome.alarms.clear(ALARM);
    } catch (e) {
      /* ignore */
    }
    try {
      await chrome.alarms.create(ALARM, { periodInMinutes: cadenceMinutes(cfg) });
    } catch (e) {
      await safeLog(`failed to create cycle alarm: ${e && e.message}`, 'err');
    }

    // Independent review-harvest alarm: first harvest ~1 min after Start, then
    // every reviewCadenceMin (floored). Only when reviews are enabled.
    try {
      await chrome.alarms.clear(REVIEW_ALARM);
    } catch (e) {
      /* ignore */
    }
    if (cfg.reviewsEnabled) {
      try {
        await chrome.alarms.create(REVIEW_ALARM, {
          delayInMinutes: 1,
          periodInMinutes: reviewCadenceMinutes(cfg),
        });
        await RR.storage.setState({ nextReviewAt: ts + reviewCadenceMinutes(cfg) * 60000 });
      } catch (e) {
        await safeLog(`failed to create review alarm: ${e && e.message}`, 'err');
      }
    }

    await safeLog('scanning started', 'info');
    // Kick one cycle immediately (don't await — keep onMessage responsive).
    runCycle();
  }

  async function stopLoop() {
    await RR.storage.setState({ running: false });
    try {
      await chrome.alarms.clear(ALARM);
    } catch (e) {
      /* ignore */
    }
    try {
      await chrome.alarms.clear(REVIEW_ALARM);
    } catch (e) {
      /* ignore */
    }
    await safeLog('scanning stopped', 'info');
    // Leave scanner/review tabs OPEN so the user keeps seeing them; just stop cycling.
  }

  // Reconcile persisted state with reality at install/startup.
  async function reconcile() {
    try {
      // getConfig auto-fills defaults; calling it ensures config exists.
      const cfg = await RR.storage.getConfig();
      const state = await RR.storage.getState();

      const getAlarm = async (name) => {
        try {
          return await chrome.alarms.get(name);
        } catch (e) {
          return null;
        }
      };
      const alarm = await getAlarm(ALARM);
      const reviewAlarm = await getAlarm(REVIEW_ALARM);

      if (state.running) {
        // We think we're running — make the alarms match reality.
        if (!alarm) {
          try {
            await chrome.alarms.create(ALARM, { periodInMinutes: cadenceMinutes(cfg) });
          } catch (e) {
            /* ignore */
          }
        }
        // Recreate the review alarm only if reviews are enabled; clear a stray
        // one if reviews got disabled while we were asleep.
        if (cfg.reviewsEnabled) {
          if (!reviewAlarm) {
            try {
              await chrome.alarms.create(REVIEW_ALARM, {
                delayInMinutes: 1,
                periodInMinutes: reviewCadenceMinutes(cfg),
              });
            } catch (e) {
              /* ignore */
            }
          }
        } else if (reviewAlarm) {
          try {
            await chrome.alarms.clear(REVIEW_ALARM);
          } catch (e) {
            /* ignore */
          }
        }
        await safeLog('worker awoke; scan loop resumed', 'info');
      } else {
        // Not running — make sure no stray alarms keep firing.
        if (alarm) {
          try {
            await chrome.alarms.clear(ALARM);
          } catch (e) {
            /* ignore */
          }
        }
        if (reviewAlarm) {
          try {
            await chrome.alarms.clear(REVIEW_ALARM);
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (e) {
      await safeLog(`reconcile error: ${e && e.message}`, 'err');
    }
  }

  // ---------------------------------------------------------------- focus tab
  async function focusTab(market) {
    const state = await RR.storage.getState();
    const tabs = state.scannerTabs || {};
    const tabId = tabs[market];
    const tab = await getTab(tabId);
    if (!tab) return false;
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- listeners
  chrome.runtime.onInstalled.addListener(() => {
    reconcile();
  });
  chrome.runtime.onStartup.addListener(() => {
    reconcile();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm) return;
    if (alarm.name !== ALARM && alarm.name !== REVIEW_ALARM) return;
    try {
      const state = await RR.storage.getState();
      if (!state.running) return;
      if (alarm.name === ALARM) runCycle();
      else if (alarm.name === REVIEW_ALARM) runReviewCycle();
    } catch (e) {
      await safeLog(`alarm handler error: ${e && e.message}`, 'err');
    }
  });

  // If a scanner tab is closed, null it out so the next cycle recreates it.
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      const state = await RR.storage.getState();
      const tabs = Object.assign({ amazon: null, flipkart: null }, state.scannerTabs);
      const rTabs = Object.assign({ amazon: null, flipkart: null }, state.reviewTabs);
      let changed = false;
      const patch = {};
      for (const m of RR.MARKETS) {
        if (tabs[m] === tabId) {
          tabs[m] = null;
          patch.scannerTabs = tabs;
          changed = true;
        }
        if (rTabs[m] === tabId) {
          rTabs[m] = null;
          patch.reviewTabs = rTabs;
          changed = true;
        }
      }
      if (changed) await RR.storage.setState(patch);
    } catch (e) {
      /* ignore */
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg && msg.type;

    if (type === RR.MSG.START) {
      (async () => {
        try {
          await startLoop();
          const state = await RR.storage.getState();
          sendResponse({ ok: true, state });
        } catch (e) {
          await safeLog(`START failed: ${e && e.message}`, 'err');
          const state = await RR.storage.getState();
          sendResponse({ ok: false, state });
        }
      })();
      return true;
    }

    if (type === RR.MSG.STOP) {
      (async () => {
        try {
          await stopLoop();
          const state = await RR.storage.getState();
          sendResponse({ ok: true, state });
        } catch (e) {
          await safeLog(`STOP failed: ${e && e.message}`, 'err');
          const state = await RR.storage.getState();
          sendResponse({ ok: false, state });
        }
      })();
      return true;
    }

    if (type === RR.MSG.SCAN_NOW) {
      (async () => {
        // Be honest: if a cycle is already mid-flight, don't pretend we ran one.
        if (cycleBusy) {
          sendResponse({ ok: false, busy: true });
          return;
        }
        try {
          await runCycle();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    if (type === RR.MSG.REVIEWS_NOW) {
      (async () => {
        // Be honest: if a review cycle is already mid-flight, don't run another.
        if (reviewBusy) {
          sendResponse({ ok: false, busy: true });
          return;
        }
        try {
          await runReviewCycle();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    if (type === RR.MSG.GET_STATUS) {
      (async () => {
        try {
          const [state, config, lastScans] = await Promise.all([
            RR.storage.getState(),
            RR.storage.getConfig(),
            RR.storage.latestByMarket(),
          ]);
          sendResponse({ state, config, lastScans });
        } catch (e) {
          sendResponse({
            state: RR.defaultState(),
            config: RR.DEFAULTS,
            lastScans: { amazon: null, flipkart: null },
          });
        }
      })();
      return true;
    }

    if (type === RR.MSG.FOCUS_TAB) {
      (async () => {
        const ok = await focusTab(msg.marketplace);
        sendResponse({ ok });
      })();
      return true;
    }

    // Unknown message — no async response.
    return false;
  });

  // Reconcile on every worker spin-up (MV3 workers are ephemeral; this runs
  // whenever the worker is (re)started outside the install/startup events too).
  reconcile();
})();
