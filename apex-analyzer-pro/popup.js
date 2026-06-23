/* ============================================================================
   Apex Analyzer Pro - UI controller
   Wires the (back-tested) ApexEngine to the interface: data loading, every
   analysis pane, the configurable pivot with heatmap + drill-down, and exports.
   No emoji / icon glyphs are produced anywhere by this file.
   ========================================================================== */
(function () {
  'use strict';
  var E = window.ApexEngine;

  var STATE = {
    workbook: null,
    sheetName: '',
    raw: [],
    rows: [],        // normalized
    clean: [],       // analysis set
    dropped: 0,
    currency: 'INR',
    pivot: null,     // last pivot result (for drill-down + export)
    drillRows: [],   // rows currently shown in drawer
    sql: [],         // last SQL output
    aiReport: '',
    alerts: null     // last alert scan
  };

  // chrome.* shim so notification settings persist whether the tool is loaded as
  // an extension or opened as a plain page (preview / file://).
  var hasChromeStorage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
  var store = {
    get: function (key, cb) {
      if (hasChromeStorage) chrome.storage.local.get([key], function (res) { cb(res[key]); });
      else { try { cb(JSON.parse(localStorage.getItem('apexpro_' + key) || 'null')); } catch (e) { cb(null); } }
    },
    set: function (key, val) {
      if (hasChromeStorage) { var o = {}; o[key] = val; chrome.storage.local.set(o); }
      else { try { localStorage.setItem('apexpro_' + key, JSON.stringify(val)); } catch (e) { /* ignore */ } }
    }
  };

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function nfIN(n) { try { return n.toLocaleString('en-IN'); } catch (e) { return String(n); } }
  function money(v) { if (v == null || isNaN(v)) return ''; return '₹' + nfIN(Math.round(v)); }
  function intf(v) { if (v == null || isNaN(v)) return ''; return nfIN(Math.round(v)); }
  function pct01(v) { if (v == null || isNaN(v)) return ''; return (v * 100).toFixed(1) + '%'; }
  function pctRaw(v) { if (v == null || isNaN(v)) return ''; return (Math.round(v * 10) / 10) + '%'; }
  function rating(v) { if (v == null || isNaN(v)) return ''; return v.toFixed(2); }
  function numf(v) { if (v == null || isNaN(v)) return ''; return nfIN(Math.round(v * 100) / 100); }

  function fmtByType(v, type) {
    switch (type) {
      case 'currency': return money(v);
      case 'int': return intf(v);
      case 'pct01': return pct01(v);
      case 'pctRaw': return pctRaw(v);
      case 'rating': return rating(v);
      case 'num': return numf(v);
      default: return v == null ? '' : String(v);
    }
  }
  // Map an engine measure fmt -> our cell formatter type
  function measureFmtType(fmt) {
    return fmt === 'currency' ? 'currency' : fmt === 'percent' ? 'pctRaw'
         : fmt === 'rating' ? 'rating' : fmt === 'int' ? 'int' : 'num';
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function emptyMsg(text) { var d = el('div', 'empty', text); return d; }

  // ---------------------------------------------------------------------------
  // Generic sortable table
  // columns: [{key,label,type,get(row),cls}]   rows: [obj]
  // opts: {sortKey, sortDir, totalRow:obj, rowClass(row), cellTitle(row,col)}
  // ---------------------------------------------------------------------------
  function renderTable(wrap, columns, rows, opts) {
    opts = opts || {};
    var state = { key: opts.sortKey || null, dir: opts.sortDir || 'desc' };

    function draw() {
      clear(wrap);
      if (!rows.length) { wrap.appendChild(emptyMsg(opts.emptyText || 'No rows.')); return; }
      var sorted = rows.slice();
      if (state.key) {
        var col = colByKey(state.key);
        sorted.sort(function (a, b) {
          var va = col.get(a), vb = col.get(b);
          if (va == null) return 1; if (vb == null) return -1;
          if (typeof va === 'number' && typeof vb === 'number') return state.dir === 'asc' ? va - vb : vb - va;
          return state.dir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        });
      }
      var table = el('table', 'grid');
      var thead = el('thead'), htr = el('tr');
      columns.forEach(function (c) {
        var isNum = c.type && c.type !== 'text';
        var th = el('th', (isNum ? 'num ' : '') + (c.sortable === false ? '' : 'sortable'));
        th.appendChild(document.createTextNode(c.label));
        if (state.key === c.key) { var m = el('span', 'sort-mark', state.dir === 'asc' ? 'asc' : 'desc'); th.appendChild(m); }
        if (c.sortable !== false) th.addEventListener('click', function () {
          if (state.key === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else { state.key = c.key; state.dir = isNum ? 'desc' : 'asc'; }
          draw();
        });
        htr.appendChild(th);
      });
      thead.appendChild(htr); table.appendChild(thead);
      var tb = el('tbody');
      sorted.forEach(function (r) {
        var tr = el('tr');
        if (opts.rowClass) { var rc = opts.rowClass(r); if (rc) tr.className = rc; }
        columns.forEach(function (c) {
          var isNum = c.type && c.type !== 'text';
          var td = el('td', isNum ? 'num' : (c.cls || ''));
          var val = c.get(r);
          if (c.render) { var node = c.render(r, val); if (node instanceof Node) td.appendChild(node); else td.textContent = node == null ? '' : String(node); }
          else td.textContent = fmtByType(val, c.type);
          if (opts.cellTitle) { var t = opts.cellTitle(r, c); if (t) td.title = t; }
          if (c.colorVsAvg && typeof val === 'number' && opts.avgFor) {
            var avg = opts.avgFor(c.key); if (avg != null) td.classList.add(val < avg ? 'pos' : (val > avg ? 'neg' : ''));
          }
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      if (opts.totalRow) {
        var tr2 = el('tr', 'total-row');
        columns.forEach(function (c, i) {
          var isNum = c.type && c.type !== 'text';
          var td = el('td', isNum ? 'num' : '');
          if (i === 0 && opts.totalRow.__label) td.textContent = opts.totalRow.__label;
          else { var v = c.get(opts.totalRow); td.textContent = v == null ? '' : fmtByType(v, c.type); }
          tr2.appendChild(td);
        });
        tb.appendChild(tr2);
      }
      table.appendChild(tb);
      wrap.appendChild(table);
    }
    function colByKey(k) { for (var i = 0; i < columns.length; i++) if (columns[i].key === k) return columns[i]; return columns[0]; }
    draw();
  }

  // ---------------------------------------------------------------------------
  // Select helpers
  // ---------------------------------------------------------------------------
  function fillSelect(sel, items, opts) {
    opts = opts || {};
    clear(sel);
    if (opts.noneLabel) sel.appendChild(new Option(opts.noneLabel, '__none'));
    if (opts.allLabel) sel.appendChild(new Option(opts.allLabel, 'All'));
    items.forEach(function (it) {
      var v = (typeof it === 'object') ? it.value : it;
      var l = (typeof it === 'object') ? it.label : it;
      sel.appendChild(new Option(l, v));
    });
    if (opts.value != null) sel.value = opts.value;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  function chooseSheet(workbook) {
    var names = workbook.SheetNames;
    var preferred = names.find(function (n) { return /consolidated/i.test(n); })
                 || names.find(function (n) { return /data|product|listing/i.test(n); });
    if (preferred) return preferred;
    // else the sheet with the most rows
    var best = names[0], bestRows = -1;
    names.forEach(function (n) {
      var ref = workbook.Sheets[n] && workbook.Sheets[n]['!ref'];
      if (!ref) return;
      var m = ref.match(/:[A-Z]+(\d+)/); var rows = m ? parseInt(m[1], 10) : 0;
      if (rows > bestRows) { bestRows = rows; best = n; }
    });
    return best;
  }

  // Ingest an array of raw row objects (keyed by source header). Shared by the
  // file loader and the programmatic automation hook (window.ApexAnalyzerPro).
  function ingestRows(json, sheetName) {
    if (!json || !json.length) throw new Error('No data rows to ingest.');
    STATE.sheetName = sheetName || '(data)';
    STATE.raw = json;
    STATE.rows = E.normalizeRows(json);
    var c = E.cleanRows(STATE.rows);
    STATE.clean = c.clean;
    STATE.dropped = c.dropped;
    // Drop any report generated from a previous dataset so the email/webhook
    // never ships a stale AI report against fresh data.
    STATE.aiReport = '';
    STATE.alerts = null;
    var rep = document.getElementById('aiReport'); if (rep) { rep.innerHTML = ''; rep.classList.add('hidden'); }
    var cur = '';
    for (var i = 0; i < STATE.clean.length && !cur; i++) if (STATE.clean[i].currency) cur = STATE.clean[i].currency;
    STATE.currency = cur || 'INR';
    refreshAll();
  }

  function loadSheet(name) {
    var ws = STATE.workbook.Sheets[name];
    if (!ws) throw new Error('Sheet "' + name + '" not found.');
    var json = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!json.length) throw new Error('Sheet "' + name + '" has no data rows.');
    ingestRows(json, name);
  }

  function handleFile(file) {
    $('datasetStat').textContent = 'Reading ' + file.name + ' ...';
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var data = new Uint8Array(ev.target.result);
        STATE.workbook = XLSX.read(data, { type: 'array' });
        var name = chooseSheet(STATE.workbook);
        $('sheetBtn').disabled = STATE.workbook.SheetNames.length < 2;
        loadSheet(name);
      } catch (err) {
        $('datasetStat').textContent = 'Failed to read file';
        alert('Could not read the file:\n' + (err && err.message ? err.message : err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function cycleSheet() {
    if (!STATE.workbook) return;
    var names = STATE.workbook.SheetNames;
    var i = names.indexOf(STATE.sheetName);
    var next = names[(i + 1) % names.length];
    try { loadSheet(next); } catch (err) { alert(err.message); }
  }

  // ---------------------------------------------------------------------------
  // Refresh everything after data changes
  // ---------------------------------------------------------------------------
  function refreshAll() {
    var stat = $('datasetStat');
    stat.innerHTML = '<strong>' + nfIN(STATE.clean.length) + '</strong> rows'
      + '<span class="sep">|</span> sheet <strong>' + escapeHtml(STATE.sheetName) + '</strong>'
      + '<span class="sep">|</span> <strong>' + E.distinctValues(STATE.clean, 'brand').length + '</strong> brands'
      + '<span class="sep">|</span> <strong>' + E.distinctDates(STATE.clean).length + '</strong> dates'
      + (STATE.dropped ? '<span class="sep">|</span> ' + STATE.dropped + ' dropped' : '');

    populateDataDrivenSelects();
    renderOverview();
    renderPivot();
    renderMatrix();
    renderTrends();
    renderAvsB();
    renderSqlSchema();
    renderAiControls();
    renderAlerts();
  }

  function populateDataDrivenSelects() {
    var dates = E.distinctDates(STATE.clean);
    var brands = E.distinctValues(STATE.clean, 'brand');
    var types = E.distinctValues(STATE.clean, 'type');
    var sizes = E.distinctValues(STATE.clean, 'size');
    var latest = E.latestSnapshot(STATE.clean) || (dates.length ? dates[dates.length - 1] : '');
    var platforms = E.distinctValues(STATE.clean, 'platform');
    var thicknesses = E.distinctValues(STATE.clean, 'thickness');
    var lengths = E.distinctValues(STATE.clean, 'length');
    var breadths = E.distinctValues(STATE.clean, 'breadth');
    var heights = E.distinctValues(STATE.clean, 'height');

    // Overview snapshot + filters
    fillSelect($('ovSnapshot'), dates, { allLabel: 'All snapshots', value: latest || 'All' });
    fillSelect($('ovPlatform'), platforms, { allLabel: 'All platforms', value: 'All' });
    fillSelect($('ovType'), types, { allLabel: 'All types', value: 'All' });

    // Trends snapshot A/B
    fillSelect($('ttDateA'), dates, { value: dates.length >= 2 ? dates[dates.length - 2] : dates[0] });
    fillSelect($('ttDateB'), dates, { value: latest });

    // A vs B
    fillSelect($('abBrandA'), brands, { value: brands[0] });
    fillSelect($('abBrandB'), brands, { value: brands[1] || brands[0] });
    fillSelect($('abType'), types, { allLabel: 'All types', value: 'All' });
    fillSelect($('abSize'), sizes, { allLabel: 'All sizes', value: 'All' });
    fillSelect($('abPlatform'), platforms, { allLabel: 'All platforms', value: 'All' });
    fillSelect($('abThickness'), thicknesses, { allLabel: 'All', value: 'All' });
    fillSelect($('abLength'), lengths, { allLabel: 'All', value: 'All' });
    fillSelect($('abBreadth'), breadths, { allLabel: 'All', value: 'All' });
    fillSelect($('abHeight'), heights, { allLabel: 'All', value: 'All' });
    fillSelect($('abDate'), dates, { allLabel: 'All snapshots', value: latest || 'All' });

    // AI anchor
    fillSelect($('aiAnchor'), brands, { value: brands.indexOf('Sleepwell') >= 0 ? 'Sleepwell' : brands[0] });

    // Pivot filters (curated)
    buildPivotFilters(dates, brands, types, sizes);
    // Trends filters
    buildTrendFilters(platforms, types, sizes, lengths, breadths, heights);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===========================================================================
  // OVERVIEW
  // ===========================================================================
  function snapshotData(date) {
    if (!date || date === 'All') return STATE.clean;
    return STATE.clean.filter(function (r) { return r.scrapeDate === date; });
  }

  function overviewData() {
    var date = $('ovSnapshot').value;
    var platform = $('ovPlatform') ? $('ovPlatform').value : 'All';
    var type = $('ovType') ? $('ovType').value : 'All';
    return snapshotData(date).filter(function (r) {
      if (platform !== 'All' && r.platform !== platform) return false;
      if (type !== 'All' && r.type !== type) return false;
      return true;
    });
  }

  function renderOverview() {
    if (!STATE.clean.length) return;
    var date = $('ovSnapshot').value;
    var data = overviewData();
    var k = E.computeKpis(data);

    var tiles = [
      { l: 'Listings' + (date !== 'All' ? ' (snapshot)' : ''), v: nfIN(k.rows) },
      { l: 'Brands tracked', v: k.brands },
      { l: 'Platforms', v: k.platforms },
      { l: 'Crawl dates (all)', v: E.distinctDates(STATE.clean).length },
      { l: 'Avg active price', v: money(k.avgPrice) },
      { l: 'Avg star rating', v: rating(k.avgRating) },
      { l: 'Avg discount', v: pctRaw(k.avgDiscount) },
      { l: 'In stock', v: pct01(k.inStockPct) }
    ];
    var grid = $('kpiGrid'); clear(grid);
    tiles.forEach(function (t) {
      var c = el('div', 'kpi');
      c.appendChild(el('div', 'k-label', t.l));
      c.appendChild(el('div', 'k-value', String(t.v)));
      grid.appendChild(c);
    });

    // Brand leaderboard (with Bestseller-Rank ranking stats)
    var bsum = E.groupSummary(data, 'brand');
    renderTable($('brandTableWrap'), [
      { key: 'key', label: 'Brand', type: 'text', get: function (r) { return r.key; } },
      { key: 'count', label: 'Models', type: 'int', get: function (r) { return r.count; } },
      { key: 'avgPrice', label: 'Avg Price', type: 'currency', get: function (r) { return r.avgPrice; } },
      { key: 'avgRating', label: 'Avg Rating', type: 'rating', get: function (r) { return r.avgRating; } },
      { key: 'pctInStock', label: 'In Stock', type: 'pct01', get: function (r) { return r.pctInStock; } },
      { key: 'avgDiscount', label: 'Avg Disc', type: 'pctRaw', get: function (r) { return r.avgDiscount; } },
      { key: 'avgRank', label: 'Avg Rank', type: 'int', get: function (r) { return r.avgRank; },
        render: function (r, v) { return v == null ? '-' : intf(v); } },
      { key: 'bestRank', label: 'Top Rank', type: 'int', get: function (r) { return r.bestRank; },
        render: function (r, v) { return v == null ? '-' : intf(v); } },
      { key: 'worstRank', label: 'Lowest Rank', type: 'int', get: function (r) { return r.worstRank; },
        render: function (r, v) { return v == null ? '-' : intf(v); } },
      { key: 'totalReviews', label: 'Reviews', type: 'int', get: function (r) { return r.totalReviews; } }
    ], bsum, { sortKey: 'count', sortDir: 'desc',
      cellTitle: function (r, c) {
        if (c.key === 'avgRank' || c.key === 'bestRank' || c.key === 'worstRank')
          return 'Bestseller Rank (lower = better). ' + (r.rankedCount || 0) + ' ranked listings.';
        return '';
      } });

    // Brand bars (avg price, top 10)
    var bars = $('brandBars'); clear(bars);
    var top = bsum.filter(function (b) { return b.avgPrice != null; }).slice().sort(function (a, b) { return b.avgPrice - a.avgPrice; }).slice(0, 10);
    var maxP = top.reduce(function (m, b) { return Math.max(m, b.avgPrice); }, 0) || 1;
    top.forEach(function (b) {
      var row = el('div', 'bar-row');
      row.appendChild(el('div', 'bl', b.key));
      var track = el('div', 'bar-track'); var fill = el('div', 'bar-fill');
      fill.style.width = Math.max(2, (b.avgPrice / maxP) * 100) + '%';
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el('div', 'bv', money(b.avgPrice)));
      bars.appendChild(row);
    });

    // Type table (Type Master replica)
    var tsum = E.groupSummary(data, 'type');
    var total = aggregateTotals(tsum);
    renderTable($('typeTableWrap'), [
      { key: 'key', label: 'Product Type', type: 'text', get: function (r) { return r.key; } },
      { key: 'count', label: 'Models', type: 'int', get: function (r) { return r.count; } },
      { key: 'pctInStock', label: '% In Stock', type: 'pct01', get: function (r) { return r.pctInStock; } },
      { key: 'prime', label: 'Prime/Assured', type: 'int', get: function (r) { return r.prime; } },
      { key: 'avgPrice', label: 'Avg Price', type: 'currency', get: function (r) { return r.avgPrice; } },
      { key: 'avgWow', label: 'Avg Best Price', type: 'currency', get: function (r) { return r.avgWow; } },
      { key: 'lowest', label: 'Lowest', type: 'currency', get: function (r) { return r.lowest; } },
      { key: 'avgDiscount', label: 'Avg Disc %', type: 'pctRaw', get: function (r) { return r.avgDiscount; } },
      { key: 'avgRating', label: 'Avg Rating', type: 'rating', get: function (r) { return r.avgRating; } },
      { key: 'totalReviews', label: 'Reviews', type: 'int', get: function (r) { return r.totalReviews; } }
    ], tsum, { sortKey: 'count', sortDir: 'desc', totalRow: total });
  }

  function aggregateTotals(summaryRows) {
    if (!summaryRows.length) return null;
    var count = 0, inStock = 0, prime = 0, reviews = 0, pSum = 0, pN = 0, rSum = 0, rN = 0, dSum = 0, dN = 0, lowest = null, wSum = 0, wN = 0;
    summaryRows.forEach(function (r) {
      count += r.count; inStock += r.inStock; prime += r.prime; reviews += r.totalReviews;
      if (r.avgPrice != null) { pSum += r.avgPrice * r.count; pN += r.count; }
      if (r.avgRating != null) { rSum += r.avgRating * r.count; rN += r.count; }
      if (r.avgDiscount != null) { dSum += r.avgDiscount * r.count; dN += r.count; }
      if (r.avgWow != null) { wSum += r.avgWow * r.count; wN += r.count; }
      if (r.lowest != null) lowest = lowest == null ? r.lowest : Math.min(lowest, r.lowest);
    });
    return {
      __label: 'ALL TYPES', count: count, pctInStock: count ? inStock / count : null, prime: prime,
      avgPrice: pN ? pSum / pN : null, avgWow: wN ? wSum / wN : null, lowest: lowest,
      avgDiscount: dN ? dSum / dN : null, avgRating: rN ? rSum / rN : null, totalReviews: reviews
    };
  }

  // ===========================================================================
  // PIVOT EXPLORER
  // ===========================================================================
  var PIVOT_FILTER_DIMS = ['scrapeDate', 'platform', 'brand', 'type', 'size', 'length', 'breadth', 'height'];
  var pivotFilterState = {};

  function dimOptions(includeNone) {
    var opts = E.DIMENSIONS.map(function (d) { return { value: d.key, label: d.label }; });
    return opts;
  }

  function initPivotControls() {
    var dims = dimOptions();
    fillSelect($('pvRow1'), dims, { value: 'brand' });
    fillSelect($('pvRow2'), dims, { noneLabel: '(none)', value: '__none' });
    fillSelect($('pvCol1'), dims, { value: 'scrapeDate' });
    fillSelect($('pvCol2'), dims, { noneLabel: '(none)', value: '__none' });
    fillSelect($('pvMeasure'), E.MEASURES.map(function (m) { return { value: m.key, label: m.label }; }), { value: 'price' });
    fillSelect($('pvAgg'), E.AGGS.map(function (a) { return { value: a.key, label: a.label }; }), { value: 'avg' });

    ['pvRow1', 'pvRow2', 'pvCol1', 'pvCol2', 'pvMeasure', 'pvAgg'].forEach(function (id) {
      $(id).addEventListener('change', renderPivot);
    });
    $('pvHeatmap').addEventListener('change', renderPivot);
    $('pvSubtotals').addEventListener('change', renderPivot);
    $('pvSwap').addEventListener('click', function () {
      var r1 = $('pvRow1').value, r2 = $('pvRow2').value, c1 = $('pvCol1').value, c2 = $('pvCol2').value;
      $('pvRow1').value = c1; $('pvRow2').value = c2; $('pvCol1').value = r1; $('pvCol2').value = r2;
      renderPivot();
    });
    $('pvReset').addEventListener('click', function () {
      $('pvRow1').value = 'brand'; $('pvRow2').value = '__none';
      $('pvCol1').value = 'scrapeDate'; $('pvCol2').value = '__none';
      $('pvMeasure').value = 'price'; $('pvAgg').value = 'avg';
      PIVOT_FILTER_DIMS.forEach(function (k) { pivotFilterState[k] = 'All'; var s = $('pvf_' + k); if (s) s.value = 'All'; });
      renderPivot();
    });
    $('pvExport').addEventListener('click', exportPivot);
  }

  function buildPivotFilters(dates, brands, types, sizes) {
    var host = $('pvFilters'); clear(host);
    var lookup = {
      scrapeDate: dates, platform: E.distinctValues(STATE.clean, 'platform'), brand: brands, type: types, size: sizes,
      length: E.distinctValues(STATE.clean, 'length'), breadth: E.distinctValues(STATE.clean, 'breadth'), height: E.distinctValues(STATE.clean, 'height')
    };
    PIVOT_FILTER_DIMS.forEach(function (key) {
      var dim = E.dimByKey(key);
      var lab = el('label', 'fld'); lab.appendChild(el('span', null, 'Filter: ' + dim.label));
      var sel = el('select', 'select'); sel.id = 'pvf_' + key;
      lab.appendChild(sel);
      fillSelect(sel, lookup[key] || [], { allLabel: 'All', value: pivotFilterState[key] || 'All' });
      sel.addEventListener('change', function () { pivotFilterState[key] = sel.value; renderPivot(); });
      pivotFilterState[key] = pivotFilterState[key] || 'All';
      host.appendChild(lab);
    });
  }

  function currentPivotConfig() {
    function v(id) { var x = $(id).value; return x === '__none' ? null : x; }
    var rows = [v('pvRow1'), v('pvRow2')].filter(Boolean);
    var cols = [v('pvCol1'), v('pvCol2')].filter(Boolean);
    var filters = {};
    PIVOT_FILTER_DIMS.forEach(function (k) { var val = pivotFilterState[k]; if (val && val !== 'All') filters[k] = [val]; });
    return {
      rows: rows, cols: cols, measure: $('pvMeasure').value, agg: $('pvAgg').value,
      filters: filters, includeRowSubtotals: $('pvSubtotals').checked
    };
  }

  function renderPivot() {
    var scroll = $('pivotScroll');
    if (!STATE.clean.length) { clear(scroll); scroll.appendChild(emptyMsg('Load a dataset to build a pivot.')); return; }
    var cfg = currentPivotConfig();
    var p = E.buildPivot(STATE.clean, cfg);
    STATE.pivot = p;
    var fmtType = p.agg === 'count' ? 'int' : measureFmtType(p.measure.fmt);
    var heat = $('pvHeatmap').checked;

    // Heatmap scale over detail cells (exclude subtotal/grand rows + total col)
    var lo = Infinity, hi = -Infinity;
    p.rows.forEach(function (r) {
      if (r.isSubtotal || r.isGrandTotal) return;
      p.leafCols.forEach(function (lc) {
        var v = r.cells[lc.colId].value;
        if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }

    function heatBg(v) {
      if (!heat || v == null || hi === lo) return '';
      var t = (v - lo) / (hi - lo);             // 0..1
      var light = 96 - Math.round(t * 26);       // 96% -> 70%
      return 'hsl(222 70% ' + light + '%)';
    }

    var table = el('table', 'pivot');
    var headCols = Math.max(1, p.rowFields.length);
    var thead = el('thead');
    var twoColLevels = p.colFields.length === 2;
    var hasTotalCol = p.colFields.length >= 1;

    var tr1 = el('tr');
    var corner = el('th', 'corner');
    corner.colSpan = headCols; if (twoColLevels) corner.rowSpan = 2;
    corner.textContent = p.rowFields.length ? p.rowFields.map(function (f) { return f.label; }).join('  /  ') : 'Total';
    tr1.appendChild(corner);

    if (p.colFields.length === 0) {
      var only = el('th'); only.textContent = p.measure.label; tr1.appendChild(only);
    } else if (p.colFields.length === 1) {
      p.leafCols.forEach(function (lc) { var th = el('th'); th.textContent = lc.label; tr1.appendChild(th); });
    } else {
      p.colTree.forEach(function (node) { var th = el('th'); th.colSpan = node.children.length; th.textContent = node.label; tr1.appendChild(th); });
    }
    if (hasTotalCol) { var tot = el('th', 'total-col'); tot.textContent = 'Total'; if (twoColLevels) tot.rowSpan = 2; tr1.appendChild(tot); }
    thead.appendChild(tr1);

    if (twoColLevels) {
      var tr2 = el('tr');
      p.colTree.forEach(function (node) { node.children.forEach(function (ch) { var th = el('th'); th.textContent = ch.label; tr2.appendChild(th); }); });
      thead.appendChild(tr2);
    }
    table.appendChild(thead);

    var tb = el('tbody');
    var prevL1 = null;
    p.rows.forEach(function (r) {
      var tr = el('tr');
      if (r.isGrandTotal) tr.className = 'grand';
      else if (r.isSubtotal) tr.className = 'subtotal';

      if (headCols === 1) {
        var rh = el('td', 'row-head'); rh.textContent = r.labels[0]; tr.appendChild(rh);
      } else {
        if (r.isGrandTotal || r.isSubtotal) {
          var rhc = el('td', 'row-head'); rhc.colSpan = 2; rhc.textContent = r.labels[0]; tr.appendChild(rhc);
          prevL1 = null;
        } else {
          var c1 = el('td', 'row-head'); c1.textContent = (r.labels[0] !== prevL1) ? r.labels[0] : '';
          prevL1 = r.labels[0];
          var c2 = el('td', 'row-head lvl1'); c2.textContent = r.labels[1] != null ? r.labels[1] : '';
          tr.appendChild(c1); tr.appendChild(c2);
        }
      }

      function valCell(cell, isTotalCol) {
        var td = el('td', 'val' + (isTotalCol ? ' total-col' : ''));
        var v = cell.value;
        if (v == null || (p.agg === 'count' && v === 0)) {
          td.classList.add('empty'); td.textContent = (p.agg === 'count') ? '0' : '·';
        } else {
          td.textContent = fmtByType(v, fmtType);
          if (!isTotalCol) { var bg = heatBg(v); if (bg) td.style.background = bg; }
          if (cell.count > 0) {
            td.setAttribute('data-cell', cell.cellId);
            td.title = cell.count + ' listing' + (cell.count === 1 ? '' : 's') + (cell.n != null && cell.n !== cell.count ? ' (' + cell.n + ' priced)' : '') + ' - click to drill in';
            td.addEventListener('click', function () { onDrill(r, cell, isTotalCol); });
          }
        }
        return td;
      }

      if (p.colFields.length === 0) {
        tr.appendChild(valCell(r.cells[p.leafCols[0].colId], false));
      } else {
        p.leafCols.forEach(function (lc) { tr.appendChild(valCell(r.cells[lc.colId], false)); });
        tr.appendChild(valCell(r.cells['__total'], true));
      }
      tb.appendChild(tr);
    });
    table.appendChild(tb);

    clear(scroll); scroll.appendChild(table);
    $('pvStat').textContent = nfIN(p.filteredCount) + ' rows in scope  |  '
      + p.rows.filter(function (r) { return !r.isSubtotal && !r.isGrandTotal; }).length + ' row groups  |  '
      + p.leafCols.length + ' columns';
  }

  function onDrill(row, cell, isTotalCol) {
    var idxs = STATE.pivot.drill[cell.cellId] || [];
    var rowLabel = row.labels.join(' / ');
    var measure = STATE.pivot.measure.label + ' (' + aggLabel(STATE.pivot.agg) + ')';
    var sub = rowLabel + (isTotalCol ? '  |  All columns' : '') + '  -  ' + measure + '  =  '
      + (cell.value == null ? 'n/a' : fmtByType(cell.value, STATE.pivot.agg === 'count' ? 'int' : measureFmtType(STATE.pivot.measure.fmt)));
    openDrawer('Drill-down  -  ' + cell.count + ' listings', sub, idxs);
  }
  function aggLabel(key) { var a = E.AGGS.filter(function (x) { return x.key === key; })[0]; return a ? a.label : key; }

  function exportPivot() {
    if (!STATE.pivot) return;
    var p = STATE.pivot;
    var header = [];
    p.rowFields.forEach(function (f) { header.push(f.label); });
    if (!p.rowFields.length) header.push('');
    p.leafCols.forEach(function (lc) {
      var name = lc.path && lc.path.length ? lc.path.join(' - ') : lc.label;
      header.push(name);
    });
    if (p.colFields.length >= 1) header.push('Total');
    var aoa = [header];
    p.rows.forEach(function (r) {
      var line = [];
      if (p.rowFields.length <= 1) line.push(r.labels[0]);
      else { line.push(r.isSubtotal || r.isGrandTotal ? r.labels[0] : r.labels[0]); line.push(r.isSubtotal || r.isGrandTotal ? '' : (r.labels[1] || '')); }
      p.leafCols.forEach(function (lc) { var v = r.cells[lc.colId].value; line.push(v == null ? '' : v); });
      if (p.colFields.length >= 1) line.push(r.cells['__total'].value == null ? '' : r.cells['__total'].value);
      aoa.push(line);
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Pivot');
    XLSX.writeFile(wb, 'apex_pivot_' + p.measure.key + '_' + p.agg + '.xlsx');
  }

  // ===========================================================================
  // DRILL-DOWN DRAWER
  // ===========================================================================
  function openDrawer(title, sub, idxList) {
    var rows = idxList.map(function (i) { return STATE.clean[i]; }).filter(Boolean);
    STATE.drillRows = rows;
    $('drawerTitle').textContent = title;
    $('drawerSub').textContent = sub;
    var body = $('drawerBody'); clear(body);
    renderTable(body, [
      { key: 'brand', label: 'Brand', type: 'text', get: function (r) { return r.brand; } },
      { key: 'title', label: 'Title', type: 'text', get: function (r) { return r.title; },
        render: function (r, v) { var s = String(v || ''); return s.length > 70 ? s.slice(0, 70) + '...' : s; } },
      { key: 'platform', label: 'Platform', type: 'text', get: function (r) { return r.platform; } },
      { key: 'type', label: 'Type', type: 'text', get: function (r) { return r.type; } },
      { key: 'size', label: 'Size', type: 'text', get: function (r) { return r.size; } },
      { key: 'price', label: 'Active', type: 'currency', get: function (r) { return r.price; } },
      { key: 'wow', label: 'Best/Wow', type: 'currency', get: function (r) { return r.wow; } },
      { key: 'mrp', label: 'MRP', type: 'currency', get: function (r) { return r.mrp; } },
      { key: 'discount', label: 'Disc %', type: 'pctRaw', get: function (r) { return r.discount; } },
      { key: 'rating', label: 'Rating', type: 'rating', get: function (r) { return r.rating; } },
      { key: 'reviews', label: 'Reviews', type: 'int', get: function (r) { return r.reviews; } },
      { key: 'inStock', label: 'Stock', type: 'text', get: function (r) { return r.inStock; } },
      { key: 'scrapeDate', label: 'Date', type: 'text', get: function (r) { return r.scrapeDate || '(blank)'; } },
      { key: 'url', label: 'Link', type: 'text', sortable: false, get: function (r) { return r.url; },
        render: function (r, v) { if (!v) return ''; var a = el('a', null, 'open'); a.href = v; a.target = '_blank'; a.rel = 'noopener'; return a; } }
    ], rows, { sortKey: 'price', sortDir: 'asc', cellTitle: function (r, c) { return c.key === 'title' ? r.title : ''; } });
    $('drawerMask').classList.add('open');
    $('drawer').classList.add('open');
  }
  function closeDrawer() { $('drawerMask').classList.remove('open'); $('drawer').classList.remove('open'); }
  function exportDrill() {
    if (!STATE.drillRows.length) return;
    var rows = STATE.drillRows.map(flattenRow);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Drill-down');
    XLSX.writeFile(wb, 'apex_drilldown_' + Date.now() + '.xlsx');
  }
  function flattenRow(r) {
    return {
      Brand: r.brand, Title: r.title, Platform: r.platform, 'Product Type': r.type, Size: r.size,
      'Thickness (in)': r.thickness, Dimensions: r.dim, 'Active Price': r.price, 'Best/Wow Price': r.wow,
      MRP: r.mrp, 'Discount %': r.discount, Rating: r.rating, Reviews: r.reviews, Availability: r.inStock,
      'Prime/Assured': r.prime, Seller: r.seller, Warranty: r.warranty, 'Scrape Date': r.scrapeDate,
      'Product ID': r.pid, URL: r.url
    };
  }

  // ===========================================================================
  // COMPETITIVE MATRIX
  // ===========================================================================
  var MATRIX_DIMS = ['scrapeDate', 'type', 'size', 'thickness', 'platform', 'length', 'breadth', 'height'];
  var matrixState = {};

  function renderMatrixControls() {
    var host = $('matrixFilters'); clear(host);
    var lookup = {
      scrapeDate: E.distinctDates(STATE.clean), type: E.distinctValues(STATE.clean, 'type'),
      size: E.distinctValues(STATE.clean, 'size'), thickness: E.distinctValues(STATE.clean, 'thickness'),
      platform: E.distinctValues(STATE.clean, 'platform'), length: E.distinctValues(STATE.clean, 'length'),
      breadth: E.distinctValues(STATE.clean, 'breadth'), height: E.distinctValues(STATE.clean, 'height')
    };
    var latest = E.latestSnapshot(STATE.clean);
    var defaults = {
      scrapeDate: latest || 'All',
      type: pickCommon(E.groupSummary(snapshotData(latest), 'type')),
      size: (lookup.size.indexOf('King') >= 0 ? 'King' : 'All'),
      thickness: 'All', platform: 'All', length: 'All', breadth: 'All', height: 'All'
    };
    MATRIX_DIMS.forEach(function (key) {
      var dim = E.dimByKey(key);
      var lab = el('label', 'fld'); lab.appendChild(el('span', null, dim.label));
      var sel = el('select', 'select'); sel.id = 'mxf_' + key;
      lab.appendChild(sel);
      var val = matrixState[key] || defaults[key] || 'All';
      fillSelect(sel, lookup[key] || [], { allLabel: 'All', value: val });
      matrixState[key] = sel.value;
      sel.addEventListener('change', function () { matrixState[key] = sel.value; renderMatrix(); });
      host.appendChild(lab);
    });
  }
  function pickCommon(summary) { return summary.length ? summary[0].key : 'All'; }

  function renderMatrix() {
    if (!STATE.clean.length) return;
    if (!$('mxf_type')) renderMatrixControls();
    var filters = {};
    MATRIX_DIMS.forEach(function (k) { var v = matrixState[k]; if (v && v !== 'All') filters[k] = [v]; });
    var data = E.applyFilters(STATE.clean, filters);

    // summary chips
    var prices = data.map(function (r) { return r.price; }).filter(function (v) { return v != null && v > 0; });
    var avg = prices.length ? prices.reduce(function (s, v) { return s + v; }, 0) / prices.length : null;
    var cheapest = data.filter(function (r) { return r.price != null && r.price > 0; }).sort(function (a, b) { return a.price - b.price; })[0];
    var brands = E.distinctValues(data, 'brand');
    var chips = $('matrixSummary'); clear(chips);
    [
      data.length + ' listings', brands.length + ' brands',
      'market avg ' + (avg != null ? money(avg) : 'n/a'),
      cheapest ? 'cheapest ' + money(cheapest.price) + ' (' + cheapest.brand + ')' : 'no priced rows'
    ].forEach(function (t) { var c = el('span', 'chip on', t); chips.appendChild(c); });

    var wrap = $('matrixTableWrap');
    if (!data.length) { clear(wrap); wrap.appendChild(emptyMsg('No listings match this specification bucket. Loosen a filter.')); return; }

    renderTable(wrap, [
      { key: 'brand', label: 'Brand', type: 'text', get: function (r) { return r.brand; } },
      { key: 'title', label: 'Title', type: 'text', get: function (r) { return r.title; },
        render: function (r, v) { var s = String(v || ''); return s.length > 60 ? s.slice(0, 60) + '...' : s; } },
      { key: 'platform', label: 'Platform', type: 'text', get: function (r) { return r.platform; } },
      { key: 'price', label: 'Active Price', type: 'currency', get: function (r) { return r.price; }, colorVsAvg: true },
      { key: 'vsAvg', label: 'vs Mkt Avg', type: 'currency', get: function (r) { return (r.price != null && avg != null) ? r.price - avg : null; },
        render: function (r, v) { if (v == null) return ''; var span = el('span', v < 0 ? 'pos' : (v > 0 ? 'neg' : '')); span.textContent = (v > 0 ? '+' : '') + money(v); return span; } },
      { key: 'wow', label: 'Best/Wow', type: 'currency', get: function (r) { return r.wow; } },
      { key: 'mrp', label: 'MRP', type: 'currency', get: function (r) { return r.mrp; } },
      { key: 'discount', label: 'Disc %', type: 'pctRaw', get: function (r) { return r.discount; } },
      { key: 'rating', label: 'Rating', type: 'rating', get: function (r) { return r.rating; } },
      { key: 'reviews', label: 'Reviews', type: 'int', get: function (r) { return r.reviews; } },
      { key: 'inStock', label: 'Stock', type: 'text', get: function (r) { return r.inStock; } },
      { key: 'url', label: 'Link', type: 'text', sortable: false, get: function (r) { return r.url; },
        render: function (r, v) { if (!v) return ''; var a = el('a', null, 'Open listing'); a.href = v; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; } }
    ], data, { sortKey: 'price', sortDir: 'asc', avgFor: function (k) { return k === 'price' ? avg : null; },
      cellTitle: function (r, c) { return c.key === 'title' ? r.title : (c.key === 'url' ? r.url : ''); } });

    STATE.matrixData = data;
  }

  function exportMatrix() {
    if (!STATE.matrixData || !STATE.matrixData.length) return;
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(STATE.matrixData.map(flattenRow)), 'Matrix');
    XLSX.writeFile(wb, 'apex_matrix_' + Date.now() + '.xlsx');
  }

  // ===========================================================================
  // TRENDS
  // ===========================================================================
  var TREND_FILTER_DIMS = ['platform', 'type', 'size', 'length', 'breadth', 'height'];
  var trendFilterState = {};

  function buildTrendFilters(platforms, types, sizes, lengths, breadths, heights) {
    var host = $('trFilters'); if (!host) return; clear(host);
    var lookup = { platform: platforms, type: types, size: sizes, length: lengths, breadth: breadths, height: heights };
    TREND_FILTER_DIMS.forEach(function (key) {
      var dim = E.dimByKey(key);
      var lab = el('label', 'fld'); lab.appendChild(el('span', null, 'Filter: ' + dim.label));
      var sel = el('select', 'select'); sel.id = 'trf_' + key; lab.appendChild(sel);
      fillSelect(sel, lookup[key] || [], { allLabel: 'All', value: trendFilterState[key] || 'All' });
      trendFilterState[key] = sel.value;
      sel.addEventListener('change', function () { trendFilterState[key] = sel.value; renderTrends(); });
      host.appendChild(lab);
    });
  }
  function trendFilters() {
    var f = {}; TREND_FILTER_DIMS.forEach(function (k) { var v = trendFilterState[k]; if (v && v !== 'All') f[k] = [v]; }); return f;
  }

  function initTrendControls() {
    fillSelect($('trDim'), E.DIMENSIONS.map(function (d) { return { value: d.key, label: d.label }; }), { value: 'brand' });
    fillSelect($('trMeasure'), E.MEASURES.map(function (m) { return { value: m.key, label: m.label }; }), { value: 'price' });
    fillSelect($('trAgg'), E.AGGS.map(function (a) { return { value: a.key, label: a.label }; }), { value: 'avg' });
    ['trDim', 'trMeasure', 'trAgg'].forEach(function (id) { $(id).addEventListener('change', renderTrends); });
    $('ttDateA').addEventListener('change', renderTimeTravel);
    $('ttDateB').addEventListener('change', renderTimeTravel);
    $('ttExport').addEventListener('click', exportTimeTravel);
  }

  function renderTrends() {
    if (!STATE.clean.length) return;
    var base = E.applyFilters(STATE.clean, trendFilters());
    var measureKey = $('trMeasure').value, agg = $('trAgg').value, dimKey = $('trDim').value;
    var p = E.buildPivot(base, { rows: [dimKey], cols: ['scrapeDate'], measure: measureKey, agg: agg, includeRowSubtotals: false });
    var fmtType = agg === 'count' ? 'int' : measureFmtType(p.measure.fmt);
    var dateCols = p.leafCols.filter(function (c) { return c.label !== '(blank)'; });

    var columns = [{ key: 'dim', label: E.dimByKey(dimKey).label, type: 'text', get: function (r) { return r.dim; } }];
    dateCols.forEach(function (dc) {
      columns.push({ key: dc.colId, label: dc.label, type: fmtType, get: function (r) { return r.vals[dc.colId]; } });
    });
    columns.push({ key: 'delta', label: 'First to last', type: fmtType, get: function (r) { return r.delta; },
      render: function (r, v) { if (v == null) return ''; var span = el('span', v < 0 ? 'pos' : (v > 0 ? 'neg' : '')); span.textContent = (v > 0 ? '+' : '') + fmtByType(v, fmtType); return span; } });

    var rows = p.rows.filter(function (r) { return !r.isSubtotal && !r.isGrandTotal; }).map(function (r) {
      var vals = {}; dateCols.forEach(function (dc) { vals[dc.colId] = r.cells[dc.colId].value; });
      var first = null, last = null;
      dateCols.forEach(function (dc) { var v = r.cells[dc.colId].value; if (v != null) { if (first == null) first = v; last = v; } });
      return { dim: r.labels[0], vals: vals, delta: (first != null && last != null) ? last - first : null };
    });
    renderTable($('trendTableWrap'), columns, rows, { sortKey: 'delta', sortDir: 'desc' });
    renderTimeTravel();
  }

  function renderTimeTravel() {
    if (!STATE.clean.length) return;
    var dA = $('ttDateA').value, dB = $('ttDateB').value;
    var wrap = $('ttTableWrap');
    if (!dA || !dB || dA === dB) { clear(wrap); wrap.appendChild(emptyMsg('Select two different snapshots.')); STATE.ttRows = []; return; }
    var tf = trendFilters();
    var mapA = indexByProduct(E.applyFilters(snapshotData(dA), tf));
    var mapB = indexByProduct(E.applyFilters(snapshotData(dB), tf));
    var rows = [];
    Object.keys(mapA).forEach(function (key) {
      if (!mapB[key]) return;
      var a = mapA[key], b = mapB[key];
      var pA = a.price, pB = b.price, rA = a.rating, rB = b.rating;
      rows.push({
        brand: b.brand, title: b.title, platform: b.platform,
        priceA: pA, priceB: pB, dPrice: (pA != null && pB != null) ? pB - pA : null,
        ratingA: rA, ratingB: rB, dRating: (rA != null && rB != null) ? Math.round((rB - rA) * 100) / 100 : null,
        url: b.url
      });
    });
    STATE.ttRows = rows;
    if (!rows.length) { clear(wrap); wrap.appendChild(emptyMsg('No products matched across the two snapshots (matched by product ID).')); return; }
    renderTable(wrap, [
      { key: 'brand', label: 'Brand', type: 'text', get: function (r) { return r.brand; } },
      { key: 'title', label: 'Title', type: 'text', get: function (r) { return r.title; },
        render: function (r, v) { var s = String(v || ''); return s.length > 54 ? s.slice(0, 54) + '...' : s; } },
      { key: 'platform', label: 'Platform', type: 'text', get: function (r) { return r.platform; } },
      { key: 'priceA', label: 'Price A', type: 'currency', get: function (r) { return r.priceA; } },
      { key: 'priceB', label: 'Price B', type: 'currency', get: function (r) { return r.priceB; } },
      { key: 'dPrice', label: 'Price move', type: 'currency', get: function (r) { return r.dPrice; },
        render: function (r, v) { if (v == null) return ''; var s = el('span', v < 0 ? 'pos' : (v > 0 ? 'neg' : '')); s.textContent = (v > 0 ? '+' : '') + money(v); return s; } },
      { key: 'ratingA', label: 'Rating A', type: 'rating', get: function (r) { return r.ratingA; } },
      { key: 'ratingB', label: 'Rating B', type: 'rating', get: function (r) { return r.ratingB; } },
      { key: 'dRating', label: 'Rating move', type: 'rating', get: function (r) { return r.dRating; },
        render: function (r, v) { if (v == null) return ''; var s = el('span', v > 0 ? 'pos' : (v < 0 ? 'neg' : '')); s.textContent = (v > 0 ? '+' : '') + v.toFixed(2); return s; } }
    ], rows, { sortKey: 'dPrice', sortDir: 'asc' });
  }

  function indexByProduct(list) {
    var map = {};
    list.forEach(function (r) {
      var key = r.pid && r.pid.trim() ? r.pid.trim() : (r.url && r.url.trim() ? r.url.trim() : r.title);
      if (key && !map[key]) map[key] = r;
    });
    return map;
  }

  function exportTimeTravel() {
    if (!STATE.ttRows || !STATE.ttRows.length) return;
    var dA = $('ttDateA').value, dB = $('ttDateB').value;
    var rows = STATE.ttRows.map(function (r) {
      return { Brand: r.brand, Title: r.title, Platform: r.platform, ['Price ' + dA]: r.priceA, ['Price ' + dB]: r.priceB,
        'Price Move': r.dPrice, ['Rating ' + dA]: r.ratingA, ['Rating ' + dB]: r.ratingB, 'Rating Move': r.dRating, URL: r.url };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Snapshot Compare');
    XLSX.writeFile(wb, 'apex_snapshot_compare_' + dA + '_vs_' + dB + '.xlsx');
  }

  // ===========================================================================
  // A vs B COMPARE
  // ===========================================================================
  function initAvsBControls() {
    ['abBrandA', 'abBrandB', 'abType', 'abSize', 'abPlatform', 'abThickness', 'abLength', 'abBreadth', 'abHeight', 'abDate']
      .forEach(function (id) { $(id).addEventListener('change', renderAvsB); });
  }

  function abOpts() {
    return {
      type: $('abType').value, size: $('abSize').value, date: $('abDate').value,
      platform: $('abPlatform').value, thickness: $('abThickness').value,
      length: $('abLength').value, breadth: $('abBreadth').value, height: $('abHeight').value
    };
  }

  function renderAvsB() {
    if (!STATE.clean.length) return;
    var a = $('abBrandA').value, b = $('abBrandB').value;
    var opts = abOpts();
    var cmp = E.compareAvsB(STATE.clean, a, b, opts);

    var metrics = [
      { label: 'Models (count)', key: 'count', type: 'int', better: 'high' },
      { label: 'In stock', key: 'inStock', type: 'int', better: 'high' },
      { label: 'Out of stock', key: 'outStock', type: 'int', better: 'low' },
      { label: '% in stock', key: 'pctInStock', type: 'pct01', better: 'high' },
      { label: 'Prime / Assured', key: 'prime', type: 'int', better: 'high' },
      { label: 'Avg price', key: 'avgPrice', type: 'currency', better: 'low' },
      { label: 'Avg best / wow', key: 'avgWow', type: 'currency', better: 'low' },
      { label: 'Lowest price', key: 'lowest', type: 'currency', better: 'low' },
      { label: 'Avg discount %', key: 'avgDiscount', type: 'pctRaw', better: 'high' },
      { label: 'Avg rating', key: 'avgRating', type: 'rating', better: 'high' },
      { label: 'Total reviews', key: 'totalReviews', type: 'int', better: 'high' },
      { label: 'Avg bestseller rank', key: 'avgBsr', type: 'int', better: 'low' }
    ];
    var rows = metrics.map(function (m) {
      var va = cmp.a[m.key], vb = cmp.b[m.key];
      var diff = (va != null && vb != null) ? va - vb : null;
      return { metric: m.label, a: va, b: vb, diff: diff, type: m.type };
    });
    renderTable($('abTableWrap'), [
      { key: 'metric', label: 'Metric', type: 'text', sortable: false, get: function (r) { return r.metric; } },
      { key: 'a', label: a, type: 'text', sortable: false, get: function (r) { return r.a; }, render: function (r, v) { return fmtByType(v, r.type); } },
      { key: 'b', label: b, type: 'text', sortable: false, get: function (r) { return r.b; }, render: function (r, v) { return fmtByType(v, r.type); } },
      { key: 'diff', label: 'Difference (A - B)', type: 'text', sortable: false, get: function (r) { return r.diff; },
        render: function (r, v) { if (v == null) return ''; var s = el('span'); s.textContent = (v > 0 ? '+' : '') + fmtByType(v, r.type); return s; } }
    ], rows, {});

    // Top brands competition panel (respects all the same filters)
    var data = STATE.clean.filter(function (r) { return E.rowMatchesOpts(r, opts); });
    var bsum = E.groupSummary(data, 'brand').slice(0, 8);
    renderTable($('abPanelWrap'), [
      { key: 'key', label: 'Brand', type: 'text', get: function (r) { return r.key; } },
      { key: 'count', label: 'Models', type: 'int', get: function (r) { return r.count; } },
      { key: 'pctInStock', label: '% In Stock', type: 'pct01', get: function (r) { return r.pctInStock; } },
      { key: 'avgPrice', label: 'Avg Price', type: 'currency', get: function (r) { return r.avgPrice; } },
      { key: 'avgRating', label: 'Avg Rating', type: 'rating', get: function (r) { return r.avgRating; } },
      { key: 'totalReviews', label: 'Reviews', type: 'int', get: function (r) { return r.totalReviews; } }
    ], bsum, { sortKey: 'count', sortDir: 'desc' });
  }

  // ===========================================================================
  // SQL WORKSPACE
  // ===========================================================================
  var SQL_SAMPLES = [
    { label: 'All Sleepwell listings', sql: "SELECT brand, title, price, rating FROM ? WHERE brand = 'Sleepwell'" },
    { label: 'Discounts over 25%, cheapest first', sql: "SELECT brand, title, price, mrp, discount FROM ? WHERE discount > 25 ORDER BY price ASC LIMIT 100" },
    { label: 'Count and averages by platform', sql: "SELECT platform, COUNT(*) AS listings, AVG(price) AS avg_price, AVG(rating) AS avg_rating FROM ? GROUP BY platform" },
    { label: 'Averages by brand (latest reads)', sql: "SELECT brand, COUNT(*) AS models, AVG(price) AS avg_price, AVG(discount) AS avg_disc FROM ? GROUP BY brand ORDER BY models DESC" },
    { label: 'Latex or memory foam products', sql: "SELECT brand, type, title, price FROM ? WHERE type LIKE '%Latex%' OR type LIKE '%Memory%' ORDER BY price DESC" },
    { label: 'King-size in-stock under 15000', sql: "SELECT brand, title, size, price, instock FROM ? WHERE size = 'King' AND price < 15000 AND instock = 'In Stock' ORDER BY price ASC" }
  ];
  var SQL_SCHEMA = [
    ['platform', 'TEXT', 'Amazon, Flipkart'],
    ['brand', 'TEXT', 'standardized brand'],
    ['brandRaw', 'TEXT', 'as scraped'],
    ['title', 'TEXT', 'listing title'],
    ['type', 'TEXT', 'product type'],
    ['size', 'TEXT', 'mattress size'],
    ['thickness', 'TEXT', 'inches'],
    ['dim', 'TEXT', 'L x B x H'],
    ['price', 'NUMBER', 'active price'],
    ['effPrice', 'NUMBER', 'effective price'],
    ['wow', 'NUMBER', 'best / wow price'],
    ['mrp', 'NUMBER', 'list price'],
    ['discount', 'NUMBER', 'percent off'],
    ['rating', 'NUMBER', 'stars (0-5)'],
    ['reviews', 'NUMBER', 'review count'],
    ['bsr', 'NUMBER', 'bestseller rank'],
    ['instock', 'TEXT', 'In Stock / Out of Stock'],
    ['prime', 'TEXT', 'Yes / No'],
    ['seller', 'TEXT', 'fulfilled by'],
    ['warranty', 'TEXT', 'duration'],
    ['scrapeDate', 'TEXT', 'YYYY-MM-DD'],
    ['pid', 'TEXT', 'ASIN / FSN'],
    ['url', 'TEXT', 'product link']
  ];

  function initSqlControls() {
    fillSelect($('sqlSamples'), SQL_SAMPLES.map(function (s, i) { return { value: String(i), label: (i + 1) + '. ' + s.label }; }), {});
    $('sqlEditor').value = SQL_SAMPLES[0].sql;
    $('sqlSamples').addEventListener('change', function () { $('sqlEditor').value = SQL_SAMPLES[+this.value].sql; });
    $('sqlRun').addEventListener('click', runSqlQuery);
    $('sqlExport').addEventListener('click', exportSql);
  }
  function renderSqlSchema() {
    var ul = $('schemaList'); clear(ul);
    SQL_SCHEMA.forEach(function (s) {
      var li = el('li');
      var left = el('span'); var code = el('code', null, s[0]); left.appendChild(code);
      left.appendChild(document.createTextNode(' – ' + s[2]));
      var right = el('span', 'stype', s[1]);
      li.appendChild(left); li.appendChild(right); ul.appendChild(li);
    });
  }
  function sqlDataset() {
    return STATE.clean.map(function (r) {
      return {
        platform: r.platform, brand: r.brand, brandRaw: r.brandRaw, title: r.title, type: r.type, size: r.size,
        thickness: r.thickness, dim: r.dim, price: r.price || 0, effPrice: r.effPrice || 0, wow: r.wow || 0,
        mrp: r.mrp || 0, discount: r.discount || 0, rating: r.rating || 0, reviews: r.reviews || 0, bsr: r.bsr || 0,
        instock: r.inStock, prime: r.prime, seller: r.seller, warranty: r.warranty, scrapeDate: r.scrapeDate, pid: r.pid, url: r.url
      };
    });
  }
  function runSqlQuery() {
    var wrap = $('sqlResultWrap'); var fb = $('sqlFeedback');
    if (!STATE.clean.length) { fb.textContent = 'Load a dataset first.'; return; }
    var t0 = performance.now();
    try {
      var out = E.runSql($('sqlEditor').value, sqlDataset());
      STATE.sql = out;
      fb.textContent = 'Returned ' + nfIN(out.length) + ' rows in ' + (performance.now() - t0).toFixed(1) + ' ms';
      if (!out.length) { clear(wrap); wrap.appendChild(emptyMsg('Query returned 0 rows.')); return; }
      var keys = Object.keys(out[0]);
      var cols = keys.map(function (k) {
        var isNum = out.every(function (r) { return r[k] == null || typeof r[k] === 'number'; });
        return { key: k, label: k, type: isNum ? 'num' : 'text', get: (function (kk) { return function (r) { return r[kk]; }; })(k),
          render: (function (kk, isn) { return function (r, v) {
            if (isn && /price|mrp|wow/i.test(kk) && typeof v === 'number') return money(v);
            return v == null ? '' : String(v);
          }; })(k, isNum) };
      });
      renderTable(wrap, cols, out, { sortKey: keys[0], sortDir: 'asc' });
    } catch (err) {
      STATE.sql = [];
      fb.textContent = 'Error: ' + err.message;
      clear(wrap); var d = el('div', 'empty'); d.textContent = err.message; wrap.appendChild(d);
    }
  }
  function exportSql() {
    if (!STATE.sql.length) return;
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(STATE.sql), 'Query');
    XLSX.writeFile(wb, 'apex_query_' + Date.now() + '.xlsx');
  }

  // ===========================================================================
  // AI INSIGHTS
  // ===========================================================================
  function renderAiControls() { /* selects already populated in refreshAll */ }

  function initAiControls() { $('aiRun').addEventListener('click', runAi); }

  function aiTerm(html, append) {
    var t = $('aiTerminal');
    if (append) t.innerHTML += '<br>' + html; else t.innerHTML = html;
    t.scrollTop = t.scrollHeight;
  }

  function runAi() {
    if (!STATE.clean.length) { aiTerm('No dataset loaded. Load a file first.'); return; }
    var anchor = $('aiAnchor').value;
    var prompt = $('aiPrompt').value.trim();
    aiTerm('Looking for a local LLM at http://localhost:11434 (Ollama) ...');
    $('aiProgress').style.display = 'block'; $('aiProgressFill').style.width = '15%';
    callOllama(anchor, prompt).then(function (res) {
      $('aiProgressFill').style.width = '100%';
      aiTerm('Report generated by: ' + res.engine, true);
      showAiReport(res.html);
      $('aiProgress').style.display = 'none';
    }).catch(function (err) {
      aiTerm('No local LLM reachable (' + escapeHtml(String(err && err.message || err)) + ').', true);
      aiTerm('Falling back to the built-in statistical engine - every figure below is computed directly from your data.', true);
      $('aiProgress').style.display = 'none';
      showAiReport(buildStatReport(anchor, prompt));
    });
  }

  function showAiReport(html) { STATE.aiReport = html; var r = $('aiReport'); r.innerHTML = html; r.classList.remove('hidden'); }

  function datasetDigest(anchor) {
    var bsum = E.groupSummary(STATE.clean, 'brand');
    var summary = bsum.slice(0, 12).map(function (b) {
      return b.key + ': ' + b.count + ' SKUs, avg ' + (b.avgPrice != null ? Math.round(b.avgPrice) : 'n/a') + ', rating ' + (b.avgRating != null ? b.avgRating.toFixed(2) : 'n/a');
    }).join('; ');
    var sample = STATE.clean.slice(0, 50).map(function (r) {
      return { brand: r.brand, title: (r.title || '').slice(0, 80), platform: r.platform, type: r.type, size: r.size, price: r.price, rating: r.rating, discount: r.discount };
    });
    return { total: STATE.clean.length, summary: summary, sample: sample, anchor: anchor };
  }

  function callOllama(anchor, prompt) {
    var model = ($('aiModel').value || 'llama3').trim();
    var d = datasetDigest(anchor);
    var sys = 'You are a retail competitive-intelligence analyst for the brand "' + anchor + '". '
      + 'Analyze ONLY the dataset provided; do not invent figures. Output clean HTML using only h3, h4, p, ul, li, ol, table, tr, th, td. '
      + 'Cover price positioning vs competitors, rating and review gaps, discount strategy, and three concrete recommended actions. Do not use emoji.';
    var user = (prompt ? 'Analyst question: ' + prompt + '\n\n' : '')
      + 'Dataset: ' + d.total + ' listings. Brand summary: ' + d.summary + '.\nSample rows (JSON): ' + JSON.stringify(d.sample);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 120000);
    return fetch('http://localhost:11434/api/generate', {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, system: sys, prompt: user, stream: false })
    }).then(function (resp) {
      if (!resp.ok) throw new Error('Ollama HTTP ' + resp.status + (resp.status === 404 ? ' - model not pulled? run: ollama pull ' + model : ''));
      return resp.json();
    }).then(function (data) {
      clearTimeout(timer);
      var text = (data && data.response) ? data.response.trim() : '';
      if (!text) throw new Error('Empty LLM response');
      if (!/<\w+[^>]*>/.test(text)) {
        text = '<p>' + escapeHtml(text).replace(/^### (.*)$/gm, '</p><h4>$1</h4><p>').replace(/^## (.*)$/gm, '</p><h3>$1</h3><p>')
          .replace(/^[-*] (.*)$/gm, '&bull; $1<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n\n/g, '</p><p>') + '</p>';
      }
      var header = '<p class="muted">Engine: Ollama, model ' + escapeHtml(model) + ', ' + d.total + ' rows analyzed locally.</p>';
      return { html: header + text, engine: 'Ollama (' + model + ') - local LLM' };
    });
  }

  // Transparent statistical report (no AI text generation; pure math on the data)
  function buildStatReport(anchor, prompt) {
    var data = STATE.clean;
    var anchorItems = data.filter(function (r) { return r.brand === anchor; });
    var compItems = data.filter(function (r) { return r.brand !== anchor; });

    // identical-spec undercuts
    function specKey(r) { return [r.type, r.size, r.thickness, r.dim].join('|'); }
    var compBySpec = {};
    compItems.forEach(function (r) { if (r.price != null && r.price > 0) { (compBySpec[specKey(r)] = compBySpec[specKey(r)] || []).push(r); } });
    var undercuts = [];
    anchorItems.forEach(function (a) {
      if (a.price == null || a.price <= 0) return;
      (compBySpec[specKey(a)] || []).forEach(function (c) {
        if (c.price < a.price) undercuts.push({ a: a, c: c, diff: a.price - c.price, pct: Math.round((a.price - c.price) / a.price * 100) });
      });
    });
    undercuts.sort(function (x, y) { return y.pct - x.pct; });

    var bsum = E.groupSummary(data, 'brand');
    var anchorRow = bsum.filter(function (b) { return b.key === anchor; })[0];

    var html = '<h3>Competitive briefing for ' + escapeHtml(anchor) + '</h3>';
    if (prompt) html += '<p class="muted">Prompt: ' + escapeHtml(prompt) + '</p>';
    html += '<p>Dataset: <strong>' + nfIN(data.length) + '</strong> listings across <strong>' + bsum.length + '</strong> brands. '
      + 'Identified <strong>' + undercuts.length + '</strong> identical-specification undercuts where a competitor is priced below ' + escapeHtml(anchor) + '.</p>';

    html += '<h4>Price positioning</h4><table><tr><th>Brand</th><th>Models</th><th>Avg price</th><th>Avg rating</th><th>Reviews</th></tr>';
    bsum.slice(0, 8).forEach(function (b) {
      html += '<tr><td>' + escapeHtml(b.key) + (b.key === anchor ? ' (anchor)' : '') + '</td><td>' + b.count + '</td><td>'
        + (b.avgPrice != null ? money(b.avgPrice) : 'n/a') + '</td><td>' + (b.avgRating != null ? b.avgRating.toFixed(2) : 'n/a') + '</td><td>' + intf(b.totalReviews) + '</td></tr>';
    });
    html += '</table>';

    html += '<h4>Top identical-spec undercuts</h4>';
    if (!undercuts.length) html += '<p>No competitor is currently priced below ' + escapeHtml(anchor) + ' on an identical specification.</p>';
    else {
      html += '<table><tr><th>' + escapeHtml(anchor) + ' model</th><th>Anchor price</th><th>Competitor</th><th>Their price</th><th>Gap</th></tr>';
      undercuts.slice(0, 8).forEach(function (u) {
        html += '<tr><td>' + escapeHtml((u.a.title || '').slice(0, 40)) + '</td><td>' + money(u.a.price) + '</td><td>'
          + escapeHtml(u.c.brand) + '</td><td>' + money(u.c.price) + '</td><td>-' + u.pct + '% (' + money(u.diff) + ')</td></tr>';
      });
      html += '</table>';
    }

    var lowRated = anchorItems.filter(function (r) { return r.rating != null && r.rating > 0 && r.rating < 4.2; })
      .sort(function (a, b) { return a.rating - b.rating; });
    html += '<h4>Rating watch (' + escapeHtml(anchor) + ' listings below 4.2 stars)</h4>';
    if (!lowRated.length) html += '<p>All rated ' + escapeHtml(anchor) + ' listings are at or above 4.2 stars.</p>';
    else {
      html += '<ul>';
      lowRated.slice(0, 6).forEach(function (r) { html += '<li>' + escapeHtml((r.title || '').slice(0, 56)) + ' - ' + r.rating.toFixed(1) + ' stars (' + intf(r.reviews) + ' reviews)</li>'; });
      html += '</ul>';
    }

    html += '<h4>Recommended actions</h4><ol>';
    if (undercuts.length) html += '<li>Address the ' + undercuts.length + ' identical-spec undercuts; the widest gap is ' + undercuts[0].pct + '% on "' + escapeHtml((undercuts[0].a.title || '').slice(0, 40)) + '". Consider a targeted best-price or bank-offer adjustment.</li>';
    if (anchorRow && anchorRow.avgDiscount != null) {
      var marketDisc = bsum.filter(function (b) { return b.key !== anchor && b.avgDiscount != null; });
      var md = marketDisc.length ? marketDisc.reduce(function (s, b) { return s + b.avgDiscount; }, 0) / marketDisc.length : null;
      if (md != null) html += '<li>Average discount is ' + pctRaw(anchorRow.avgDiscount) + ' vs market ' + pctRaw(md) + '. ' + (anchorRow.avgDiscount < md ? 'You are less promotional than the market.' : 'You are more promotional than the market.') + '</li>';
    }
    if (lowRated.length) html += '<li>Prioritise review-quality recovery on ' + lowRated.length + ' sub-4.2 listings to protect conversion.</li>';
    html += '</ol>';
    return html;
  }

  // ===========================================================================
  // ALERT CENTER
  // ===========================================================================
  function alertOpts() {
    return {
      ratingFloor: parseFloat($('alRatingFloor').value) || 4.2,
      undercutHighPct: parseFloat($('alUndercut').value) || 15
    };
  }

  function sevBadge(text, sev, active) {
    var cls = sev === 'high' ? 'neg' : (sev === 'medium' ? 'warn' : 'accent');
    var b = el('span', 'badge ' + (active ? cls : ''));
    b.textContent = text;
    b.style.padding = '4px 10px';
    if (!active) { b.style.background = 'var(--surface-2)'; b.style.color = 'var(--text-faint)'; }
    return b;
  }

  function renderAlerts() {
    if (!STATE.clean.length) return;
    var anchor = $('aiAnchor').value;
    var res = E.buildAlerts(STATE.clean, anchor, alertOpts());
    STATE.alerts = res;

    var sum = $('alertSummary'); clear(sum);
    var aChip = el('span', 'chip on', 'Anchor: ' + anchor); sum.appendChild(aChip);
    sum.appendChild(sevBadge('High ' + res.counts.high, 'high', res.counts.high > 0));
    sum.appendChild(sevBadge('Medium ' + res.counts.medium, 'medium', res.counts.medium > 0));
    sum.appendChild(sevBadge('Low ' + res.counts.low, 'low', res.counts.low > 0));
    sum.appendChild(el('span', 'chip', 'Total ' + res.total));

    var box = $('actionItemsBox'); clear(box);
    if (res.actionItems.length) {
      var h = el('div'); h.appendChild(el('strong', null, 'Recommended action items'));
      var ul = el('ul'); ul.style.margin = '6px 0 4px 18px'; ul.style.fontSize = '12px';
      res.actionItems.forEach(function (a) { var li = el('li', null, a); li.style.marginBottom = '3px'; ul.appendChild(li); });
      box.appendChild(h); box.appendChild(ul);
    }

    renderTable($('alertTableWrap'), [
      { key: 'severity', label: 'Severity', type: 'text', get: function (r) { return r.severity; },
        render: function (r, v) { return sevBadge(v.toUpperCase(), v, true); } },
      { key: 'type', label: 'Type', type: 'text', get: function (r) { return r.type; } },
      { key: 'title', label: 'Issue', type: 'text', get: function (r) { return r.title; } },
      { key: 'metric', label: 'Metric', type: 'text', get: function (r) { return r.metric; } },
      { key: 'brand', label: 'Brand', type: 'text', get: function (r) { return r.brand; } },
      { key: 'detail', label: 'Detail', type: 'text', get: function (r) { return r.detail; },
        render: function (r, v) { var s = String(v || ''); return s.length > 96 ? s.slice(0, 96) + '...' : s; } },
      { key: 'action', label: 'Action', type: 'text', get: function (r) { return r.action; },
        render: function (r, v) { var s = String(v || ''); return s.length > 70 ? s.slice(0, 70) + '...' : s; } }
    ], res.alerts, { emptyText: 'No alerts - nothing critical detected for ' + anchor + '.',
      cellTitle: function (r, c) { return c.key === 'detail' ? r.detail : (c.key === 'action' ? r.action : ''); } });
  }

  // ===========================================================================
  // EMAIL / NOTIFICATIONS
  // ===========================================================================
  function notify(msg) {
    var t = $('notifyLog');
    if (t.textContent === 'Notification log is empty.') t.textContent = '';
    var time = new Date().toLocaleTimeString();
    t.innerHTML += (t.innerHTML ? '<br>' : '') + '[' + time + '] ' + escapeHtml(msg);
    t.scrollTop = t.scrollHeight;
  }
  function loadNotifySettings() {
    store.get('notify', function (s) {
      if (!s) return;
      if (s.to != null) $('emailTo').value = s.to;
      if (s.channel) $('emailChannel').value = s.channel;
      if (s.webhook != null) $('emailWebhook').value = s.webhook;
    });
  }
  function saveNotifySettings() {
    store.set('notify', { to: $('emailTo').value.trim(), channel: $('emailChannel').value, webhook: $('emailWebhook').value.trim() });
    $('notifyStatus').textContent = 'Settings saved';
    notify('Notification settings saved on this machine.');
  }
  function htmlToText(html) {
    var d = document.createElement('div'); d.innerHTML = html;
    return (d.textContent || d.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  function alertDigestText(res) {
    var lines = [];
    lines.push('Apex Analyzer Pro - Competitive alerts for ' + res.anchor);
    lines.push('High: ' + res.counts.high + '   Medium: ' + res.counts.medium + '   Low: ' + res.counts.low);
    var crit = res.alerts.filter(function (a) { return a.severity !== 'low'; });
    lines.push(''); lines.push('CRITICAL ALERTS (' + crit.length + '):');
    crit.slice(0, 30).forEach(function (a, i) { lines.push((i + 1) + '. [' + a.severity.toUpperCase() + '] ' + a.title + ' - ' + a.detail); });
    lines.push(''); lines.push('ACTION ITEMS:');
    res.actionItems.forEach(function (a, i) { lines.push((i + 1) + '. ' + a); });
    return lines.join('\n');
  }
  function alertDigestHtml(res) {
    var h = '<h3>Competitive alerts for ' + escapeHtml(res.anchor) + '</h3>';
    h += '<p>High: ' + res.counts.high + ' | Medium: ' + res.counts.medium + ' | Low: ' + res.counts.low + '</p>';
    h += '<table><tr><th>Severity</th><th>Type</th><th>Issue</th><th>Detail</th></tr>';
    res.alerts.filter(function (a) { return a.severity !== 'low'; }).slice(0, 40).forEach(function (a) {
      h += '<tr><td>' + a.severity + '</td><td>' + escapeHtml(a.type) + '</td><td>' + escapeHtml(a.title) + '</td><td>' + escapeHtml(a.detail) + '</td></tr>';
    });
    h += '</table><h4>Action items</h4><ol>' + res.actionItems.map(function (a) { return '<li>' + escapeHtml(a) + '</li>'; }).join('') + '</ol>';
    return h;
  }
  function openMailto(to, subject, body) {
    var b = body.length > 1800 ? body.slice(0, 1800) + '\n\n[Truncated - open Apex Analyzer Pro for the full report]' : body;
    var href = 'mailto:' + encodeURIComponent(to || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(b);
    var a = document.createElement('a'); a.href = href; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function postWebhook(url, payload, to, subject, text) {
    function doFetch() {
      notify('Posting to webhook: ' + url);
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { notify('Webhook responded ' + r.status + (r.ok ? ' (delivered)' : ' (check your endpoint)')); })
        .catch(function (e) { notify('Webhook failed: ' + (e && e.message || e) + '. Opening email client instead.'); openMailto(to, subject, text); });
    }
    var origin;
    // Chrome match patterns do not allow a port in the host, so build the
    // pattern from protocol + hostname only (drop any port).
    try { var u = new URL(url); origin = u.protocol + '//' + u.hostname + '/*'; } catch (e) { notify('Invalid webhook URL.'); return; }
    if (typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.request) {
      try {
        chrome.permissions.request({ origins: [origin] }, function (granted) {
          if (granted) doFetch();
          else { notify('Host permission denied for ' + origin + '. Opening email client instead.'); openMailto(to, subject, text); }
        });
      } catch (e) {
        notify('Could not request permission for ' + origin + ' (' + (e && e.message || e) + '). Opening email client instead.');
        openMailto(to, subject, text);
      }
    } else { doFetch(); }
  }
  function pushNotification(kind) {
    if (!STATE.clean.length) { notify('No dataset loaded - nothing to send.'); return; }
    var to = $('emailTo').value.trim();
    var channel = $('emailChannel').value;
    var anchor = $('aiAnchor').value;
    var subject, html, text, actionItems = [], alertsData = null;

    if (kind === 'alerts') {
      renderAlerts(); var res = STATE.alerts;
      subject = 'Apex critical alerts - ' + anchor + ' (' + res.counts.high + ' high, ' + res.counts.medium + ' medium)';
      html = alertDigestHtml(res); text = alertDigestText(res);
      actionItems = res.actionItems; alertsData = res.alerts;
    } else {
      if (!STATE.aiReport) STATE.aiReport = buildStatReport(anchor, $('aiPrompt').value.trim());
      var res2 = STATE.alerts || E.buildAlerts(STATE.clean, anchor, alertOpts());
      subject = 'Apex competitor report - ' + anchor;
      html = STATE.aiReport + '<hr>' + alertDigestHtml(res2);
      text = htmlToText(STATE.aiReport) + '\n\n' + alertDigestText(res2);
      actionItems = res2.actionItems; alertsData = res2.alerts;
    }
    var payload = { to: to, subject: subject, html: html, text: text, alerts: alertsData, actionItems: actionItems, generatedAt: new Date().toISOString(), tool: 'Apex Analyzer Pro' };

    if (channel === 'webhook') {
      var url = $('emailWebhook').value.trim();
      if (!url) { notify('Webhook channel selected but no URL set. Opening email client instead.'); openMailto(to, subject, text); return; }
      postWebhook(url, payload, to, subject, text);
    } else {
      if (!to) notify('Tip: add recipients above. Opening email client with the digest.');
      openMailto(to, subject, text);
      notify('Opened email client' + (to ? ' for ' + to : '') + ' with ' + (kind === 'alerts' ? 'critical alerts and action items' : 'the AI report') + '.');
    }
  }

  // ===========================================================================
  // INIT
  // ===========================================================================
  function initNav() {
    var btns = document.querySelectorAll('.nav-btn');
    var panes = document.querySelectorAll('.pane');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.classList.remove('active'); });
        panes.forEach(function (p) { p.classList.remove('active'); });
        b.classList.add('active');
        var pane = $('pane-' + b.getAttribute('data-pane'));
        if (pane) pane.classList.add('active');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initNav();
    initPivotControls();
    initTrendControls();
    initAvsBControls();
    initSqlControls();
    renderSqlSchema();
    initAiControls();

    $('loadBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); });
    $('sheetBtn').addEventListener('click', cycleSheet);
    $('ovSnapshot').addEventListener('change', renderOverview);
    $('ovPlatform').addEventListener('change', renderOverview);
    $('ovType').addEventListener('change', renderOverview);
    // Alert center + notifications
    $('alRefresh').addEventListener('click', renderAlerts);
    $('alRatingFloor').addEventListener('change', renderAlerts);
    $('alUndercut').addEventListener('change', renderAlerts);
    $('aiAnchor').addEventListener('change', renderAlerts);
    $('saveNotifyBtn').addEventListener('click', saveNotifySettings);
    $('sendReportBtn').addEventListener('click', function () { pushNotification('report'); });
    $('sendAlertsBtn').addEventListener('click', function () { pushNotification('alerts'); });
    loadNotifySettings();
    $('exportTypeBtn').addEventListener('click', function () {
      if (!STATE.clean.length) return;
      var data = snapshotData($('ovSnapshot').value);
      var tsum = E.groupSummary(data, 'type');
      var rows = tsum.map(function (t) {
        return { 'Product Type': t.key, Models: t.count, 'In Stock': t.inStock, 'Out of Stock': t.outStock,
          '% In Stock': t.pctInStock, 'Prime/Assured': t.prime, 'Avg Price': t.avgPrice, 'Avg Best/Wow': t.avgWow,
          Lowest: t.lowest, 'Avg Discount %': t.avgDiscount, 'Avg Rating': t.avgRating, 'Total Reviews': t.totalReviews };
      });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Type Master');
      XLSX.writeFile(wb, 'apex_type_master.xlsx');
    });
    $('matrixExport').addEventListener('click', exportMatrix);
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('drawerExport').addEventListener('click', exportDrill);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  });

  // Automation / power-user hook: load data programmatically (same path as a
  // file upload) and inspect state. Example: ApexAnalyzerPro.ingestRows(rows).
  window.ApexAnalyzerPro = { ingestRows: ingestRows, state: STATE, engine: E };
})();
