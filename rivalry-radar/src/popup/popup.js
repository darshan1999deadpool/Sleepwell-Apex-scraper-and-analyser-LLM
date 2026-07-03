/*
 * Rivalry Radar — popup controller.
 * READ-ONLY tool: this UI only sends control messages to the worker and renders
 * status. It never touches Amazon/Flipkart pages or any ad element.
 *
 * Loads after constants.js + storage.js, so RR.MSG etc. are available.
 */
(function () {
  'use strict';

  const RR = self.RR;

  // ---- element refs ----
  const el = {
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    nowMarket: document.getElementById('nowMarket'),
    nowKeyword: document.getElementById('nowKeyword'),
    scanCount: document.getElementById('scanCount'),
    lastScan: document.getElementById('lastScan'),
    countdown: document.getElementById('countdown'),
    compAmazon: document.getElementById('compAmazon'),
    compAmazonMeta: document.getElementById('compAmazonMeta'),
    compFlipkart: document.getElementById('compFlipkart'),
    compFlipkartMeta: document.getElementById('compFlipkartMeta'),
    toggleBtn: document.getElementById('toggleBtn'),
    scanNowBtn: document.getElementById('scanNowBtn'),
    dashBtn: document.getElementById('dashBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    footNote: document.getElementById('footNote'),
  };

  // Latest known state; the 1s timer reads this to update the countdown.
  let lastState = null;
  let busy = false;

  // ---- helpers ----
  function send(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (resp) => {
          // Swallow "no receiver" errors (worker waking up) gracefully.
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function fmtClock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ap = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    return `${h}:${m}:${s} ${ap}`;
  }

  function fmtCountdown(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return 'now';
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function marketLabel(mkt) {
    if (mkt === RR.MARKET.AMAZON) return 'Amazon';
    if (mkt === RR.MARKET.FLIPKART) return 'Flipkart';
    return '—';
  }

  function renderCountdown() {
    if (!lastState || !lastState.running || !lastState.nextScanAt) {
      el.countdown.textContent = '—';
      return;
    }
    el.countdown.textContent = fmtCountdown(lastState.nextScanAt - Date.now());
  }

  function renderCompCard(countEl, metaEl, scan) {
    if (!scan || !scan.counts) {
      countEl.textContent = '—';
      metaEl.textContent = 'no data';
      return;
    }
    countEl.textContent = String(scan.counts.competitor || 0);
    const kw = scan.keyword ? `“${scan.keyword}”` : '';
    metaEl.textContent = `${kw} · ${fmtClock(scan.ts)}`.replace(/^ · /, '');
  }

  function render(resp) {
    const state = (resp && resp.state) || RR.defaultState();
    const lastScans = (resp && resp.lastScans) || { amazon: null, flipkart: null };
    lastState = state;

    // Status pill + toggle button.
    if (state.running) {
      el.statusPill.classList.remove('pill-off');
      el.statusPill.classList.add('pill-on');
      el.statusText.textContent = 'Running';
      el.toggleBtn.textContent = 'Stop';
      el.toggleBtn.classList.add('is-running');
    } else {
      el.statusPill.classList.remove('pill-on');
      el.statusPill.classList.add('pill-off');
      el.statusText.textContent = 'Stopped';
      el.toggleBtn.textContent = 'Start';
      el.toggleBtn.classList.remove('is-running');
    }

    // Current work.
    el.nowMarket.textContent = marketLabel(state.currentMarket);
    el.nowKeyword.textContent = state.currentKeyword || (state.running ? 'queued…' : 'idle');

    // Stats.
    el.scanCount.textContent = String(state.scanCount || 0);
    el.lastScan.textContent = fmtClock(state.lastScanAt);
    renderCountdown();

    // Competitor-ad counts per marketplace.
    renderCompCard(el.compAmazon, el.compAmazonMeta, lastScans.amazon);
    renderCompCard(el.compFlipkart, el.compFlipkartMeta, lastScans.flipkart);

    // Footer note.
    if (state.running) {
      el.footNote.textContent = 'Scanning on a timer — reading sponsored placements only.';
    } else {
      el.footNote.textContent = 'Idle — press Start to begin scanning.';
    }
  }

  // Keep last competitor cards across messages that return only state.
  let lastScansCache = { amazon: null, flipkart: null };

  async function refresh() {
    const resp = await send(RR.MSG.GET_STATUS);
    if (resp && resp.lastScans) lastScansCache = resp.lastScans;
    render(resp);
  }

  function setBusy(b) {
    busy = b;
    el.toggleBtn.disabled = b;
    el.scanNowBtn.disabled = b;
  }

  // ---- button handlers ----
  async function onToggle() {
    if (busy) return;
    setBusy(true);
    const running = lastState && lastState.running;
    const resp = await send(running ? RR.MSG.STOP : RR.MSG.START);
    // START/STOP return only {ok, state}; reuse cached competitor cards.
    if (resp && resp.state) render({ state: resp.state, lastScans: lastScansCache });
    await refresh();
    setBusy(false);
  }

  async function onScanNow() {
    if (busy) return;
    setBusy(true);
    el.footNote.textContent = 'Triggering a scan…';
    await send(RR.MSG.SCAN_NOW);
    // Worker broadcasts STATE_CHANGED when done; refresh now for snappy feedback.
    await refresh();
    setBusy(false);
  }

  function onOpenDashboard() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    window.close();
  }

  function onOpenSettings() {
    chrome.runtime.openOptionsPage();
    window.close();
  }

  // ---- wiring (no inline handlers) ----
  el.toggleBtn.addEventListener('click', onToggle);
  el.scanNowBtn.addEventListener('click', onScanNow);
  el.dashBtn.addEventListener('click', onOpenDashboard);
  el.settingsBtn.addEventListener('click', onOpenSettings);

  // Worker broadcasts on every state change; re-read storage-derived status.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === RR.MSG.STATE_CHANGED) {
      refresh();
    }
  });

  // Live countdown tick (independent of message traffic).
  setInterval(renderCountdown, 1000);

  // Initial paint.
  refresh();
})();
