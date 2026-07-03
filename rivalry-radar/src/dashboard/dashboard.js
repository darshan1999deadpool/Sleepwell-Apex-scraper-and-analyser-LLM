/*
 * Rivalry Radar — flagship analytics dashboard (page context).
 * Renders the Live Twin, Analytics and Activity Log entirely from stored data.
 * READ-ONLY: this page never clicks/opens any captured product URL. It only
 * reads RR.storage and sends control messages to the worker.
 */
(function () {
  'use strict';

  const RR = self.RR;

  // ---------------- tiny DOM helpers ----------------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const fmtINR = (n) =>
    n == null ? '' : '₹' + Math.round(n).toLocaleString('en-IN');
  const round1 = (n) => Math.round(n * 10) / 10;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

  function timeAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function clockTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  // ---------------- state ----------------
  const filters = { market: 'all', keyword: 'all', range: 'all', revBrand: 'all' };
  let allScans = [];
  let allReviews = [];
  let lastConfig = RR.DEFAULTS;
  let busy = false;

  // Active SoV mode ('sponsored' | 'organic' | 'overall'). Drives every SoV
  // widget: which placements are in the pool + which position weight is used.
  let sovMode = 'sponsored';

  // Keyword-performance board sort state (persisted in JS vars, re-render on
  // change). key ∈ {you|gap|opportunity|ads|pos|amazon|flipkart|keyword}; dir
  // ∈ {asc|desc}. Default = Your SoV, descending (best-performing first).
  let boardSortKey = 'you';
  let boardSortDir = 'desc';

  // Which brands are plotted on the hourly per-brand SoV trend (lower-cased
  // brand keys). null = "not initialised yet"; loadAndRender seeds a default
  // (your brand + top 5 competitors) once brands are known.
  let trendBrandSel = null;

  // ---------------- SoV-mode helpers ----------------
  // Human labels for the active mode, reused across widget subtitles.
  const MODE_LABEL = { sponsored: 'Sponsored', organic: 'Organic', overall: 'Overall' };
  function modeSlotWord() {
    return sovMode === 'sponsored' ? 'sponsored ad slots'
      : sovMode === 'organic' ? 'organic results'
      : 'all placements';
  }
  // Does a placement belong to the active mode's pool?
  function inMode(p) {
    if (sovMode === 'sponsored') return !!p.sponsored;
    if (sovMode === 'organic') return !p.sponsored;
    return true; // overall
  }
  // Position weight for the active mode. Sponsored uses 1/adRank (ad slot
  // strength); organic + overall use 1/rank (page position strength).
  function modeWeight(p) {
    if (sovMode === 'sponsored') {
      if (p.adRank != null && p.adRank > 0) return 1 / p.adRank;
      return 1 / (p.rank || 10);
    }
    return 1 / (p.rank || 10);
  }
  // Average-position accessor for the active mode (adRank for sponsored, else rank).
  function modePos(p) {
    if (sovMode === 'sponsored') return p.adRank != null ? p.adRank : null;
    return p.rank != null ? p.rank : null;
  }
  // Collect the active-mode, non-excluded placements over a set of scans.
  function modePlacements(scans) {
    const out = [];
    for (const s of scans) {
      for (const p of (s.placements || [])) {
        if (inMode(p) && brandClass(p) !== RR.CLASS.EXCLUDED) out.push(p);
      }
    }
    return out;
  }

  // Human "in X" label for a future timestamp (used by the review chip).
  function untilLabel(ts) {
    const s = Math.floor((ts - Date.now()) / 1000);
    if (s <= 0) return 'due';
    if (s < 60) return 'in ' + s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return 'in ' + m + 'm';
    return 'in ' + Math.floor(m / 60) + 'h';
  }

  // ---------------- worker messaging ----------------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow "no receiver"
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------------- filtering ----------------
  function rangeStart() {
    const now = Date.now();
    if (filters.range === 'hour') return now - 3600 * 1000;
    if (filters.range === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    return 0;
  }
  function filteredScans() {
    const from = rangeStart();
    return allScans.filter((s) => {
      if (s.ts < from) return false;
      if (filters.market !== 'all' && s.marketplace !== filters.market) return false;
      if (filters.keyword !== 'all' && s.keyword !== filters.keyword) return false;
      return true;
    });
  }
  // Marketplace + range only (ignores the single-keyword filter). Used by the
  // inherently multi-keyword widgets (SoV matrix, per-keyword competition).
  function scopedScans() {
    const from = rangeStart();
    return allScans.filter((s) => {
      if (s.ts < from) return false;
      if (filters.market !== 'all' && s.marketplace !== filters.market) return false;
      return true;
    });
  }

  // ---------------- header / status ----------------
  function setStatus(running) {
    const pill = $('status-pill');
    pill.dataset.running = String(!!running);
    $('status-text').textContent = running ? 'Running' : 'Stopped';
    const t = $('btn-toggle');
    t.textContent = running ? 'Stop' : 'Start';
    t.dataset.running = String(!!running);
  }

  // ---------------- search-terms chips control ----------------
  // SOURCE OF TRUTH = config.keywords (NOT the set of already-scanned keywords).
  // The chips both MANAGE config.keywords (add/remove + persist + nudge scan) AND
  // drive the existing single-keyword view filter (filters.keyword, sentinel 'all').

  // Forgiving split — same rule the options page uses: newline / comma / semicolon.
  function splitTerms(raw) {
    return String(raw || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Current configured keywords (from the last loaded config), normalized.
  function configKeywords() {
    return ((lastConfig && lastConfig.keywords) || []).map((s) => String(s).trim()).filter(Boolean);
  }

  // Persist a new keywords array to config, refresh local copy, re-render chips.
  async function saveKeywords(keywords) {
    // de-dupe case-insensitively while preserving first-seen casing/order
    const seen = new Set();
    const out = [];
    for (const k of keywords) {
      const t = String(k).trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    lastConfig = await RR.storage.saveConfig({ keywords: out });
    renderKeywordChips();
  }

  // Nudge a fresh scan on every enabled marketplace (swallow lastError).
  function nudgeScan() {
    try {
      chrome.runtime.sendMessage({ type: RR.MSG.SCAN_NOW }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* not in extension context */ }
  }

  // Briefly show a hint in the keyword note line, then restore the default.
  let kwNoteTimer = null;
  function flashNote(msg) {
    const note = $('kw-note');
    if (!note) return;
    note.textContent = msg;
    note.classList.add('warn');
    if (kwNoteTimer) clearTimeout(kwNoteTimer);
    kwNoteTimer = setTimeout(() => { renderKeywordChips(); }, 1800);
  }

  // Parse the input's text, append any NEW (case-insensitive) terms to
  // config.keywords, persist, clear the input, re-render, then nudge a scan.
  async function commitInput() {
    const input = $('kw-input');
    if (!input) return;
    const terms = splitTerms(input.value);
    input.value = '';
    if (!terms.length) return;
    const existing = configKeywords();
    const have = new Set(existing.map((k) => k.toLowerCase()));
    const additions = [];
    for (const t of terms) {
      const key = t.toLowerCase();
      if (have.has(key)) continue;
      have.add(key);
      additions.push(t);
    }
    if (!additions.length) { renderKeywordChips(); flashNote('Already in your list.'); return; }
    await saveKeywords(existing.concat(additions));
    nudgeScan();
  }

  // ---------------- toast ----------------
  function toast(msg, warn) {
    const wrap = $('toast-wrap');
    if (!wrap) return;
    const t = el('div', 'rr-toast' + (warn ? ' warn' : ''), msg);
    wrap.appendChild(t);
    // force reflow so the transition runs, then show
    void t.offsetWidth;
    t.classList.add('show');
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, 2600);
  }

  // ---------------- keyword sheet upload ----------------
  const KW_HEADER_CELLS = new Set(['keyword', 'keywords', 'search term', 'search terms']);
  const MAX_KEYWORDS = 100000; // accept up to 1 lakh keywords (effectively uncapped)
  const CHIP_RENDER_LIMIT = 500; // render at most this many chips (DOM perf) — ALL are stored + scanned

  // Parse a CSV/TSV/TXT sheet into a flat list of candidate keywords: split on
  // newlines, then each row on comma/tab/semicolon; every non-empty trimmed cell
  // is a keyword. An obvious header cell is skipped. Order preserved.
  function parseKeywordSheet(text) {
    const out = [];
    const rows = String(text || '').split(/\r\n|\r|\n/);
    rows.forEach((line) => {
      if (!line) return;
      line.split(/[,\t;]/).forEach((cell) => {
        const t = cell.trim().replace(/^["']|["']$/g, '').trim();
        if (!t) return;
        if (KW_HEADER_CELLS.has(t.toLowerCase())) return; // skip header labels
        out.push(t);
      });
    });
    return out;
  }

  // Handle a chosen file: read as text, parse, dedupe (case-insensitive) against
  // existing config.keywords, append (cap MAX_KEYWORDS), persist, re-render, and
  // nudge one scan. .xlsx -> friendly note (never parse binary).
  function handleKeywordFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      toast('Excel files aren’t supported — export the sheet as CSV and upload that.', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const parsed = parseKeywordSheet(reader.result);
      if (!parsed.length) { toast('No keywords found in that file.', true); return; }

      const existing = configKeywords();
      const have = new Set(existing.map((k) => k.toLowerCase()));
      const additions = [];
      for (const t of parsed) {
        const key = t.toLowerCase();
        if (have.has(key)) continue;
        have.add(key);
        additions.push(t);
      }
      if (!additions.length) { toast('All keywords in that file are already in your list.', true); return; }

      let next = existing.concat(additions);
      let truncated = false;
      if (next.length > MAX_KEYWORDS) { next = next.slice(0, MAX_KEYWORDS); truncated = true; }
      const addedCount = Math.max(0, next.length - existing.length);

      await saveKeywords(next);
      nudgeScan();
      let msg = 'Added ' + addedCount + ' keyword' + (addedCount === 1 ? '' : 's');
      if (truncated) msg += ' (capped at ' + MAX_KEYWORDS + ')';
      toast(msg, truncated);
    };
    reader.onerror = () => toast('Could not read that file.', true);
    reader.readAsText(file);
  }

  // Remove one keyword (case-insensitive) from config.keywords + persist.
  async function removeKeyword(term) {
    const key = String(term).toLowerCase();
    const next = configKeywords().filter((k) => k.toLowerCase() !== key);
    // if the active view-filter pointed at the removed term, reset to "all"
    if (filters.keyword !== 'all' && filters.keyword.toLowerCase() === key) {
      filters.keyword = 'all';
    }
    await saveKeywords(next);
    rerenderFiltered();
  }

  // Re-run every widget that reads filters.keyword (same path the old <select>
  // change handler used). Kept in one place so chip clicks + removals reuse it.
  function rerenderFiltered() {
    renderAnalytics(filteredScans());
    renderCompete();
    renderReviews();
  }

  // Set the active view filter (chip body click) using the EXISTING sentinel:
  // '' is normalized to 'all' so the existing widgets keep working unchanged.
  function setKeywordFilter(value) {
    filters.keyword = value || 'all';
    renderKeywordChips();
    rerenderFiltered();
  }

  // Render the "All" chip + one chip per configured keyword. The active filter
  // chip is highlighted teal. Clicking a chip body filters; clicking × removes.
  function renderKeywordChips() {
    const host = $('kw-chips');
    if (!host) return;
    clear(host);
    const kws = configKeywords();

    // "All" chip — clears the view filter (sentinel 'all').
    const allChip = el('div', 'rr-kw-chip all' + (filters.keyword === 'all' ? ' active' : ''));
    allChip.setAttribute('role', 'button');
    allChip.setAttribute('tabindex', '0');
    allChip.appendChild(el('span', 'rr-kw-chip-label', 'All'));
    const activateAll = () => setKeywordFilter('all');
    allChip.addEventListener('click', activateAll);
    allChip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateAll(); }
    });
    host.appendChild(allChip);

    const shown = kws.slice(0, CHIP_RENDER_LIMIT);
    shown.forEach((kw) => {
      const isActive = filters.keyword !== 'all' && filters.keyword.toLowerCase() === kw.toLowerCase();
      const chip = el('div', 'rr-kw-chip' + (isActive ? ' active' : ''));
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.title = 'Filter view to “' + kw + '”';

      const label = el('span', 'rr-kw-chip-label', kw);
      chip.appendChild(label);

      const x = el('button', 'rr-kw-chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove search term ' + kw);
      x.title = 'Remove “' + kw + '”';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeKeyword(kw); });
      chip.appendChild(x);

      const activate = () => setKeywordFilter(kw);
      chip.addEventListener('click', activate);
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
      host.appendChild(chip);
    });

    // Very large lists: render only the first CHIP_RENDER_LIMIT chips (the DOM
    // can't hold 100k nodes) — the rest are still stored AND scanned. Show a count.
    if (kws.length > CHIP_RENDER_LIMIT) {
      const more = el('div', 'rr-kw-chip more');
      more.textContent = '+' + (kws.length - CHIP_RENDER_LIMIT).toLocaleString('en-IN') + ' more';
      more.title = kws.length.toLocaleString('en-IN') + ' terms total — all are scanned; manage the full list via Upload or Settings';
      host.appendChild(more);
    }

    // Subtle hint when no keywords remain — scanning needs at least one term.
    const note = $('kw-note');
    if (note) {
      if (!kws.length) {
        note.textContent = 'Add at least one search term — scanning needs one to run.';
        note.classList.add('warn');
      } else {
        note.textContent = kws.length.toLocaleString('en-IN') + ' term' + (kws.length === 1 ? '' : 's') + ' · scanned on Amazon + Flipkart';
        note.classList.remove('warn');
      }
    }
  }

  // ---------------- SECTION 1: live twin ----------------
  function classOf(p) {
    return p.classification || RR.CLASS.COMPETITOR;
  }

  function placementCard(p) {
    const cls = classOf(p);
    const card = el('div', 'rr-pcard ' + cls);

    const rank = el('div', 'rr-rank');
    rank.appendChild(document.createTextNode('#' + p.rank));
    if (p.sponsored && p.adRank != null) {
      const s = el('small', null, 'ad#' + p.adRank);
      rank.appendChild(s);
    }
    card.appendChild(rank);

    const body = el('div', 'rr-pbody');
    const brandRow = el('div', 'rr-pbrand');
    brandRow.appendChild(document.createTextNode(p.brand || 'Unknown'));
    if (p.sponsored) brandRow.appendChild(el('span', 'rr-badge rr-badge-ad', 'AD'));
    if (cls === RR.CLASS.MINE) brandRow.appendChild(el('span', 'rr-badge rr-badge-mine', 'YOUR BRAND'));
    body.appendChild(brandRow);
    body.appendChild(el('div', 'rr-ptitle', truncate(p.title, 70)));
    card.appendChild(body);

    const meta = el('div', 'rr-pmeta');
    if (p.price != null) {
      const priceWrap = el('div');
      priceWrap.appendChild(el('span', 'rr-price', fmtINR(p.price)));
      if (p.mrp != null && p.mrp > p.price) priceWrap.appendChild(el('span', 'rr-mrp', fmtINR(p.mrp)));
      meta.appendChild(priceWrap);
    }
    if (p.rating != null) meta.appendChild(el('div', 'rr-rating', '★ ' + round1(p.rating)));
    card.appendChild(meta);

    return card;
  }

  function renderTwinColumn(market, scan) {
    const col = $('twin-' + market);
    clear(col);

    const head = el('div', 'rr-twin-head');
    const title = el('div', 'rr-twin-title');
    title.appendChild(el('span', 'rr-mk-tag ' + market, market));
    head.appendChild(title);
    const focusBtn = el('button', 'rr-btn', 'Focus tab');
    focusBtn.type = 'button';
    focusBtn.addEventListener('click', () => send({ type: RR.MSG.FOCUS_TAB, marketplace: market }));
    head.appendChild(focusBtn);
    col.appendChild(head);

    if (!scan) {
      col.appendChild(emptyState('No ' + market + ' scan yet', 'Press Start to begin scanning.'));
      return;
    }

    const meta = el('div', 'rr-twin-meta');
    meta.appendChild(document.createTextNode('Keyword '));
    meta.appendChild(el('b', null, scan.keyword));
    meta.appendChild(document.createTextNode(
      ' · ' + clockTime(scan.ts) + ' (' + timeAgo(scan.ts) + ') · ' +
      (scan.counts ? scan.counts.sponsored : 0) + ' sponsored of ' +
      (scan.counts ? scan.counts.total : 0) + ' results'
    ));
    col.appendChild(meta);

    const list = el('div', 'rr-cards');
    const placements = (scan.placements || []).slice().sort((a, b) => a.rank - b.rank);
    if (!placements.length) {
      list.appendChild(emptyState('No placements captured', ''));
    } else {
      placements.forEach((p) => list.appendChild(placementCard(p)));
    }
    col.appendChild(list);
  }

  function emptyState(big, sub) {
    const e = el('div', 'rr-empty');
    e.appendChild(el('div', 'big', big));
    if (sub) e.appendChild(el('div', null, sub));
    return e;
  }

  // ---------------- SECTION 2: analytics ----------------
  function brandKey(p) {
    return (p.brand && p.brand.trim()) || 'Unknown';
  }

  function renderAnalytics(scans) {
    // Active-mode pool (sponsored / organic / all), excluded brands dropped.
    const pool = modePlacements(scans);
    const modeName = MODE_LABEL[sovMode];

    $('analytics-scope').textContent =
      scans.length + ' scan' + (scans.length === 1 ? '' : 's') + ' in view · ' +
      pool.length + ' ' + modeName.toLowerCase() + ' placements';

    const sub = $('sov-sub');
    if (sub) sub.textContent = '(' + modeSlotWord() + ')';

    renderKpis(scans, pool);
    renderSoV(pool);
    renderTrend(scans);
    renderLeaderboard(pool);
    renderMyVisibility(scans, pool);
    renderSovSplit(scans);
  }

  // KPI row — mode aware. Shows your-brand SoV% for the active mode plus a
  // secondary line giving your brand's organic% vs sponsored% share.
  function renderKpis(scans, pool) {
    const wrap = $('kpis');
    clear(wrap);
    const modeName = MODE_LABEL[sovMode];
    const competitorBrands = new Set();
    let mineN = 0;
    for (const p of pool) {
      const c = brandClass(p);
      if (c === RR.CLASS.COMPETITOR) competitorBrands.add(brandKey(p).toLowerCase());
      else if (c === RR.CLASS.MINE) mineN++;
    }
    const myShare = pct(mineN, pool.length);

    // Bifurcation: your brand's organic% and sponsored% share (across all
    // scans in view, independent of the active mode) for the KPI sub-line.
    const bif = brandBifurcation(scans, (lastConfig && lastConfig.myBrands) || [], RR.CLASS.MINE);

    const cards = [
      { v: scans.length, l: 'Scans in view', cls: '' },
      { v: pool.length, l: modeName + ' placements', cls: '' },
      { v: competitorBrands.size, l: 'Distinct competitors', cls: 'danger' },
      { v: myShare + '%', l: 'Your-brand ' + modeName.toLowerCase() + ' SoV', cls: 'accent', bif: bif },
    ];
    cards.forEach((c) => {
      const k = el('div', 'rr-kpi ' + c.cls);
      k.appendChild(el('div', 'v', String(c.v)));
      k.appendChild(el('div', 'l', c.l));
      if (c.bif) {
        const sub = el('div', 'sub');
        sub.appendChild(el('span', 'org', c.bif.organic + '%'));
        sub.appendChild(document.createTextNode(' organic · '));
        sub.appendChild(el('span', 'spo', c.bif.sponsored + '%'));
        sub.appendChild(document.createTextNode(' sponsored'));
        k.appendChild(sub);
      }
      wrap.appendChild(k);
    });
  }

  function renderSoV(pool) {
    const host = $('sov');
    clear(host);
    if (!pool.length) {
      host.appendChild(emptyState('No ' + modeSlotWord() + ' yet', 'Share of voice appears once placements are captured.'));
      return;
    }
    const byBrand = new Map(); // key -> {brand, count, cls}
    for (const p of pool) {
      const key = brandKey(p).toLowerCase();
      let e = byBrand.get(key);
      if (!e) { e = { brand: brandKey(p), count: 0, cls: brandClass(p) }; byBrand.set(key, e); }
      e.count++;
      if (brandClass(p) === RR.CLASS.MINE) e.cls = RR.CLASS.MINE;
    }
    const rows = Array.from(byBrand.values()).sort((a, b) => b.count - a.count).slice(0, 10);
    const max = rows[0].count;
    rows.forEach((r) => {
      const row = el('div', 'rr-bar-row');
      row.appendChild(el('div', 'rr-bar-label', r.brand));
      const track = el('div', 'rr-bar-track');
      const fillCls = r.cls === RR.CLASS.MINE ? 'mine' : r.cls === RR.CLASS.COMPETITOR ? 'competitor' : 'other';
      const fill = el('div', 'rr-bar-fill ' + fillCls);
      fill.style.width = Math.max(3, (r.count / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'rr-bar-val', pct(r.count, pool.length) + '%'));
      host.appendChild(row);
    });
  }

  function renderLeaderboard(pool) {
    const host = $('leaderboard');
    clear(host);
    const posLabel = sovMode === 'sponsored' ? 'Avg ad rank' : 'Avg position';
    const competitors = pool.filter((p) => brandClass(p) === RR.CLASS.COMPETITOR);
    if (!competitors.length) {
      host.appendChild(emptyState('No competitor ' + modeSlotWord() + ' yet', ''));
      return;
    }
    const byBrand = new Map();
    for (const p of competitors) {
      const key = brandKey(p).toLowerCase();
      let e = byBrand.get(key);
      if (!e) { e = { brand: brandKey(p), n: 0, rankSum: 0, rankN: 0, priceSum: 0, priceN: 0, slot1: 0 }; byBrand.set(key, e); }
      e.n++;
      const pos = modePos(p);
      if (pos != null) { e.rankSum += pos; e.rankN++; if (pos === 1) e.slot1++; }
      if (p.price != null) { e.priceSum += p.price; e.priceN++; }
    }
    const rows = Array.from(byBrand.values()).sort((a, b) => b.n - a.n).slice(0, 12);

    const table = el('table', 'rr-table');
    const thead = el('thead');
    const htr = el('tr');
    ['Brand', 'Placements', posLabel, 'Avg price', 'At pos #1'].forEach((h, i) => {
      const th = el('th', i > 0 ? 'num' : null, h);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'brand', r.brand));
      tr.appendChild(el('td', 'num', String(r.n)));
      tr.appendChild(el('td', 'num', r.rankN ? String(round1(r.rankSum / r.rankN)) : '—'));
      tr.appendChild(el('td', 'num', r.priceN ? fmtINR(r.priceSum / r.priceN) : '—'));
      tr.appendChild(el('td', 'num', String(r.slot1)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  function renderMyVisibility(scans, pool) {
    const host = $('my-vis');
    clear(host);
    const modeName = MODE_LABEL[sovMode];
    const posLabel = sovMode === 'sponsored' ? 'Avg ad rank' : 'Avg position';
    const mineP = pool.filter((p) => brandClass(p) === RR.CLASS.MINE);
    const appearances = mineP.length;
    let rankSum = 0, rankN = 0;
    for (const p of mineP) { const pos = modePos(p); if (pos != null) { rankSum += pos; rankN++; } }

    let scansWithMine = 0;
    for (const s of scans) {
      if ((s.placements || []).some((p) => inMode(p) && brandClass(p) === RR.CLASS.MINE)) scansWithMine++;
    }
    const heldPct = pct(scansWithMine, scans.length);

    const list = el('div', 'rr-stat-list');
    const stats = [
      { k: modeName + ' appearances', v: String(appearances), teal: true },
      { k: posLabel, v: rankN ? String(round1(rankSum / rankN)) : '—', teal: false },
      { k: '% of scans holding a slot', v: heldPct + '%', teal: true },
      { k: 'Scans in view', v: String(scans.length), teal: false },
    ];
    stats.forEach((st) => {
      const row = el('div', 'rr-stat');
      row.appendChild(el('div', 'k', st.k));
      row.appendChild(el('div', 'v' + (st.teal ? ' teal' : ''), st.v));
      list.appendChild(row);
    });
    host.appendChild(list);
    if (!appearances && scans.length) {
      const hint = el('div', 'rr-note');
      hint.style.marginTop = '12px';
      hint.textContent = 'Your brand has not held a ' + modeName.toLowerCase() + ' slot in this view.';
      host.appendChild(hint);
    }
  }

  // ---------- ORGANIC / SPONSORED / OVERALL bifurcation ----------
  // Compute a single brand's organic% / sponsored% / overall% share across a
  // set of scans. `matchClass` selects which placements count as that brand:
  //  - pass a myBrands list + RR.CLASS.MINE to match your brand
  //  - pass [brandName] + null to match by lower-cased brand name.
  // Excluded brands are dropped from each denominator.
  function brandBifurcation(scans, names, wantClass) {
    const wantNames = new Set((names || []).map((s) => String(s).trim().toLowerCase()));
    let orgN = 0, orgT = 0, spoN = 0, spoT = 0, allN = 0, allT = 0;
    const isTarget = (p) => {
      if (wantClass === RR.CLASS.MINE) return brandClass(p) === RR.CLASS.MINE;
      return wantNames.has(brandKey(p).toLowerCase());
    };
    for (const s of scans) {
      for (const p of (s.placements || [])) {
        if (brandClass(p) === RR.CLASS.EXCLUDED) continue;
        const hit = isTarget(p);
        allT++; if (hit) allN++;
        if (p.sponsored) { spoT++; if (hit) spoN++; }
        else { orgT++; if (hit) orgN++; }
      }
    }
    return {
      organic: pct(orgN, orgT),
      sponsored: pct(spoN, spoT),
      overall: pct(allN, allT),
    };
  }

  // SoV split card: your brand + top competitors, each with organic/sponsored/
  // overall mini-bars. Top competitors chosen by overall appearances.
  function renderSovSplit(scans) {
    const host = $('sov-split');
    clear(host);

    // Rank brands by overall (non-excluded) appearances to pick which to show.
    const overall = new Map(); // key -> {brand, cls, n}
    for (const s of scans) {
      for (const p of (s.placements || [])) {
        if (brandClass(p) === RR.CLASS.EXCLUDED) continue;
        const key = brandKey(p).toLowerCase();
        let e = overall.get(key);
        if (!e) { e = { brand: brandKey(p), cls: brandClass(p), n: 0 }; overall.set(key, e); }
        if (brandClass(p) === RR.CLASS.MINE) e.cls = RR.CLASS.MINE;
        e.n++;
      }
    }
    if (!overall.size) {
      host.appendChild(emptyState('No placements yet', 'The organic vs sponsored split appears once scans are captured.'));
      return;
    }

    const ranked = Array.from(overall.values()).sort((a, b) => b.n - a.n);
    const mine = ranked.find((e) => e.cls === RR.CLASS.MINE);
    const comps = ranked.filter((e) => e.cls === RR.CLASS.COMPETITOR).slice(0, 5);
    const show = [];
    if (mine) show.push(mine);
    comps.forEach((c) => show.push(c));

    // legend
    const legend = el('div', 'rr-split-legend');
    [['org', 'Organic %'], ['spo', 'Sponsored %'], ['ovr', 'Overall %']].forEach(([c, t]) => {
      const item = el('span');
      item.appendChild(el('span', 'sw ' + c));
      item.appendChild(document.createTextNode(t));
      legend.appendChild(item);
    });
    host.appendChild(legend);

    show.forEach((e) => {
      const bif = brandBifurcation(scans, [e.brand], null);
      const row = el('div', 'rr-split-row');
      const name = el('div', 'name' + (e.cls === RR.CLASS.MINE ? ' mine' : ''), e.brand);
      row.appendChild(name);
      const bars = el('div', 'rr-split-bars');
      [['organic', 'Organic', bif.organic], ['sponsored', 'Sponsored', bif.sponsored], ['overall', 'Overall', bif.overall]].forEach(([cls, tag, v]) => {
        const bar = el('div', 'rr-split-bar ' + cls);
        bar.appendChild(el('span', 'tag', tag));
        const track = el('div', 'track');
        const fill = el('div', 'fill');
        fill.style.width = Math.max(2, v) + '%';
        track.appendChild(fill);
        bar.appendChild(track);
        bar.appendChild(el('span', 'val', v + '%'));
        bars.appendChild(bar);
      });
      row.appendChild(bars);
      host.appendChild(row);
    });
  }

  // ---------------- SECTION 2b: competitive analytics ----------------
  // Brand-class helper that prefers the placement's stored classification but
  // falls back to the user's configured myBrands list (case-insensitive).
  function brandClass(p) {
    const c = classOf(p);
    if (c === RR.CLASS.MINE || c === RR.CLASS.EXCLUDED) return c;
    const mine = (lastConfig && lastConfig.myBrands) || [];
    const bk = brandKey(p).toLowerCase();
    for (const m of mine) if (String(m).trim().toLowerCase() === bk) return RR.CLASS.MINE;
    return RR.CLASS.COMPETITOR;
  }

  // Active-mode placements that are NOT excluded (excluded brands are omitted
  // from all competitive stats per the data contract). Renamed conceptually
  // from "competitiveSponsored" — now honors the SoV mode toggle.
  function competitiveSponsored(scans) {
    return modePlacements(scans);
  }

  // The active-mode position weight for a single appearance.
  function visWeight(p) {
    return modeWeight(p);
  }

  // Tint a heatmap cell: 0% -> transparent, higher -> stronger teal (mine) or
  // red (competitor). Keeps dark text readable per CDS.
  function cellTint(value, isMine) {
    if (value <= 0) return 'transparent';
    const a = Math.min(0.92, 0.12 + (value / 100) * 0.8);
    // teal (your brand) = --rr-you (45,212,191); red (competitor) = --rr-rival (255,90,95)
    return isMine
      ? 'rgba(45, 212, 191, ' + a.toFixed(3) + ')'
      : 'rgba(255, 90, 95, ' + a.toFixed(3) + ')';
  }

  // (1) KEYWORD x BRAND SoV MATRIX — cells tinted by active-mode share.
  function renderSoVMatrix(scans) {
    const host = $('sov-matrix');
    clear(host);
    const msub = $('matrix-sub');
    if (msub) msub.textContent = '(share of each keyword’s ' + modeSlotWord() + ')';
    const sp = competitiveSponsored(scans);
    if (!sp.length) {
      host.appendChild(emptyState('No ' + MODE_LABEL[sovMode].toLowerCase() + ' data yet', 'The matrix fills in as keywords accumulate placements.'));
      return;
    }

    // overall brand totals -> pick top N=8 brands, rest -> "Others"
    const overall = new Map(); // key -> {brand, cls, n}
    const perKw = new Map();   // keyword -> {total, byBrand:Map(key->n)}
    for (const p of sp) {
      const key = brandKey(p).toLowerCase();
      let ob = overall.get(key);
      if (!ob) { ob = { brand: brandKey(p), cls: brandClass(p), n: 0 }; overall.set(key, ob); }
      ob.n++;
      if (brandClass(p) === RR.CLASS.MINE) ob.cls = RR.CLASS.MINE;

      let kw = perKw.get(p.keyword);
      if (!kw) { kw = { total: 0, byBrand: new Map() }; perKw.set(p.keyword, kw); }
      kw.total++;
      kw.byBrand.set(key, (kw.byBrand.get(key) || 0) + 1);
    }

    const N = 8;
    const ranked = Array.from(overall.values()).sort((a, b) => b.n - a.n);
    const topBrands = ranked.slice(0, N);
    const topKeys = new Set(topBrands.map((b) => b.brand.toLowerCase()));
    const hasOthers = ranked.length > N;

    const keywords = Array.from(perKw.keys()).sort((a, b) => a.localeCompare(b));

    const wrap = el('div', 'rr-matrix-wrap');
    const table = el('table', 'rr-matrix');

    const thead = el('thead');
    const htr = el('tr');
    htr.appendChild(el('th', 'kw-col', 'Keyword'));
    topBrands.forEach((b) => {
      const th = el('th', b.cls === RR.CLASS.MINE ? 'mine-col' : null, b.brand);
      htr.appendChild(th);
    });
    if (hasOthers) htr.appendChild(el('th', null, 'Others'));
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    keywords.forEach((kw) => {
      const data = perKw.get(kw);
      const tr = el('tr');
      if (filters.keyword !== 'all' && filters.keyword.toLowerCase() === kw.toLowerCase()) {
        tr.classList.add('kw-active');
      }
      // Row-click selects the keyword (drives the drill-down + keyword filter).
      tr.style.cursor = 'pointer';
      tr.title = 'Click to drill into “' + kw + '”';
      tr.addEventListener('click', () => setKeywordFilter(
        (filters.keyword !== 'all' && filters.keyword.toLowerCase() === kw.toLowerCase()) ? 'all' : kw
      ));
      tr.appendChild(el('td', 'kw-cell', kw));
      let topSum = 0;
      topBrands.forEach((b) => {
        const k = b.brand.toLowerCase();
        const n = data.byBrand.get(k) || 0;
        topSum += n;
        const v = data.total > 0 ? Math.round((n / data.total) * 100) : 0;
        const td = el('td', 'cell' + (v <= 0 ? ' zero' : ''), v <= 0 ? '–' : v + '%');
        if (v > 0) td.style.background = cellTint(v, b.cls === RR.CLASS.MINE);
        tr.appendChild(td);
      });
      if (hasOthers) {
        const restN = data.total - topSum;
        const v = data.total > 0 ? Math.round((restN / data.total) * 100) : 0;
        const td = el('td', 'cell' + (v <= 0 ? ' zero' : ''), v <= 0 ? '–' : v + '%');
        if (v > 0) td.style.background = cellTint(v, false);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);

    const legend = el('div', 'rr-matrix-legend');
    legend.appendChild(document.createTextNode('Cell = brand share of that keyword’s ' + modeSlotWord() + '. Click a row to drill in. 0%'));
    legend.appendChild(el('span', 'grad teal'));
    legend.appendChild(document.createTextNode('your brand'));
    legend.appendChild(el('span', 'grad red'));
    legend.appendChild(document.createTextNode('competitors  (higher = stronger)'));
    host.appendChild(legend);
  }

  // (1b) KEYWORD DRILL-DOWN — focused panel for the SELECTED keyword. Shows,
  // per brand, a horizontal bar of the active-mode SoV plus the organic /
  // sponsored / overall bifurcation, the brand's rank for that keyword, and its
  // avg position. Hidden when no keyword is selected.
  function renderKeywordDrill(scans) {
    const card = $('kw-drill-card');
    const host = $('kw-drill');
    const sub = $('kw-drill-sub');
    if (!card || !host) return;
    clear(host);

    if (filters.keyword === 'all') {
      card.classList.add('hidden');
      if (sub) sub.textContent = '';
      return;
    }
    card.classList.remove('hidden');
    const kw = filters.keyword;
    if (sub) sub.textContent = '· “' + kw + '” · ' + MODE_LABEL[sovMode] + ' SoV';

    // All non-excluded placements for this keyword (mode pool) + full-split data.
    const kwScans = scans.map((s) => s).filter((s) => s.keyword === kw);
    const pool = modePlacements(kwScans);

    if (!pool.length) {
      host.appendChild(emptyState('No ' + MODE_LABEL[sovMode].toLowerCase() + ' data for “' + kw + '”',
        'Try a different SoV mode or keep scanning.'));
      return;
    }

    // Per-brand active-mode counts + avg position for ranking/bars.
    const byBrand = new Map(); // key -> {brand, cls, n, rankSum, rankN}
    for (const p of pool) {
      const key = brandKey(p).toLowerCase();
      let e = byBrand.get(key);
      if (!e) { e = { brand: brandKey(p), cls: brandClass(p), n: 0, rankSum: 0, rankN: 0 }; byBrand.set(key, e); }
      if (brandClass(p) === RR.CLASS.MINE) e.cls = RR.CLASS.MINE;
      e.n++;
      const pos = modePos(p);
      if (pos != null) { e.rankSum += pos; e.rankN++; }
    }
    const total = pool.length;
    const rows = Array.from(byBrand.values()).sort((a, b) => b.n - a.n);
    // ensure your brand is shown even if outside the top slice
    const top = rows.slice(0, 8);
    const mineRow = rows.find((r) => r.cls === RR.CLASS.MINE);
    if (mineRow && !top.includes(mineRow)) top.push(mineRow);

    const head = el('div', 'rr-drill-head');
    head.appendChild(document.createTextNode('Keyword '));
    head.appendChild(el('span', 'kw', '“' + kw + '”'));
    head.appendChild(document.createTextNode(' · ' + total + ' ' + MODE_LABEL[sovMode].toLowerCase() + ' placements · ' + rows.length + ' brands'));
    host.appendChild(head);

    const posLabel = sovMode === 'sponsored' ? 'ad pos' : 'pos';
    top.forEach((r, idx) => {
      const rankAmong = rows.indexOf(r) + 1;
      const bif = brandBifurcation(kwScans, [r.brand], null);
      const row = el('div', 'rr-drill-row');

      const name = el('div', 'name' + (r.cls === RR.CLASS.MINE ? ' mine' : ''));
      name.appendChild(document.createTextNode(r.brand + ' '));
      name.appendChild(el('span', 'rank', '#' + rankAmong));
      row.appendChild(name);

      const bars = el('div', 'rr-drill-bars');
      [['organic', 'Organic', bif.organic], ['sponsored', 'Sponsored', bif.sponsored], ['overall', 'Overall', bif.overall]].forEach(([cls, tag, v]) => {
        const bar = el('div', 'rr-drill-bar ' + cls);
        bar.appendChild(el('span', 'tag', tag));
        const track = el('div', 'track');
        const fill = el('div', 'fill');
        fill.style.width = Math.max(2, v) + '%';
        track.appendChild(fill);
        bar.appendChild(track);
        bar.appendChild(el('span', 'val', v + '%'));
        bars.appendChild(bar);
      });
      row.appendChild(bars);

      const avgPos = r.rankN ? round1(r.rankSum / r.rankN) : null;
      row.appendChild(el('div', 'pos', 'avg ' + posLabel + ' ' + (avgPos != null ? avgPos : '—')));
      host.appendChild(row);
    });
  }

  // Aggregate weighted/plain visibility per brand over a set of sponsored
  // placements. Returns rows[] sorted by weighted SoV desc + the weight total.
  function weightedRows(sponsored) {
    const byBrand = new Map(); // key -> {brand, cls, n, weight, rankSum, rankN, slot1}
    let totalWeight = 0;
    for (const p of sponsored) {
      const key = brandKey(p).toLowerCase();
      let e = byBrand.get(key);
      if (!e) { e = { brand: brandKey(p), cls: brandClass(p), n: 0, weight: 0, rankSum: 0, rankN: 0, slot1: 0 }; byBrand.set(key, e); }
      if (brandClass(p) === RR.CLASS.MINE) e.cls = RR.CLASS.MINE;
      e.n++;
      const w = visWeight(p);
      e.weight += w;
      totalWeight += w;
      const pos = modePos(p);
      if (pos != null) { e.rankSum += pos; e.rankN++; if (pos === 1) e.slot1++; }
    }
    const rows = Array.from(byBrand.values()).sort((a, b) => b.weight - a.weight);
    return { rows, totalWeight, total: sponsored.length };
  }

  // (2) WEIGHTED VISIBILITY LEADERBOARD (respects single-keyword filter)
  function renderWeightedLeaderboard(scans) {
    const host = $('weighted-leaderboard');
    clear(host);
    const wsub = $('wlb-sub');
    if (wsub) wsub.textContent = '(' + (sovMode === 'sponsored' ? 'ad-position' : 'position') + ' weighted · ' + MODE_LABEL[sovMode] + ')';
    // honor the selected keyword if any (else overall in-scope)
    let sp = competitiveSponsored(scans);
    if (filters.keyword !== 'all') sp = sp.filter((p) => p.keyword === filters.keyword);
    if (!sp.length) {
      host.appendChild(emptyState('No ' + MODE_LABEL[sovMode].toLowerCase() + ' data yet', 'Weighted visibility appears once placements are captured.'));
      return;
    }

    const { rows, totalWeight, total } = weightedRows(sp);
    const view = rows.slice(0, 12);
    const maxW = view.length ? view[0].weight : 1;

    const table = el('table', 'rr-table');
    const thead = el('thead');
    const htr = el('tr');
    ['Brand', 'Weighted SoV%', 'SoV%', 'Avg pos', 'Appearances', 'Times #1'].forEach((h, i) => {
      htr.appendChild(el('th', i > 0 ? 'num' : null, h));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    view.forEach((r) => {
      const isMine = r.cls === RR.CLASS.MINE;
      const tr = el('tr', isMine ? 'mine-row' : null);
      const bcell = el('td', 'brand', r.brand);
      if (isMine) bcell.classList.remove('brand'); // mine-row CSS recolors teal
      tr.appendChild(bcell);

      // weighted SoV% with a small bar
      const wPct = totalWeight > 0 ? Math.round((r.weight / totalWeight) * 100) : 0;
      const wTd = el('td', 'num');
      const cell = el('div', 'rr-wbar-cell');
      const track = el('div', 'rr-wbar-track');
      const fill = el('div', 'rr-wbar-fill ' + (isMine ? 'mine' : 'competitor'));
      fill.style.width = Math.max(3, (r.weight / maxW) * 100) + '%';
      track.appendChild(fill);
      cell.appendChild(track);
      cell.appendChild(el('span', null, wPct + '%'));
      wTd.appendChild(cell);
      tr.appendChild(wTd);

      tr.appendChild(el('td', 'num', pct(r.n, total) + '%'));
      tr.appendChild(el('td', 'num', r.rankN ? String(round1(r.rankSum / r.rankN)) : '—'));
      tr.appendChild(el('td', 'num', String(r.n)));
      tr.appendChild(el('td', 'num', String(r.slot1)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);

    host.appendChild(el('div', 'rr-explainer',
      sovMode === 'sponsored'
        ? 'Weighted SoV credits higher ad slots more — each appearance is worth 1/ad-position (top slot = 1.0, slot 2 = 0.5, …), so owning slot #1 counts far more than a slot far down the page.'
        : 'Weighted SoV credits higher page positions more — each appearance is worth 1/rank (position 1 = 1.0, position 2 = 0.5, …), so ranking near the top counts far more than a slot far down the page.'));
  }

  // (2b) SHARE-OF-VOICE TREND (multi-line, hand-drawn SVG)
  // Scope mirrors the weighted leaderboard: marketplace + range (via scopedScans
  // passed in) PLUS the single-keyword filter when one is selected.
  // Floor a timestamp to the top of its hour.
  const HOUR_MS = 3600000;
  const hourOf = (ts) => Math.floor(ts / HOUR_MS) * HOUR_MS;

  // Categorical palette for competitor lines (theme --rr-cat-1..8). Your brand
  // is always --rr-you. Color assignment is STABLE per brand key (sorted by
  // overall appearances) so the selector chips + the plotted lines agree.
  const CAT_PALETTE = ['#ff5a5f', '#f5a524', '#a78bfa', '#38bdf8', '#f472b6', '#34d399', '#fb923c', '#c084fc'];
  const YOU_COLOR = '#2dd4bf';

  // Rank ALL non-excluded brands by overall appearances (across full stored
  // data, mode-agnostic) and assign each a stable class + color. Returns an
  // ordered array [{key, brand, cls, color, n}] used by both the brand selector
  // and the hourly trend.
  function brandUniverse() {
    const overall = new Map(); // key -> {key, brand, cls, n}
    for (const s of allScans) {
      for (const p of (s.placements || [])) {
        if (brandClass(p) === RR.CLASS.EXCLUDED) continue;
        const key = brandKey(p).toLowerCase();
        let e = overall.get(key);
        if (!e) { e = { key, brand: brandKey(p), cls: brandClass(p), n: 0 }; overall.set(key, e); }
        if (brandClass(p) === RR.CLASS.MINE) e.cls = RR.CLASS.MINE;
        e.n++;
      }
    }
    const ranked = Array.from(overall.values()).sort((a, b) => b.n - a.n);
    let ci = 0;
    ranked.forEach((e) => {
      e.color = e.cls === RR.CLASS.MINE ? YOU_COLOR : CAT_PALETTE[ci++ % CAT_PALETTE.length];
    });
    return ranked;
  }

  // Default trend selection = your brand + top 5 competitors (by appearances).
  function defaultTrendSelection(universe) {
    const sel = new Set();
    const mine = universe.find((e) => e.cls === RR.CLASS.MINE);
    if (mine) sel.add(mine.key);
    let added = 0;
    for (const e of universe) {
      if (e.cls === RR.CLASS.MINE) continue;
      if (added >= 5) break;
      sel.add(e.key); added++;
    }
    return sel;
  }

  // Brand selector chips — scrollable checklist of every brand, toggling which
  // lines the hourly trend plots. Colors match the plotted lines.
  function renderBrandSelector(universe) {
    const host = $('brand-selector');
    if (!host) return;
    clear(host);
    if (!universe.length) return;
    universe.forEach((e) => {
      const on = trendBrandSel && trendBrandSel.has(e.key);
      const chip = el('button', 'rr-brand-chip' + (e.cls === RR.CLASS.MINE ? ' mine' : ''));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      const dot = el('span', 'dot');
      if (on) dot.style.background = e.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(e.brand));
      chip.addEventListener('click', () => {
        if (!trendBrandSel) trendBrandSel = new Set();
        if (trendBrandSel.has(e.key)) trendBrandSel.delete(e.key);
        else trendBrandSel.add(e.key);
        renderCompete(); // re-render selector + trend together
      });
      host.appendChild(chip);
    });
  }

  // (2b) HOURLY PER-BRAND SoV TREND (multi-line, hand-drawn SVG).
  // X-axis spans the FULL timeline of stored data (earliest hour .. latest/now)
  // regardless of the current range filter, so the whole day is visible. Y =
  // active-mode SoV%. One line per SELECTED brand. Line breaks across hours
  // that have NO scans (gaps are not bridged).
  function renderSovTrend(scans) {
    const host = $('sov-trend');
    clear(host);
    const tsub = $('sov-trend-sub');
    if (tsub) tsub.textContent = '(' + modeSlotWord() + ' share by hour)';

    // Full universe + selector (mode-agnostic ranking so the selector is stable).
    const universe = brandUniverse();
    if (trendBrandSel === null) trendBrandSel = defaultTrendSelection(universe);
    renderBrandSelector(universe);

    // Active-mode placements honoring the keyword filter (like the leaderboard).
    let sp = competitiveSponsored(scans);
    if (filters.keyword !== 'all') sp = sp.filter((p) => p.keyword === filters.keyword);

    // Timeline spans the FULL stored data (ignore the range filter) so the whole
    // day shows. Build the set of hours that actually HAVE scans (all scans,
    // honoring only the keyword filter) — these drive x-axis + line breaks.
    const hourSet = new Set();
    let firstHour = Infinity, lastHour = -Infinity;
    for (const s of allScans) {
      if (filters.keyword !== 'all' && s.keyword !== filters.keyword) continue;
      if (filters.market !== 'all' && s.marketplace !== filters.market) continue;
      const h = hourOf(s.ts);
      hourSet.add(h);
      if (h < firstHour) firstHour = h;
      if (h > lastHour) lastHour = h;
    }
    const hours = Array.from(hourSet).sort((a, b) => a - b);

    const selected = universe.filter((e) => trendBrandSel && trendBrandSel.has(e.key));

    if (!hours.length || !sp.length) {
      host.appendChild(emptyState('Not enough history yet', 'The hourly trend builds as scans accumulate through the day.'));
      return;
    }
    if (!selected.length) {
      host.appendChild(emptyState('No brands selected', 'Pick one or more brands above to plot their hourly SoV.'));
      return;
    }

    // Per-hour totals (active mode) + per-brand counts, keyed by hour index.
    const hIndex = new Map();
    hours.forEach((h, i) => hIndex.set(h, i));
    const totalByHour = new Array(hours.length).fill(0);
    const countByBrand = new Map(); // key -> number[]
    selected.forEach((e) => countByBrand.set(e.key, new Array(hours.length).fill(0)));
    for (const p of sp) {
      const hi = hIndex.get(hourOf(p.ts));
      if (hi == null) continue;
      totalByHour[hi]++;
      const key = brandKey(p).toLowerCase();
      const arr = countByBrand.get(key);
      if (arr) arr[hi]++;
    }

    // Geometry — viewBox width fixed at 680 per spec. X spans first..last hour.
    const W = 680, H = 280, padL = 40, padR = 14, padT = 16, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const minT = hours[0];
    const maxT = Math.max(hours[hours.length - 1], hourOf(Date.now())); // extend to "now"
    const span = Math.max(HOUR_MS, maxT - minT);
    const xOf = (t) => padL + ((t - minT) / span) * plotW;
    const yOf = (vPct) => padT + plotH - (vPct / 100) * plotH; // 0..100%

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('class', 'rr-svg-wrap');

    // y-axis gridlines + labels at 0/25/50/75/100
    [0, 25, 50, 75, 100].forEach((val) => {
      const y = yOf(val);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(255,255,255,0.06)');
      svg.appendChild(line);
      const lbl = document.createElementNS(ns, 'text');
      lbl.setAttribute('x', padL - 6); lbl.setAttribute('y', y + 3);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('fill', '#6f8cab'); lbl.setAttribute('font-size', '9');
      lbl.textContent = val + '%';
      svg.appendChild(lbl);
    });

    // x-axis hour ticks (a few), formatted HH:00 across the full span.
    const hourLabel = (t) => {
      const d = new Date(t);
      return String(d.getHours()).padStart(2, '0') + ':00';
    };
    const tickCount = Math.min(6, hours.length);
    const seen = new Set();
    for (let i = 0; i < tickCount; i++) {
      const idx = tickCount === 1 ? 0 : Math.round((i / (tickCount - 1)) * (hours.length - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      const t = hours[idx];
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', xOf(t));
      tx.setAttribute('y', H - 10);
      tx.setAttribute('fill', '#6f8cab'); tx.setAttribute('font-size', '9');
      tx.setAttribute('text-anchor', idx === 0 ? 'start' : idx === hours.length - 1 ? 'end' : 'middle');
      tx.textContent = hourLabel(t);
      svg.appendChild(tx);
    }

    // Draw each selected brand's line. A brand absent in an hour-that-has-scans
    // plots 0% for that hour. Where consecutive KEPT hours are more than one
    // hour apart (a stretch with no scans at all), the line BREAKS rather than
    // bridging the gap. Per-point circles render in every hour.
    const legendData = []; // {brand, color, isMine, latestPct}
    selected.forEach((e) => {
      const color = e.color;
      const isMine = e.cls === RR.CLASS.MINE;
      const counts = countByBrand.get(e.key) || new Array(hours.length).fill(0);

      const pts = hours.map((h, i) => {
        const T = totalByHour[i];
        const sov = T > 0 ? (counts[i] / T) * 100 : 0;
        return { x: xOf(h), y: yOf(sov), t: h, pct: Math.round(sov) };
      });

      let run = [];
      const flushRun = () => {
        if (run.length >= 2) {
          const poly = document.createElementNS(ns, 'polyline');
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', color);
          poly.setAttribute('stroke-width', isMine ? '2.8' : '1.8');
          poly.setAttribute('stroke-linejoin', 'round');
          poly.setAttribute('stroke-linecap', 'round');
          poly.setAttribute('points', run.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '));
          svg.appendChild(poly);
        }
        run = [];
      };
      pts.forEach((p, i) => {
        if (i > 0 && p.t - pts[i - 1].t > HOUR_MS) flushRun(); // no-scan gap -> break
        run.push(p);
      });
      flushRun();

      // points + native tooltips "brand · HH:00 · NN%"
      pts.forEach((p) => {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', p.x.toFixed(1));
        c.setAttribute('cy', p.y.toFixed(1));
        c.setAttribute('r', isMine ? '3.0' : '2.2');
        c.setAttribute('fill', color);
        const title = document.createElementNS(ns, 'title');
        title.textContent = e.brand + ' · ' + hourLabel(p.t) + ' · ' + p.pct + '%';
        c.appendChild(title);
        svg.appendChild(c);
      });

      legendData.push({ brand: e.brand, color, isMine, latestPct: pts[pts.length - 1].pct });
    });

    host.appendChild(svg);

    // Legend: swatch + name + latest SoV%. Your brand first.
    legendData.sort((a, b) => (b.isMine ? 1 : 0) - (a.isMine ? 1 : 0));
    const legend = el('div', 'rr-sovt-legend');
    legendData.forEach((d) => {
      const item = el('span', 'item' + (d.isMine ? ' mine' : ''));
      const sw = el('span', 'sw');
      sw.style.background = d.color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(d.brand + ' '));
      item.appendChild(el('span', 'val', d.latestPct + '%'));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }

  // Per-keyword competitive aggregate (shared by table + insights).
  function keywordStats(scans) {
    const sp = competitiveSponsored(scans);
    const byKw = new Map(); // keyword -> {total, advertisers:Set, byBrand:Map(key->{brand,cls,n,rankSum,rankN,slot1})}
    for (const p of sp) {
      let kw = byKw.get(p.keyword);
      if (!kw) { kw = { keyword: p.keyword, total: 0, advertisers: new Set(), byBrand: new Map() }; byKw.set(p.keyword, kw); }
      kw.total++;
      const key = brandKey(p).toLowerCase();
      kw.advertisers.add(key);
      let b = kw.byBrand.get(key);
      if (!b) { b = { brand: brandKey(p), cls: brandClass(p), n: 0, rankSum: 0, rankN: 0, slot1: 0 }; kw.byBrand.set(key, b); }
      if (brandClass(p) === RR.CLASS.MINE) b.cls = RR.CLASS.MINE;
      b.n++;
      const pos = modePos(p);
      if (pos != null) { b.rankSum += pos; b.rankN++; if (pos === 1) b.slot1++; }
    }
    // derive leader / mine per keyword
    const rows = [];
    for (const kw of byKw.values()) {
      const brands = Array.from(kw.byBrand.values());
      let leader = null, mine = null;
      for (const b of brands) {
        if (!leader || b.n > leader.n) leader = b;
        if (b.cls === RR.CLASS.MINE) mine = b;
      }
      const leaderSoV = leader ? Math.round((leader.n / kw.total) * 100) : 0;
      const mineSoV = mine ? Math.round((mine.n / kw.total) * 100) : 0;
      rows.push({
        keyword: kw.keyword,
        total: kw.total,
        advertisers: kw.advertisers.size,
        leader, leaderSoV,
        mine, mineSoV,
        gap: leaderSoV - mineSoV,
      });
    }
    return rows;
  }

  // ---------------- KEYWORD PERFORMANCE BOARD ("where to run ads") ----------------
  // Per-platform (marketplace-scoped) active-mode SoV for YOUR brand on one
  // keyword. Filters the passed pool to the given marketplace and returns the
  // teal share yourCount/total, or null if that marketplace has no data for the
  // keyword (rendered as '—'). Excluded brands are already out of the pool.
  function platformYourSoV(placements, marketplace) {
    let total = 0, mine = 0;
    for (const p of placements) {
      if (p.marketplace !== marketplace) continue;
      total++;
      if (brandClass(p) === RR.CLASS.MINE) mine++;
    }
    if (!total) return null;
    return Math.round((mine / total) * 100);
  }

  // Deterministic, data-only ad recommendation for one keyword row. Returns a
  // chip descriptor {cls, label}. Precedence matters — checked top to bottom:
  //   lead                    -> Winning   (defend slot #1)
  //   you===0 && ads>=2       -> Enter     (absent where rivals compete hard)
  //   gap>=20                 -> Push hard
  //   gap>=8                  -> Push
  //   ads<=1                  -> Easy win  (little competition)
  //   else                    -> Hold
  function boardRecommend(you, gap, ads, lead) {
    if (lead) return { cls: 'win', label: 'Winning' };
    if (you === 0 && ads >= 2) return { cls: 'enter', label: 'Enter' };
    if (gap >= 20) return { cls: 'pushhard', label: 'Push hard' };
    if (gap >= 8) return { cls: 'push', label: 'Push' };
    if (ads <= 1) return { cls: 'easy', label: 'Easy win' };
    return { cls: 'hold', label: 'Hold' };
  }

  // Build one board row per keyword from the active-mode, non-excluded pool.
  // Reuses the same per-keyword aggregation shape as keywordStats but adds the
  // per-platform SoV, distinct-COMPETITOR advertiser count, your avg position,
  // price signals, the recommendation, and the hidden "priority" score.
  function keywordBoardRows(scans) {
    const sp = competitiveSponsored(scans); // active-mode, excluded dropped
    const byKw = new Map(); // keyword -> aggregate
    for (const p of sp) {
      let kw = byKw.get(p.keyword);
      if (!kw) {
        kw = { keyword: p.keyword, total: 0, byBrand: new Map(), placements: [],
               myPriceSum: 0, myPriceN: 0, compPriceSum: 0, compPriceN: 0 };
        byKw.set(p.keyword, kw);
      }
      kw.total++;
      kw.placements.push(p);
      const key = brandKey(p).toLowerCase();
      let b = kw.byBrand.get(key);
      if (!b) { b = { brand: brandKey(p), cls: brandClass(p), n: 0, rankSum: 0, rankN: 0 }; kw.byBrand.set(key, b); }
      if (brandClass(p) === RR.CLASS.MINE) b.cls = RR.CLASS.MINE;
      b.n++;
      const pos = modePos(p);
      if (pos != null) { b.rankSum += pos; b.rankN++; }
      // price signals split by mine vs competitor (excluded already out)
      if (p.price != null) {
        if (brandClass(p) === RR.CLASS.MINE) { kw.myPriceSum += p.price; kw.myPriceN++; }
        else { kw.compPriceSum += p.price; kw.compPriceN++; }
      }
    }

    const rows = [];
    for (const kw of byKw.values()) {
      const brands = Array.from(kw.byBrand.values());
      let leader = null, mine = null, advertisers = 0;
      for (const b of brands) {
        if (!leader || b.n > leader.n) leader = b;
        if (b.cls === RR.CLASS.MINE) mine = b;
        if (b.cls === RR.CLASS.COMPETITOR) advertisers++; // distinct competitor brands
      }
      const leaderSoV = leader ? Math.round((leader.n / kw.total) * 100) : 0;
      const you = mine ? Math.round((mine.n / kw.total) * 100) : 0;
      const lead = !!(leader && leader.cls === RR.CLASS.MINE);
      const gap = leaderSoV - you;
      const myAvgPos = (mine && mine.rankN) ? round1(mine.rankSum / mine.rankN) : null;
      rows.push({
        keyword: kw.keyword,
        you,
        amazon: platformYourSoV(kw.placements, RR.MARKET.AMAZON),
        flipkart: platformYourSoV(kw.placements, RR.MARKET.FLIPKART),
        leader, leaderSoV, lead,
        gap,
        myAvgPos,
        advertisers,
        rec: boardRecommend(you, gap, advertisers, lead),
        priority: gap * (1 + advertisers / 10), // hidden "Opportunity" score
        myAvgPrice: kw.myPriceN ? kw.myPriceSum / kw.myPriceN : null,
        compAvgPrice: kw.compPriceN ? kw.compPriceSum / kw.compPriceN : null,
      });
    }
    return rows;
  }

  // Comparator for the board honoring boardSortKey + boardSortDir. Nulls sort
  // last regardless of direction (a keyword with no avg-pos / no platform data
  // shouldn't jump to the top). Keyword A–Z uses locale compare; the direction
  // toggle still flips it.
  function boardCompare(a, b) {
    const dir = boardSortDir === 'asc' ? 1 : -1;
    if (boardSortKey === 'keyword') {
      return a.keyword.localeCompare(b.keyword) * dir;
    }
    const val = (r) => {
      switch (boardSortKey) {
        case 'gap': return r.gap;
        case 'opportunity': return r.priority;
        case 'ads': return r.advertisers;
        case 'pos': return r.myAvgPos;      // may be null
        case 'amazon': return r.amazon;     // may be null
        case 'flipkart': return r.flipkart; // may be null
        case 'you':
        default: return r.you;
      }
    };
    const av = val(a), bv = val(b);
    const an = (av == null), bn = (bv == null);
    if (an && bn) return a.keyword.localeCompare(b.keyword);
    if (an) return 1;   // nulls always last
    if (bn) return -1;
    if (av === bv) return a.keyword.localeCompare(b.keyword); // stable tiebreak
    return (av - bv) * dir;
  }

  // Render a teal mini-bar + number cell for a SoV %.
  function boardSovCell(vPct) {
    const td = el('td');
    const wrap = el('div', 'rr-board-sov');
    const track = el('div', 'rr-board-sovtrack');
    const fill = el('div', 'rr-board-sovfill');
    fill.style.width = Math.max(2, Math.min(100, vPct)) + '%';
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(el('span', 'rr-board-sovval', vPct + '%'));
    td.appendChild(wrap);
    return td;
  }

  // Columns: id maps to a boardSortKey (null = not sortable / clickable header
  // still allowed only for those with a key). label is the header text.
  const BOARD_COLS = [
    { id: 'keyword', label: 'Keyword', kw: true },
    { id: 'you', label: 'Your SoV' },
    { id: 'amazon', label: 'Amazon' },
    { id: 'flipkart', label: 'Flipkart' },
    { id: null, label: 'Leader' },
    { id: 'gap', label: 'Gap' },
    { id: 'pos', label: 'Avg pos' },
    { id: 'ads', label: 'Advertisers' },
    { id: null, label: 'Action' },
  ];

  function renderKeywordBoard(scans) {
    const host = $('kw-board');
    const sub = $('kw-board-sub');
    const summary = $('kw-board-summary');
    const legend = $('kw-board-legend');
    if (!host) return;
    clear(host);
    if (summary) clear(summary);
    if (legend) clear(legend);
    if (sub) sub.textContent = '(' + MODE_LABEL[sovMode] + ' share by keyword · ' + modeSlotWord() + ')';

    // keep the sort <select> + direction button reflecting current state
    const sortSel = $('kw-board-sort');
    if (sortSel && sortSel.value !== boardSortKey) sortSel.value = boardSortKey;
    const dirBtn = $('kw-board-dir');
    if (dirBtn) dirBtn.textContent = boardSortDir === 'asc' ? '↑' : '↓';

    const rows = keywordBoardRows(scans);
    if (!rows.length) {
      host.appendChild(emptyState(
        'No keyword data yet',
        scans.length ? 'No ' + MODE_LABEL[sovMode].toLowerCase() + ' placements in this view — try another SoV mode or keep scanning.'
                     : 'This board fills in as keywords accumulate placements.'));
      return;
    }

    // Summary line: # you lead / # you trail / your avg SoV across keywords.
    const led = rows.filter((r) => r.lead).length;
    const trailed = rows.length - led;
    const avgYou = Math.round(rows.reduce((s, r) => s + r.you, 0) / rows.length);
    if (summary) {
      const mk = (cls, label, valNode) => {
        const s = el('span', 'stat ' + cls);
        s.appendChild(valNode);
        s.appendChild(document.createTextNode(' ' + label));
        return s;
      };
      summary.appendChild(mk('win', 'keyword' + (led === 1 ? '' : 's') + ' you lead', el('b', null, String(led))));
      summary.appendChild(mk('trail', 'keyword' + (trailed === 1 ? '' : 's') + ' you trail', el('b', null, String(trailed))));
      summary.appendChild(mk('avg', 'avg ' + MODE_LABEL[sovMode].toLowerCase() + ' SoV across keywords', el('b', null, avgYou + '%')));
    }

    rows.sort(boardCompare);

    const table = el('table', 'rr-board-table');
    const thead = el('thead');
    const htr = el('tr');
    BOARD_COLS.forEach((col) => {
      const th = el('th', col.kw ? 'kw-col' : null, col.label);
      if (col.id && col.id === boardSortKey) {
        th.classList.add('sorted');
        th.appendChild(el('span', 'arrow', boardSortDir === 'asc' ? '▲' : '▼'));
      }
      if (col.id) {
        th.addEventListener('click', () => {
          if (boardSortKey === col.id) {
            boardSortDir = boardSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            boardSortKey = col.id;
            boardSortDir = (col.id === 'keyword') ? 'asc' : 'desc';
          }
          renderKeywordBoard(scans);
        });
      }
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      if (filters.keyword !== 'all' && filters.keyword.toLowerCase() === r.keyword.toLowerCase()) {
        tr.classList.add('kw-active');
      }

      // Keyword cell (clickable -> sets filters.keyword to drill, toggles off).
      const kwTd = el('td', 'kw-cell', r.keyword);
      // Price signal in the tooltip so the user sees if losing SoV is price-driven.
      const priceBits = [];
      if (r.myAvgPrice != null) priceBits.push('your avg ' + fmtINR(r.myAvgPrice));
      if (r.compAvgPrice != null) priceBits.push('competitor avg ' + fmtINR(r.compAvgPrice));
      kwTd.title = priceBits.length
        ? 'Price signal — ' + priceBits.join(' vs ') + '. Click to drill into “' + r.keyword + '”.'
        : 'Click to drill into “' + r.keyword + '”.';
      kwTd.addEventListener('click', () => setKeywordFilter(
        (filters.keyword !== 'all' && filters.keyword.toLowerCase() === r.keyword.toLowerCase()) ? 'all' : r.keyword
      ));
      tr.appendChild(kwTd);

      // Your SoV (teal mini-bar + number)
      tr.appendChild(boardSovCell(r.you));

      // Amazon % and Flipkart % (per-marketplace; '—' if no data)
      tr.appendChild(el('td', r.amazon == null ? 'muted' : null, r.amazon == null ? '—' : r.amazon + '%'));
      tr.appendChild(el('td', r.flipkart == null ? 'muted' : null, r.flipkart == null ? '—' : r.flipkart + '%'));

      // Leader + its SoV% (red competitor / teal you)
      const leaderTxt = r.leader ? r.leader.brand + ' (' + r.leaderSoV + '%)' : '—';
      tr.appendChild(el('td', r.lead ? 'leader-mine' : 'leader-comp', leaderTxt));

      // Gap (green if you lead / <=0, red if you trail)
      tr.appendChild(el('td', r.gap <= 0 ? 'gap-lead' : 'gap-trail', (r.gap > 0 ? '+' : '') + r.gap + ' pts'));

      // Avg pos ('—' if absent)
      tr.appendChild(el('td', r.myAvgPos == null ? 'muted' : null, r.myAvgPos == null ? '—' : String(r.myAvgPos)));

      // Advertisers (distinct competitor brands)
      tr.appendChild(el('td', null, String(r.advertisers)));

      // Action chip
      const actTd = el('td');
      actTd.style.textAlign = 'left';
      actTd.appendChild(el('span', 'rr-board-chip ' + r.rec.cls, r.rec.label));
      tr.appendChild(actTd);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);

    // Legend explaining the chips.
    if (legend) {
      const legendItems = [
        ['win', 'Winning — defend slot #1'],
        ['enter', 'Enter — absent where rivals compete'],
        ['pushhard', 'Push hard — trailing ≥20 pts'],
        ['push', 'Push — trailing ≥8 pts'],
        ['easy', 'Easy win — little competition'],
        ['hold', 'Hold — steady'],
      ];
      legendItems.forEach(([cls, txt]) => {
        const lg = el('span', 'lg');
        lg.appendChild(el('span', 'rr-board-chip ' + cls, txt.split(' — ')[0]));
        lg.appendChild(document.createTextNode(txt.slice(txt.indexOf('—'))));
        legend.appendChild(lg);
      });
    }
  }

  // (3) PER-KEYWORD COMPETITION TABLE
  function renderKeywordCompetition(scans) {
    const host = $('keyword-competition');
    clear(host);
    const rows = keywordStats(scans).sort((a, b) => b.gap - a.gap);
    if (!rows.length) {
      host.appendChild(emptyState('No keyword data yet', 'Competition breakdown appears once sponsored slots are captured.'));
      return;
    }

    const table = el('table', 'rr-table');
    const thead = el('thead');
    const htr = el('tr');
    ['Keyword', 'Ad slots', 'Advertisers', 'Leader', 'Your SoV%', 'Your avg pos', 'Gap to leader'].forEach((h, i) => {
      htr.appendChild(el('th', i > 0 ? 'num' : null, h));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, r.keyword));
      tr.appendChild(el('td', 'num', String(r.total)));
      tr.appendChild(el('td', 'num', String(r.advertisers)));

      const leaderTxt = r.leader ? r.leader.brand + ' (' + r.leaderSoV + '%)' : '—';
      const leaderMine = r.leader && r.leader.cls === RR.CLASS.MINE;
      const ltd = el('td', leaderMine ? 'leader-mine' : 'leader-comp', leaderTxt);
      tr.appendChild(ltd);

      tr.appendChild(el('td', 'num mine-val', r.mine ? r.mineSoV + '%' : '0%'));
      tr.appendChild(el('td', 'num', (r.mine && r.mine.rankN) ? String(round1(r.mine.rankSum / r.mine.rankN)) : '—'));
      tr.appendChild(el('td', 'num', (r.gap > 0 ? '+' : '') + r.gap + ' pts'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  // (4) OPPORTUNITY / THREAT INSIGHTS (auto-generated, max ~6)
  function renderInsights(scans) {
    const host = $('insights');
    clear(host);
    const rows = keywordStats(scans);
    const lines = []; // {type:'threat'|'win'|'note', html:[node…]}

    const mkLine = (type, parts) => {
      const item = el('div', 'rr-insight ' + type);
      item.appendChild(el('span', 'ico', type === 'threat' ? '▲' : type === 'win' ? '★' : '•'));
      const body = el('div');
      parts.forEach((p) => {
        if (typeof p === 'string') body.appendChild(document.createTextNode(p));
        else body.appendChild(p); // bold node
      });
      item.appendChild(body);
      return item;
    };
    const b = (t) => el('b', null, t);

    // Threats: competitor leads with >=30% while you trail (0 or much lower).
    const threats = rows
      .filter((r) => r.leader && r.leader.cls === RR.CLASS.COMPETITOR && r.leaderSoV >= 30 && r.mineSoV < r.leaderSoV - 15)
      .sort((a, b2) => (b2.leaderSoV - b2.mineSoV) - (a.leaderSoV - a.mineSoV));
    // Wins: your brand leads the keyword.
    const wins = rows
      .filter((r) => r.mine && r.leader && r.leader.cls === RR.CLASS.MINE)
      .sort((a, b2) => b2.mineSoV - a.mineSoV);
    // Position gap: you appear but at a notably worse avg position than leader.
    const posGaps = rows
      .filter((r) => r.mine && r.mine.rankN && r.leader && r.leader.cls === RR.CLASS.COMPETITOR && r.leader.rankN &&
        (r.mine.rankSum / r.mine.rankN) - (r.leader.rankSum / r.leader.rankN) >= 2)
      .sort((a, b2) =>
        ((b2.mine.rankSum / b2.mine.rankN) - (b2.leader.rankSum / b2.leader.rankN)) -
        ((a.mine.rankSum / a.mine.rankN) - (a.leader.rankSum / a.leader.rankN)));

    threats.slice(0, 3).forEach((r) => {
      lines.push(mkLine('threat', [
        'Losing ', b('“' + r.keyword + '”'), ': ',
        b(r.leader.brand), ' holds ' + r.leaderSoV + '% of ads, you hold ' + r.mineSoV + '%.',
      ]));
    });
    wins.slice(0, 2).forEach((r) => {
      lines.push(mkLine('win', [
        'Leading ', b('“' + r.keyword + '”'), ' with ' + r.mineSoV + '% SoV.',
      ]));
    });
    posGaps.slice(0, 1).forEach((r) => {
      const mineAvg = round1(r.mine.rankSum / r.mine.rankN);
      const ldAvg = round1(r.leader.rankSum / r.leader.rankN);
      lines.push(mkLine('note', [
        'Your avg ad position on ', b('“' + r.keyword + '”'),
        ' is ' + mineAvg + ' vs leader ' + ldAvg + '.',
      ]));
    });

    // Notable: a single competitor sits in slot #1 across multiple keywords.
    if (lines.length < 6) {
      const m = new Map(); // key -> {brand, kws:Set}
      const sp = competitiveSponsored(scans);
      for (const p of sp) {
        if (modePos(p) === 1 && brandClass(p) === RR.CLASS.COMPETITOR) {
          const key = brandKey(p).toLowerCase();
          let e = m.get(key);
          if (!e) { e = { brand: brandKey(p), kws: new Set() }; m.set(key, e); }
          e.kws.add(p.keyword);
        }
      }
      const topNotable = Array.from(m.values()).filter((e) => e.kws.size >= 2).sort((a, c) => c.kws.size - a.kws.size)[0];
      if (topNotable) {
        lines.push(mkLine('note', [
          b(topNotable.brand), ' holds ' + (sovMode === 'sponsored' ? 'ad slot #1' : 'position #1') + ' across ' + topNotable.kws.size + ' keywords.',
        ]));
      }
    }

    const wrap = el('div', 'rr-insights');
    if (!lines.length) {
      host.appendChild(emptyState(
        'No standout signals yet',
        scans.length ? 'No keyword shows a clear threat or win in this view — keep scanning.' : 'Insights appear once sponsored slots are captured.'
      ));
      return;
    }
    lines.slice(0, 6).forEach((n) => wrap.appendChild(n));
    host.appendChild(wrap);
  }

  // Build the export rows for the weighted leaderboard (respects keyword filter).
  function analyticsExportRows() {
    let sp = competitiveSponsored(scopedScans());
    if (filters.keyword !== 'all') sp = sp.filter((p) => p.keyword === filters.keyword);
    const { rows, totalWeight, total } = weightedRows(sp);
    return rows.map((r) => ({
      mode: sovMode,
      brand: r.brand,
      class: r.cls,
      weightedSoVPct: totalWeight > 0 ? Math.round((r.weight / totalWeight) * 100) : 0,
      plainSoVPct: pct(r.n, total),
      avgPosition: r.rankN ? round1(r.rankSum / r.rankN) : '',
      appearances: r.n,
      timesFirst: r.slot1,
    }));
  }

  function renderCompete() {
    const scoped = scopedScans(); // marketplace + range only
    $('compete-scope').textContent =
      MODE_LABEL[sovMode] + ' SoV · ' +
      (filters.keyword === 'all' ? 'all keywords' : '“' + filters.keyword + '” selected') +
      ' · matrix + per-keyword table show all keywords in scope; drill-down + weighted leaderboard honor the selected keyword';
    renderKeywordBoard(scoped);         // headline: where-to-run-ads board (all keywords)
    renderSoVMatrix(scoped);            // multi-keyword (click a row to drill)
    renderKeywordDrill(scoped);         // focused panel for the selected keyword
    renderWeightedLeaderboard(scoped);  // filters by keyword internally
    renderSovTrend(scoped);             // hourly; full-timeline x-axis
    renderKeywordCompetition(scoped);   // multi-keyword
    renderInsights(scoped);             // multi-keyword
  }

  // ---------------- trend chart (hand-drawn SVG) ----------------
  function renderTrend(scans) {
    const host = $('trend');
    clear(host);
    if (!scans.length) {
      host.appendChild(emptyState('No data yet', 'Trend appears as scans accumulate.'));
      return;
    }

    const W = 640, H = 200, padL = 34, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    // bucket scans by minute per marketplace
    const series = { amazon: new Map(), flipkart: new Map() };
    let minT = Infinity, maxT = -Infinity, maxV = 1;
    for (const s of scans) {
      const bucket = Math.floor(s.ts / 60000) * 60000;
      minT = Math.min(minT, bucket);
      maxT = Math.max(maxT, bucket);
      const m = series[s.marketplace];
      if (!m) continue;
      const v = (m.get(bucket) || 0) + (s.counts ? s.counts.sponsored : 0);
      m.set(bucket, v);
    }
    for (const mk of RR.MARKETS) for (const v of series[mk].values()) maxV = Math.max(maxV, v);
    const span = Math.max(1, maxT - minT);
    const xOf = (t) => padL + ((t - minT) / span) * plotW;
    const yOf = (v) => padT + plotH - (v / maxV) * plotH;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('class', 'rr-svg-wrap');

    // grid lines + y labels
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const val = Math.round((maxV / ticks) * i);
      const y = yOf(val);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(255,255,255,0.06)');
      svg.appendChild(line);
      const lbl = document.createElementNS(ns, 'text');
      lbl.setAttribute('x', padL - 6); lbl.setAttribute('y', y + 3);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('fill', '#6f8cab'); lbl.setAttribute('font-size', '9');
      lbl.textContent = String(val);
      svg.appendChild(lbl);
    }

    const colors = { amazon: '#ffb13d', flipkart: '#6aa6ff' };
    RR.MARKETS.forEach((mk) => {
      const m = series[mk];
      if (!m.size) return;
      const pts = Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
      // area
      let d = '';
      pts.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + xOf(p[0]).toFixed(1) + ' ' + yOf(p[1]).toFixed(1) + ' '; });
      const area = document.createElementNS(ns, 'path');
      const baseY = yOf(0);
      area.setAttribute('d', d + 'L' + xOf(pts[pts.length - 1][0]).toFixed(1) + ' ' + baseY + ' L' + xOf(pts[0][0]).toFixed(1) + ' ' + baseY + ' Z');
      area.setAttribute('fill', colors[mk]); area.setAttribute('opacity', '0.12');
      svg.appendChild(area);
      // line
      const line = document.createElementNS(ns, 'path');
      line.setAttribute('d', d.trim());
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', colors[mk]);
      line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(line);
      pts.forEach((p) => {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', xOf(p[0]).toFixed(1)); c.setAttribute('cy', yOf(p[1]).toFixed(1));
        c.setAttribute('r', '2.4'); c.setAttribute('fill', colors[mk]);
        svg.appendChild(c);
      });
    });

    // x axis end labels
    const t0 = document.createElementNS(ns, 'text');
    t0.setAttribute('x', padL); t0.setAttribute('y', H - 8);
    t0.setAttribute('fill', '#9FB3C4'); t0.setAttribute('font-size', '9');
    t0.textContent = clockTime(minT);
    svg.appendChild(t0);
    const t1 = document.createElementNS(ns, 'text');
    t1.setAttribute('x', W - padR); t1.setAttribute('y', H - 8);
    t1.setAttribute('text-anchor', 'end');
    t1.setAttribute('fill', '#9FB3C4'); t1.setAttribute('font-size', '9');
    t1.textContent = clockTime(maxT);
    svg.appendChild(t1);

    host.appendChild(svg);

    const legend = el('div', 'rr-svg-legend');
    [['Amazon', colors.amazon], ['Flipkart', colors.flipkart]].forEach(([name, col]) => {
      const item = el('span');
      const sw = el('span', 'rr-swatch');
      sw.style.background = col;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(name));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }

  // ---------------- SECTION 3: activity log ----------------
  async function renderLog() {
    const host = $('log');
    const lines = await RR.storage.getLog();
    clear(host);
    if (!lines.length) {
      host.appendChild(emptyState('No activity yet', 'Log lines appear as the scanner runs.'));
      return;
    }
    lines.slice(-50).reverse().forEach((ln) => {
      const lvl = ln.level || 'info';
      const row = el('div', 'rr-log-line ' + lvl);
      row.appendChild(el('span', 'rr-log-time', clockTime(ln.t)));
      row.appendChild(el('span', 'lvl', lvl.toUpperCase()));
      row.appendChild(el('span', 'rr-log-msg', ln.line));
      host.appendChild(row);
    });
  }

  // ---------------- SECTION: competitor negative reviews ----------------
  function revBrandKey(r) {
    return (r.brand && r.brand.trim()) || 'Unknown';
  }

  // Reviews respect the shared marketplace + keyword + range filters, plus the
  // reviews-only brand filter. Newest first.
  function filteredReviews() {
    const from = rangeStart();
    return allReviews
      .filter((r) => {
        if (r.ts != null && r.ts < from) return false;
        if (filters.market !== 'all' && r.marketplace !== filters.market) return false;
        if (filters.keyword !== 'all' && r.keyword !== filters.keyword) return false;
        if (filters.revBrand !== 'all' && revBrandKey(r).toLowerCase() !== filters.revBrand) return false;
        return true;
      })
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  function refreshReviewBrandFilter() {
    const sel = $('filter-rev-brand');
    if (!sel) return;
    const prev = sel.value;
    const brands = Array.from(new Set(allReviews.map((r) => revBrandKey(r))))
      .sort((a, b) => a.localeCompare(b));
    clear(sel);
    sel.appendChild(new Option('All competitors', 'all'));
    brands.forEach((b) => sel.appendChild(new Option(b, b.toLowerCase())));
    const keys = brands.map((b) => b.toLowerCase());
    sel.value = keys.includes(prev) || prev === 'all' ? prev : 'all';
    filters.revBrand = sel.value;
  }

  function updateReviewChip(state) {
    const txt = $('review-chip-text');
    if (!txt) return;
    const total = (state && state.reviewCount != null) ? state.reviewCount : allReviews.length;
    const last = state && state.lastReviewAt;
    const next = state && state.nextReviewAt;
    const parts = [total + ' review' + (total === 1 ? '' : 's')];
    if (last) parts.push('last ' + timeAgo(last));
    if (next && state && state.running) parts.push('next ' + untilLabel(next));
    txt.textContent = parts.join(' · ');
  }

  function reviewSummary(reviews) {
    const host = $('rev-summary');
    clear(host);
    if (!reviews.length) return;

    const brandCount = new Map();
    let ratingSum = 0, ratingN = 0;
    for (const r of reviews) {
      const k = revBrandKey(r);
      brandCount.set(k, (brandCount.get(k) || 0) + 1);
      if (r.rating != null) { ratingSum += r.rating; ratingN++; }
    }
    const avg = ratingN ? round1(ratingSum / ratingN) : null;

    const stat = (v, l) => {
      const s = el('div', 'rr-rev-stat');
      s.appendChild(el('div', 'v', String(v)));
      s.appendChild(el('div', 'l', l));
      return s;
    };
    host.appendChild(stat(reviews.length, 'Negative reviews'));
    host.appendChild(stat(brandCount.size, 'Competitor brands'));
    host.appendChild(stat(avg != null ? '★ ' + avg : '—', 'Avg negative rating'));

    // worst-rated brands mini-bar (by count of negative reviews)
    const worst = el('div', 'rr-rev-worst');
    worst.appendChild(el('h4', null, 'Worst-rated brands (by negative reviews)'));
    const rows = Array.from(brandCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = rows.length ? rows[0][1] : 1;
    rows.forEach(([brand, n]) => {
      const row = el('div', 'rr-rev-minibar');
      row.appendChild(el('div', 'mb-label', brand));
      const track = el('div', 'mb-track');
      const fill = el('div', 'mb-fill');
      fill.style.width = Math.max(4, (n / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'mb-val', String(n)));
      worst.appendChild(row);
    });
    host.appendChild(worst);
  }

  function reviewCard(r) {
    const card = el('div', 'rr-rcard');

    const top = el('div', 'rr-rcard-top');
    const stars = el('span', 'rr-rstars');
    stars.appendChild(document.createTextNode('★' + (r.rating != null ? r.rating : '?')));
    top.appendChild(stars);
    top.appendChild(el('span', 'rr-rbrand', revBrandKey(r)));
    top.appendChild(el('span', 'rr-rprod', truncate(r.productTitle, 80)));
    if (r.wasSponsored) top.appendChild(el('span', 'rr-badge rr-badge-ad', 'AD'));
    card.appendChild(top);

    if (r.reviewTitle) card.appendChild(el('div', 'rr-rtitle', r.reviewTitle));

    const text = r.reviewText || '';
    const body = el('div', 'rr-rbody');
    // Full text always rendered into the element; clamping is CSS-only so there
    // is no display:none-at-stream flicker. JS toggles the clamp on click.
    body.textContent = text;
    const long = text.length > 240;
    if (long) {
      body.classList.add('clamped');
      card.appendChild(body);
      const more = el('button', 'rr-rmore', 'more');
      more.type = 'button';
      more.addEventListener('click', () => {
        const clamped = body.classList.toggle('clamped');
        more.textContent = clamped ? 'more' : 'less';
      });
      card.appendChild(more);
    } else {
      card.appendChild(body);
    }

    const foot = el('div', 'rr-rfoot');
    foot.appendChild(el('span', 'mk ' + r.marketplace, r.marketplace));
    if (r.reviewDate) foot.appendChild(el('span', null, r.reviewDate));
    if (r.author) foot.appendChild(el('span', null, 'by ' + r.author));
    if (r.helpful != null) foot.appendChild(el('span', null, r.helpful + ' helpful'));
    if (r.keyword) foot.appendChild(el('span', null, '“' + r.keyword + '”'));
    card.appendChild(foot);

    return card;
  }

  function renderReviews() {
    refreshReviewBrandFilter();
    const reviews = filteredReviews();
    reviewSummary(reviews);

    const host = $('rev-list');
    clear(host);
    if (!reviews.length) {
      host.appendChild(emptyState(
        'No competitor reviews captured yet',
        'Harvest runs hourly after Start — or click “Reviews now”.'
      ));
      return;
    }
    reviews.forEach((r) => host.appendChild(reviewCard(r)));
  }

  // ---------------- master render ----------------
  async function loadAndRender() {
    if (busy) return;
    busy = true;
    try {
      const [scans, reviews, status] = await Promise.all([
        RR.storage.getScans(),
        RR.storage.getReviews(),
        send({ type: RR.MSG.GET_STATUS }),
      ]);
      allScans = Array.isArray(scans) ? scans : [];
      // Stamp each placement with its scan's keyword + marketplace. These live on
      // the Scan record, NOT the placement, but every keyword-level and per-platform
      // analytic (matrix, drill-down, leaderboard filter, keyword board) reads them
      // off the placement. One in-memory pass per load (not persisted to storage).
      for (const s of allScans) {
        const kw = s.keyword, mk = s.marketplace;
        for (const p of (s.placements || [])) { p.keyword = kw; p.marketplace = mk; }
      }
      allReviews = Array.isArray(reviews) ? reviews : [];

      let running = false;
      let state = null;
      if (status && status.state) { state = status.state; running = !!state.running; if (status.config) lastConfig = status.config; }
      else { state = await RR.storage.getState(); running = !!state.running; lastConfig = await RR.storage.getConfig(); }
      setStatus(running);
      updateReviewChip(state);

      // Reflect config.keywords as chips. If the user's active view-filter term
      // is no longer a configured keyword AND no scan still carries it, fall back
      // to "all" so the highlighted chip never points at a vanished term.
      if (filters.keyword !== 'all') {
        const cfgHas = configKeywords().some((k) => k.toLowerCase() === filters.keyword.toLowerCase());
        const scanHas = allScans.some((s) => s.keyword === filters.keyword);
        if (!cfgHas && !scanHas) filters.keyword = 'all';
      }
      renderKeywordChips();

      const latest = await RR.storage.latestByMarket();
      renderTwinColumn(RR.MARKET.AMAZON, latest.amazon);
      renderTwinColumn(RR.MARKET.FLIPKART, latest.flipkart);

      renderAnalytics(filteredScans());
      renderCompete();
      renderReviews();
      await renderLog();
    } finally {
      busy = false;
    }
  }

  // ---------------- wiring ----------------
  function wire() {
    $('btn-toggle').addEventListener('click', async () => {
      const running = $('btn-toggle').dataset.running === 'true';
      await send({ type: running ? RR.MSG.STOP : RR.MSG.START });
      loadAndRender();
    });
    $('btn-scan-now').addEventListener('click', async () => {
      await send({ type: RR.MSG.SCAN_NOW });
      setTimeout(loadAndRender, 400);
    });
    $('btn-reviews-now').addEventListener('click', async () => {
      await send({ type: RR.MSG.REVIEWS_NOW });
      setTimeout(loadAndRender, 400);
    });
    $('btn-refresh').addEventListener('click', loadAndRender);

    $('filter-market').addEventListener('change', (e) => { filters.market = e.target.value; renderAnalytics(filteredScans()); renderCompete(); renderReviews(); });
    $('filter-range').addEventListener('change', (e) => { filters.range = e.target.value; renderAnalytics(filteredScans()); renderCompete(); renderReviews(); });

    // SoV mode toggle (Sponsored | Organic | Overall) — re-renders every SoV
    // widget in both analytics sections with the matching definition.
    const modeGroup = $('sov-mode');
    if (modeGroup) {
      modeGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        const mode = btn.dataset.mode;
        if (mode === sovMode) return;
        sovMode = mode;
        Array.from(modeGroup.querySelectorAll('button[data-mode]')).forEach((b) => {
          b.setAttribute('aria-pressed', b.dataset.mode === sovMode ? 'true' : 'false');
        });
        renderAnalytics(filteredScans());
        renderCompete();
      });
    }

    // Keyword-performance board: sort control + asc/desc toggle. Both persist
    // their choice in boardSortKey/boardSortDir and re-render the board only.
    const boardSort = $('kw-board-sort');
    if (boardSort) {
      boardSort.addEventListener('change', (e) => {
        boardSortKey = e.target.value;
        boardSortDir = (boardSortKey === 'keyword') ? 'asc' : 'desc';
        renderKeywordBoard(scopedScans());
      });
    }
    const boardDir = $('kw-board-dir');
    if (boardDir) {
      boardDir.addEventListener('click', () => {
        boardSortDir = boardSortDir === 'asc' ? 'desc' : 'asc';
        renderKeywordBoard(scopedScans());
      });
    }

    // Keyword sheet upload: button opens the hidden file input; change parses it.
    const uploadBtn = $('btn-upload-kw');
    const fileInput = $('kw-file');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        handleKeywordFile(f);
        fileInput.value = ''; // allow re-selecting the same file
      });
    }

    // Search-terms chips input: Enter or comma/semicolon adds; blur with text
    // commits. Enter never submits the page. Removal is only via the × button
    // (no destructive Backspace shortcut that could delete a saved term).
    const kwInput = $('kw-input');
    if (kwInput) {
      kwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitInput();
        } else if (e.key === ',' || e.key === ';') {
          // commit immediately on the separator so chips appear as you type
          e.preventDefault();
          commitInput();
        }
      });
      kwInput.addEventListener('blur', () => { if (kwInput.value.trim()) commitInput(); });
    }
    $('filter-rev-brand').addEventListener('change', (e) => { filters.revBrand = e.target.value; renderReviews(); });

    $('btn-export').addEventListener('click', () => {
      const csv = RR.csv.placementsToCSV(filteredScans());
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      RR.csv.download('rivalry-radar-' + ts + '.csv', csv);
    });
    $('btn-export-analytics').addEventListener('click', () => {
      const rows = analyticsExportRows();
      const headers = ['mode', 'brand', 'class', 'weightedSoVPct', 'plainSoVPct', 'avgPosition', 'appearances', 'timesFirst'];
      const csv = RR.csv.toCSV(rows, headers);
      const iso = new Date().toISOString().replace(/[:.]/g, '-');
      RR.csv.download('rivalry-radar-analytics-' + iso + '.csv', csv);
    });
    $('btn-export-reviews').addEventListener('click', () => {
      const csv = RR.csv.reviewsToCSV(filteredReviews());
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      RR.csv.download('rivalry-radar-reviews-' + ts + '.csv', csv);
    });

    // worker broadcasts -> re-read storage
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === RR.MSG.STATE_CHANGED) loadAndRender();
      });
    } catch (e) { /* not in extension context */ }

    // cheap periodic re-read
    setInterval(loadAndRender, 5000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    loadAndRender();
  });
})();
