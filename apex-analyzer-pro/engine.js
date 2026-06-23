/* ============================================================================
   Apex Analyzer Pro - Core Analytics Engine (pure, DOM-free, unit-testable)
   ----------------------------------------------------------------------------
   This module contains every piece of data logic in the tool: header mapping,
   row normalization, cleaning, the pivot engine (with drill-down indexing),
   KPI/summary builders, the A-vs-B comparator, and a small SQL parser.

   It is deliberately free of any DOM or browser dependency so it can be loaded
   and exercised by the Node back-test harness (test/backtest.js) against the
   real workbook data, then reused verbatim by the popup UI.
   ========================================================================== */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function cleanKey(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Parse a number out of a possibly messy cell ("Rs 12,082", "4.4", 12082).
  // Returns null when nothing numeric is present.
  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.' || s === '-.') return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function titleCaseBrand(b) {
    var s = String(b == null ? '' : b).trim();
    if (!s) return '';
    // Preserve known multi-word brands but normalise casing of plain tokens.
    return s.replace(/\S+/g, function (w) {
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  // Normalise a date-ish cell to YYYY-MM-DD (or '' if not derivable).
  function toISODate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return m[3] + '-' + pad2(m[1]) + '-' + pad2(m[2]);
    var d = new Date(s);
    if (!isNaN(d)) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return '';
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  // ---------------------------------------------------------------------------
  // Fallback classification from the product title (used ONLY when a row has no
  // standardised columns - keeps the tool working on simpler/older exports).
  // ---------------------------------------------------------------------------
  function classifyFromTitle(title) {
    var t = String(title == null ? '' : title).toLowerCase();
    var type = 'Other Foam';
    if (t.indexOf('memory') >= 0) type = 'Memory Foam';
    else if (t.indexOf('latex') >= 0) type = (t.indexOf('foam') >= 0 ? 'Latex Foam' : 'Pure Latex');
    else if (t.indexOf('spring') >= 0 || t.indexOf('pocket') >= 0 || t.indexOf('bonnell') >= 0) type = 'Spring';
    else if (t.indexOf('coir') >= 0) type = 'Coir';
    else if (t.indexOf('grid') >= 0) type = 'Grid';
    else if (t.indexOf('ortho') >= 0 || t.indexOf('spine') >= 0) type = 'Ortho Foam';
    else if (t.indexOf('dual') >= 0) type = 'Dual Foam';

    var size = 'Unspecified';
    if (t.indexOf('king') >= 0) size = 'King';
    else if (t.indexOf('queen') >= 0) size = 'Queen';
    else if (t.indexOf('double') >= 0) size = 'Double';
    else if (t.indexOf('single') >= 0) size = 'Single';
    else if (t.indexOf('diwan') >= 0 || t.indexOf('dewan') >= 0) size = 'Diwan';

    var thickness = '';
    var tm = t.match(/(\d{1,2})\s*-?\s*inch/);
    if (tm) thickness = tm[1];

    var dim = '';
    var dm = t.match(/(\d{2,3})\s*[x*]\s*(\d{2,3})\s*[x*]\s*(\d{1,2})/);
    if (dm) dim = dm[1] + 'x' + dm[2] + 'x' + dm[3];

    return { type: type, size: size, thickness: thickness, dim: dim };
  }

  // ---------------------------------------------------------------------------
  // Header alias table. First matching header (by cleaned key, exact then
  // contains) wins, in the order listed - standardised columns are listed first
  // so they take priority over raw scraped columns.
  // ---------------------------------------------------------------------------
  var FIELD_ALIASES = {
    scrapeDate:   ['scrapedate', 'rundate', 'date'],
    scrapeTs:     ['scrapedtimestamp', 'scrapetime', 'timestamp'],
    platform:     ['platform', 'store', 'marketplace'],
    brandStd:     ['brandstd', 'standardbrand'],
    brandRaw:     ['brandname', 'brand', 'manufacturer'],
    title:        ['producttitle', 'title', 'name'],
    url:          ['urllink', 'url', 'link', 'href'],
    pid:          ['productidasinfsn', 'productid', 'asin', 'fsn', 'asinfsn'],
    currency:     ['currency'],
    activePrice:  ['activeprice', 'sellingprice', 'price'],
    effPrice:     ['effectiveprice'],
    mrp:          ['mrpvalue', 'mrp', 'originalprice'],
    discount:     ['discount', 'discountpercent', 'percentoff'],
    rating:       ['starrating', 'rating', 'stars'],
    reviews:      ['reviewscount', 'reviewcount', 'reviews'],
    wow:          ['wowbestpricehist', 'wowprice', 'bestprice', 'lowestprice', 'wowbestprice'],
    emi:          ['emiprice', 'emi'],
    bsr:          ['bestsellerrank', 'bsr', 'rank'],
    productType:  ['producttype', 'typestd'],
    size:         ['mattresssize', 'sizestd', 'size'],
    thickness:    ['thicknessin', 'thickness'],
    dim:          ['dimensionslxbhin', 'dimensions', 'dimension'],
    length:       ['lengthin', 'length'],
    breadth:      ['breadthin', 'breadth', 'width'],
    heightDim:    ['heightin', 'height'],
    availability: ['availability', 'stockstatus'],
    inStock:      ['instockflag', 'instock'],
    prime:        ['primeassuredflag', 'primeassured', 'assuredprime', 'assured'],
    seller:       ['sellerfulfilledby', 'fulfilledby', 'seller', 'merchant'],
    warranty:     ['warrantyduration', 'warranty'],
    recordStatus: ['recordstatus', 'status']
  };

  // Build a {field -> originalHeaderKey} resolver for a given header list.
  // Two global phases so a precise (exact) match always wins over a loose
  // (substring) one, and a header can be claimed by only ONE field - this
  // prevents collisions such as "Height (in)" being grabbed by the thickness
  // field's substring alias before the height field can claim it exactly.
  function buildHeaderMap(headers) {
    var cleaned = headers.map(function (h) { return { orig: h, key: cleanKey(h) }; });
    var map = {};
    var used = {};
    var fields = Object.keys(FIELD_ALIASES);

    // Phase 1: exact matches across all fields, claiming headers as they bind.
    fields.forEach(function (field) {
      var aliases = FIELD_ALIASES[field];
      for (var a = 0; a < aliases.length && !map[field]; a++) {
        for (var i = 0; i < cleaned.length; i++) {
          if (!used[i] && cleaned[i].key === aliases[a]) { map[field] = cleaned[i].orig; used[i] = true; break; }
        }
      }
    });

    // Phase 2: substring matches for still-unresolved fields over unclaimed headers.
    fields.forEach(function (field) {
      if (map[field]) return;
      var aliases = FIELD_ALIASES[field];
      for (var a = 0; a < aliases.length && !map[field]; a++) {
        for (var i = 0; i < cleaned.length; i++) {
          if (!used[i] && cleaned[i].key.indexOf(aliases[a]) >= 0) { map[field] = cleaned[i].orig; used[i] = true; break; }
        }
      }
    });
    return map;
  }

  // ---------------------------------------------------------------------------
  // Normalisation: array of plain row objects -> canonical records.
  // ---------------------------------------------------------------------------
  function normalizeRows(rawRows) {
    if (!rawRows || !rawRows.length) return [];
    var headers = Object.keys(rawRows[0]);
    var hm = buildHeaderMap(headers);

    function pick(row, field) {
      var key = hm[field];
      if (!key) return undefined;
      return row[key];
    }

    return rawRows.map(function (row, idx) {
      var title = pick(row, 'title');
      var titleStr = title == null ? '' : String(title);

      var brandStd = pick(row, 'brandStd');
      var brandRaw = pick(row, 'brandRaw');
      var brand = (brandStd != null && String(brandStd).trim()) ? String(brandStd).trim()
                : titleCaseBrand(brandRaw);
      if (!brand || /^unknown$/i.test(brand)) brand = brand ? titleCaseBrand(brand) : '';

      var type = pick(row, 'productType');
      var size = pick(row, 'size');
      var thickness = pick(row, 'thickness');
      var dim = pick(row, 'dim');
      var needFallback = (type == null || String(type).trim() === '' ||
                          size == null || String(size).trim() === '');
      var fb = needFallback ? classifyFromTitle(titleStr) : null;

      var activePrice = toNum(pick(row, 'activePrice'));
      var effPrice = toNum(pick(row, 'effPrice'));
      var price = (activePrice != null && activePrice > 0) ? activePrice
                : (effPrice != null ? effPrice : activePrice);

      var inStockRaw = pick(row, 'inStock');
      var availability = pick(row, 'availability');
      var inStock = resolveStock(inStockRaw, availability);

      var primeRaw = pick(row, 'prime');
      var prime = resolveBool(primeRaw);

      var rec = {
        idx: idx,
        platform: cleanStr(pick(row, 'platform')) || 'Unknown',
        brandRaw: cleanStr(brandRaw),
        brand: brand || 'Unknown',
        title: titleStr,
        url: cleanStr(pick(row, 'url')),
        pid: cleanStr(pick(row, 'pid')),
        currency: cleanStr(pick(row, 'currency')) || 'INR',
        price: price,
        activePrice: activePrice,
        effPrice: effPrice,
        mrp: toNum(pick(row, 'mrp')),
        discount: toNum(pick(row, 'discount')),
        rating: toNum(pick(row, 'rating')),
        reviews: toNum(pick(row, 'reviews')),
        wow: toNum(pick(row, 'wow')),
        emi: toNum(pick(row, 'emi')),
        bsr: toNum(pick(row, 'bsr')),
        type: cleanStr(type) || (fb ? fb.type : 'Other'),
        size: cleanStr(size) || (fb ? fb.size : 'Unspecified'),
        thickness: cleanStr(thickness) || (fb ? fb.thickness : ''),
        dim: cleanStr(dim) || (fb ? fb.dim : ''),
        length: toNum(pick(row, 'length')),
        breadth: toNum(pick(row, 'breadth')),
        heightDim: toNum(pick(row, 'heightDim')),
        availability: cleanStr(availability),
        inStock: inStock,
        prime: prime,
        seller: cleanStr(pick(row, 'seller')),
        warranty: normWarranty(pick(row, 'warranty')),
        scrapeDate: toISODate(pick(row, 'scrapeDate')) || toISODate(pick(row, 'scrapeTs')),
        scrapeTs: cleanStr(pick(row, 'scrapeTs')),
        recordStatus: cleanStr(pick(row, 'recordStatus')).toLowerCase(),
        raw: row
      };
      return rec;
    });
  }

  function cleanStr(v) { return v == null ? '' : String(v).trim(); }

  function normWarranty(v) {
    var s = cleanStr(v);
    if (!s) return '';
    return s.replace(/years?/i, 'Years').replace(/months?/i, 'Months');
  }

  function resolveStock(flag, avail) {
    var f = cleanStr(flag).toLowerCase();
    if (f.indexOf('out') >= 0) return 'Out of Stock';
    if (f.indexOf('in stock') >= 0 || f === 'instock') return 'In Stock';
    var a = cleanStr(avail).toLowerCase();
    if (a.indexOf('out of stock') >= 0) return 'Out of Stock';
    if (a.indexOf('in stock') >= 0 || a.indexOf('available') >= 0) return 'In Stock';
    return 'Unknown';
  }

  function resolveBool(v) {
    var s = cleanStr(v).toLowerCase();
    if (s === 'yes' || s === 'true' || s === '1') return 'Yes';
    if (s === 'no' || s === 'false' || s === '0') return 'No';
    return s ? cleanStr(v) : 'No';
  }

  // ---------------------------------------------------------------------------
  // Cleaning: drop obvious scraper stubs while KEEPING valid rows (including the
  // historical wow-price block that has a blank scrape date).
  // ---------------------------------------------------------------------------
  // Conservative cleaning: preserve parity with the source workbook. We only
  // remove explicit scraper failures and completely empty rows (no brand, no
  // title, no URL, no price). Borderline rows are KEPT so snapshot counts match
  // the workbook exactly; rows with a blank scrape date naturally fall under the
  // "(blank)" bucket rather than polluting any dated snapshot.
  function cleanRows(records) {
    var dropped = 0;
    var clean = records.filter(function (r) {
      var hasBrand = r.brand && !/^unknown$/i.test(r.brand);
      var hasPrice = (r.price != null && r.price > 0);
      var hasTitle = !!(r.title && r.title.trim());
      var hasUrl = !!(r.url && r.url.trim());
      var empty = !hasBrand && !hasPrice && !hasTitle && !hasUrl;
      var failed = r.recordStatus === 'failed' || r.recordStatus === 'blocked';
      if (empty || failed) { dropped++; return false; }
      return true;
    });
    return { clean: clean, dropped: dropped, total: records.length };
  }

  // ---------------------------------------------------------------------------
  // Dimension & measure catalogues used by the pivot + UI.
  // ---------------------------------------------------------------------------
  var DIMENSIONS = [
    { key: 'scrapeDate', label: 'Scrape Date', get: function (r) { return r.scrapeDate || '(blank)'; } },
    { key: 'platform',   label: 'Platform',    get: function (r) { return r.platform || 'Unknown'; } },
    { key: 'brand',      label: 'Brand',       get: function (r) { return r.brand || 'Unknown'; } },
    { key: 'type',       label: 'Product Type',get: function (r) { return r.type || 'Other'; } },
    { key: 'size',       label: 'Mattress Size',get: function (r) { return r.size || 'Unspecified'; } },
    { key: 'thickness',  label: 'Thickness (in)', get: function (r) { return r.thickness ? r.thickness + ' in' : '(blank)'; } },
    { key: 'dim',        label: 'Dimensions',  get: function (r) { return r.dim || '(blank)'; } },
    { key: 'length',     label: 'Length (in)', get: function (r) { return r.length != null ? String(r.length) : '(blank)'; } },
    { key: 'breadth',    label: 'Breadth (in)',get: function (r) { return r.breadth != null ? String(r.breadth) : '(blank)'; } },
    { key: 'height',     label: 'Height (in)', get: function (r) { return r.heightDim != null ? String(r.heightDim) : '(blank)'; } },
    { key: 'inStock',    label: 'Availability',get: function (r) { return r.inStock || 'Unknown'; } },
    { key: 'prime',      label: 'Prime / Assured', get: function (r) { return r.prime || 'No'; } },
    { key: 'seller',     label: 'Seller',      get: function (r) { return r.seller || '(blank)'; } },
    { key: 'warranty',   label: 'Warranty',    get: function (r) { return r.warranty || '(blank)'; } }
  ];

  var MEASURES = [
    { key: 'price',    label: 'Active Price',     fmt: 'currency', get: function (r) { return posOrNull(r.price); } },
    { key: 'effPrice', label: 'Effective Price',  fmt: 'currency', get: function (r) { return posOrNull(r.effPrice); } },
    { key: 'wow',      label: 'Wow / Best Price', fmt: 'currency', get: function (r) { return posOrNull(r.wow); } },
    { key: 'mrp',      label: 'MRP',              fmt: 'currency', get: function (r) { return posOrNull(r.mrp); } },
    { key: 'discount', label: 'Discount %',       fmt: 'percent',  get: function (r) { return nonNegOrNull(r.discount); } },
    { key: 'rating',   label: 'Star Rating',      fmt: 'rating',   get: function (r) { return posOrNull(r.rating); } },
    { key: 'reviews',  label: 'Reviews Count',    fmt: 'int',      get: function (r) { return nonNegOrNull(r.reviews); } },
    { key: 'bsr',      label: 'Bestseller Rank',  fmt: 'int',      get: function (r) { return posOrNull(r.bsr); } }
  ];

  var AGGS = [
    { key: 'avg', label: 'Average' },
    { key: 'sum', label: 'Sum' },
    { key: 'min', label: 'Minimum' },
    { key: 'max', label: 'Maximum' },
    { key: 'median', label: 'Median' },
    { key: 'count', label: 'Count (rows)' }
  ];

  function posOrNull(v) { return (v != null && v > 0) ? v : null; }
  function nonNegOrNull(v) { return (v != null && v >= 0) ? v : null; }

  function dimByKey(key) { for (var i = 0; i < DIMENSIONS.length; i++) if (DIMENSIONS[i].key === key) return DIMENSIONS[i]; return null; }
  function measureByKey(key) { for (var i = 0; i < MEASURES.length; i++) if (MEASURES[i].key === key) return MEASURES[i]; return null; }

  // Aggregate an array of numeric values; `count` is handled by the caller using
  // the number of rows in the cell (passed as rowCount).
  function aggregate(values, agg, rowCount) {
    if (agg === 'count') return rowCount;
    if (!values || values.length === 0) return null;
    var i, s = 0;
    switch (agg) {
      case 'sum':
        for (i = 0; i < values.length; i++) s += values[i];
        return s;
      case 'min':
        return Math.min.apply(null, values);
      case 'max':
        return Math.max.apply(null, values);
      case 'median': {
        var arr = values.slice().sort(function (a, b) { return a - b; });
        var m = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
      }
      case 'avg':
      default:
        for (i = 0; i < values.length; i++) s += values[i];
        return s / values.length;
    }
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  // filters: { dimKey: [allowedValue, ...], ... }  - empty/absent = no filter.
  function applyFilters(data, filters) {
    if (!filters) return data;
    var keys = Object.keys(filters).filter(function (k) { return filters[k] && filters[k].length; });
    if (!keys.length) return data;
    return data.filter(function (r) {
      for (var i = 0; i < keys.length; i++) {
        var dim = dimByKey(keys[i]);
        if (!dim) continue;
        var val = dim.get(r);
        if (filters[keys[i]].indexOf(val) < 0) return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Pivot engine. Supports up to 2 row fields and 2 column fields, subtotals on
  // the first level, grand totals, and a drill-down index keyed by cell id.
  //
  // cfg = { rows:[dimKey,...], cols:[dimKey,...], measure:measureKey, agg:aggKey,
  //         filters:{...}, includeRowSubtotals:bool, includeColSubtotals:bool }
  //
  // Returns:
  //   {
  //     rowFields, colFields, measure, agg,
  //     colTree: [{label, key, leaf:bool, children:[...], colId}],  // header structure
  //     leafCols: [{colId, path:[...], label}],
  //     rows: [{ path:[...], labels:[...], level, isSubtotal, isGrandTotal,
  //              cells: { colId: {value, count, cellId} }, rowId }],
  //     drill: { cellId: [recordIdx,...] }
  //   }
  // ---------------------------------------------------------------------------
  function buildPivot(data, cfg) {
    cfg = cfg || {};
    var rowFields = (cfg.rows || []).map(dimByKey).filter(Boolean).slice(0, 2);
    var colFields = (cfg.cols || []).map(dimByKey).filter(Boolean).slice(0, 2);
    var measure = measureByKey(cfg.measure) || MEASURES[0];
    var agg = cfg.agg || 'avg';
    var filtered = applyFilters(data, cfg.filters);

    // Distinct, sorted values for each row/col field.
    function distinctVals(field, list) {
      var seen = {};
      list.forEach(function (r) { seen[field.get(r)] = true; });
      return Object.keys(seen).sort(smartSort);
    }

    // ----- Build column leaf list (cartesian of col field values present) -----
    var leafCols = [];
    var colTree = [];
    if (colFields.length === 0) {
      leafCols.push({ colId: 'c0', path: [], label: measure.label });
      colTree.push({ label: measure.label, colId: 'c0', leaf: true, children: [] });
    } else {
      var l1vals = distinctVals(colFields[0], filtered);
      l1vals.forEach(function (v1, i1) {
        if (colFields.length === 1) {
          var cid = 'c_' + i1;
          leafCols.push({ colId: cid, path: [v1], label: v1 });
          colTree.push({ label: v1, colId: cid, leaf: true, children: [], path: [v1] });
        } else {
          var sub = filtered.filter(function (r) { return colFields[0].get(r) === v1; });
          var l2vals = distinctVals(colFields[1], sub);
          var node = { label: v1, leaf: false, children: [], path: [v1] };
          l2vals.forEach(function (v2, i2) {
            var cid2 = 'c_' + i1 + '_' + i2;
            leafCols.push({ colId: cid2, path: [v1, v2], label: v2 });
            node.children.push({ label: v2, colId: cid2, leaf: true, children: [], path: [v1, v2] });
          });
          colTree.push(node);
        }
      });
    }

    function colMatch(r, path) {
      for (var i = 0; i < path.length; i++) {
        if (colFields[i].get(r) !== path[i]) return false;
      }
      return true;
    }

    var drill = {};
    var resultRows = [];
    var cellSeq = 0;

    function cellFor(rowRecords, colPath, rowId) {
      var recs = colFields.length ? rowRecords.filter(function (r) { return colMatch(r, colPath); }) : rowRecords;
      var vals = [];
      var idxs = [];
      recs.forEach(function (r) {
        idxs.push(r.idx);
        var mv = measure.get(r);
        if (mv != null) vals.push(mv);
      });
      var cellId = 'cell_' + (cellSeq++);
      drill[cellId] = idxs;
      return { value: aggregate(vals, agg, recs.length), count: recs.length, n: vals.length, cellId: cellId };
    }

    function makeRow(records, path, labels, level, flags) {
      var rowId = 'r_' + resultRows.length;
      var cells = {};
      leafCols.forEach(function (lc) {
        cells[lc.colId] = cellFor(records, lc.path, rowId);
      });
      // grand-total column (across all leaf cols) for this row
      var allVals = [];
      records.forEach(function (r) { var mv = measure.get(r); if (mv != null) allVals.push(mv); });
      cells['__total'] = (function () {
        var cid = 'cell_' + (cellSeq++);
        drill[cid] = records.map(function (r) { return r.idx; });
        return { value: aggregate(allVals, agg, records.length), count: records.length, n: allVals.length, cellId: cid };
      })();
      resultRows.push({
        path: path, labels: labels, level: level,
        isSubtotal: !!(flags && flags.subtotal),
        isGrandTotal: !!(flags && flags.grand),
        cells: cells, rowId: rowId
      });
    }

    if (rowFields.length === 0) {
      makeRow(filtered, [], ['All'], 0, { grand: true });
    } else {
      var r1vals = distinctVals(rowFields[0], filtered);
      r1vals.forEach(function (v1) {
        var g1 = filtered.filter(function (r) { return rowFields[0].get(r) === v1; });
        if (rowFields.length === 1) {
          makeRow(g1, [v1], [v1], 0, {});
        } else {
          var r2vals = distinctVals(rowFields[1], g1);
          r2vals.forEach(function (v2) {
            var g2 = g1.filter(function (r) { return rowFields[1].get(r) === v2; });
            makeRow(g2, [v1, v2], [v1, v2], 1, {});
          });
          if (cfg.includeRowSubtotals !== false) {
            makeRow(g1, [v1], [v1 + ' Total'], 0, { subtotal: true });
          }
        }
      });
      // Grand total row across everything
      makeRow(filtered, [], ['Grand Total'], 0, { grand: true });
    }

    return {
      rowFields: rowFields.map(function (f) { return { key: f.key, label: f.label }; }),
      colFields: colFields.map(function (f) { return { key: f.key, label: f.label }; }),
      measure: { key: measure.key, label: measure.label, fmt: measure.fmt },
      agg: agg,
      colTree: colTree,
      leafCols: leafCols,
      rows: resultRows,
      drill: drill,
      filteredCount: filtered.length
    };
  }

  // Natural-ish sort: numbers numerically, "(blank)" last, otherwise alpha.
  function smartSort(a, b) {
    if (a === b) return 0;
    if (a === '(blank)') return 1;
    if (b === '(blank)') return -1;
    var na = parseFloat(a), nb = parseFloat(b);
    var aNum = !isNaN(na) && /^[\d.]/.test(a);
    var bNum = !isNaN(nb) && /^[\d.]/.test(b);
    if (aNum && bNum) return na - nb;
    return String(a).localeCompare(String(b));
  }

  // ---------------------------------------------------------------------------
  // KPI + summary builders (power the dashboard, type table, brand table).
  // ---------------------------------------------------------------------------
  function latestSnapshot(data) {
    var dates = {};
    data.forEach(function (r) { if (r.scrapeDate) dates[r.scrapeDate] = true; });
    var list = Object.keys(dates).sort();
    return list.length ? list[list.length - 1] : '';
  }

  function distinctDates(data) {
    var d = {};
    data.forEach(function (r) { if (r.scrapeDate) d[r.scrapeDate] = true; });
    return Object.keys(d).sort();
  }
  function distinctValues(data, dimKey) {
    var dim = dimByKey(dimKey); if (!dim) return [];
    var seen = {};
    data.forEach(function (r) { seen[dim.get(r)] = true; });
    return Object.keys(seen).sort(smartSort);
  }

  function mean(arr) { if (!arr.length) return null; var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }

  function computeKpis(data) {
    var prices = [], ratings = [], discounts = [];
    var brands = {}, platforms = {}, inStock = 0, stockKnown = 0;
    data.forEach(function (r) {
      var p = posOrNull(r.price); if (p != null) prices.push(p);
      var rt = posOrNull(r.rating); if (rt != null) ratings.push(rt);
      var dc = nonNegOrNull(r.discount); if (dc != null) discounts.push(dc);
      brands[r.brand] = true; platforms[r.platform] = true;
      if (r.inStock === 'In Stock' || r.inStock === 'Out of Stock') {
        stockKnown++; if (r.inStock === 'In Stock') inStock++;
      }
    });
    return {
      rows: data.length,
      brands: Object.keys(brands).length,
      platforms: Object.keys(platforms).length,
      dates: distinctDates(data).length,
      avgPrice: mean(prices),
      avgRating: mean(ratings),
      avgDiscount: mean(discounts),
      inStockPct: stockKnown ? inStock / stockKnown : null
    };
  }

  // Per-group summary (Type Master / brand table). groupDimKey defaults to type.
  function groupSummary(data, groupDimKey) {
    var dim = dimByKey(groupDimKey) || dimByKey('type');
    var groups = {};
    data.forEach(function (r) {
      var k = dim.get(r);
      if (!groups[k]) groups[k] = { key: k, count: 0, inStock: 0, outStock: 0, prime: 0, prices: [], wow: [], discounts: [], ratings: [], reviews: 0, lowest: null, ranks: [] };
      var g = groups[k];
      g.count++;
      if (r.inStock === 'In Stock') g.inStock++;
      else if (r.inStock === 'Out of Stock') g.outStock++;
      if (r.prime === 'Yes') g.prime++;
      var p = posOrNull(r.price); if (p != null) { g.prices.push(p); g.lowest = (g.lowest == null ? p : Math.min(g.lowest, p)); }
      var w = posOrNull(r.wow); if (w != null) g.wow.push(w);
      var d = nonNegOrNull(r.discount); if (d != null) g.discounts.push(d);
      var rt = posOrNull(r.rating); if (rt != null) g.ratings.push(rt);
      var rv = nonNegOrNull(r.reviews); if (rv != null) g.reviews += rv;
      var bn = posOrNull(r.bsr); if (bn != null) g.ranks.push(bn);
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      // Match the workbook: % in stock is in-stock models / total models.
      // Ranking uses Bestseller Rank: a SMALLER number is a better (higher) rank,
      // so best (top) rank = min, worst (lowest) rank = max.
      return {
        key: g.key, count: g.count, inStock: g.inStock, outStock: g.outStock,
        pctInStock: g.count ? g.inStock / g.count : null,
        prime: g.prime, avgPrice: mean(g.prices), avgWow: mean(g.wow),
        lowest: g.lowest, avgDiscount: mean(g.discounts), avgRating: mean(g.ratings),
        totalReviews: g.reviews,
        avgRank: mean(g.ranks),
        bestRank: g.ranks.length ? Math.min.apply(null, g.ranks) : null,
        worstRank: g.ranks.length ? Math.max.apply(null, g.ranks) : null,
        rankedCount: g.ranks.length
      };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  // Maps comparison-filter option keys to their dimension key.
  var OPT_DIM = {
    type: 'type', size: 'size', date: 'scrapeDate', platform: 'platform',
    thickness: 'thickness', length: 'length', breadth: 'breadth', height: 'height', inStock: 'inStock'
  };

  // Shared row matcher for the comparison filters. Each opt, when present and not
  // 'All', must equal the corresponding DIMENSION value for the row. Comparing
  // through dim.get keeps the option values (which are produced by dim.get via
  // distinctValues) and the row side on exactly the same representation - so
  // "6 in" matches "6 in" and a "(blank)" selection matches rows with no value.
  function rowMatchesOpts(r, opts) {
    if (!opts) return true;
    for (var k in OPT_DIM) {
      if (!Object.prototype.hasOwnProperty.call(opts, k)) continue;
      var val = opts[k];
      if (!val || val === 'All') continue;
      var dim = dimByKey(OPT_DIM[k]);
      if (dim && dim.get(r) !== val) return false;
    }
    return true;
  }

  // A-vs-B comparator (replicates the workbook "A vs B Compare" sheet).
  function compareAvsB(data, brandA, brandB, opts) {
    opts = opts || {};
    function subset(brand) {
      return data.filter(function (r) {
        if (r.brand !== brand) return false;
        return rowMatchesOpts(r, opts);
      });
    }
    function metrics(list) {
      var prices = [], wow = [], disc = [], rate = [], rev = 0, bsr = [], inStock = 0, outStock = 0, prime = 0, lowest = null;
      list.forEach(function (r) {
        var p = posOrNull(r.price); if (p != null) { prices.push(p); lowest = lowest == null ? p : Math.min(lowest, p); }
        var w = posOrNull(r.wow); if (w != null) wow.push(w);
        var d = nonNegOrNull(r.discount); if (d != null) disc.push(d);
        var rt = posOrNull(r.rating); if (rt != null) rate.push(rt);
        var rv = nonNegOrNull(r.reviews); if (rv != null) rev += rv;
        var b = posOrNull(r.bsr); if (b != null) bsr.push(b);
        if (r.inStock === 'In Stock') inStock++; else if (r.inStock === 'Out of Stock') outStock++;
        if (r.prime === 'Yes') prime++;
      });
      return {
        count: list.length, inStock: inStock, outStock: outStock,
        pctInStock: list.length ? inStock / list.length : null,
        prime: prime, avgPrice: mean(prices), avgWow: mean(wow), lowest: lowest,
        avgDiscount: mean(disc), avgRating: mean(rate), totalReviews: rev, avgBsr: mean(bsr)
      };
    }
    return { a: metrics(subset(brandA)), b: metrics(subset(brandB)), brandA: brandA, brandB: brandB };
  }

  // ---------------------------------------------------------------------------
  // Alert engine - scans the data for "what is wrong" from the anchor brand's
  // point of view and returns structured, severity-ranked alerts plus action
  // items. Deterministic and bounded. Powers the Alert Center and email push.
  // ---------------------------------------------------------------------------
  function buildAlerts(data, anchorBrand, opts) {
    opts = opts || {};
    var ratingFloor = opts.ratingFloor != null ? opts.ratingFloor : 4.2;
    var undercutHighPct = opts.undercutHighPct != null ? opts.undercutHighPct : 15;
    var undercutMedPct = opts.undercutMedPct != null ? opts.undercutMedPct : 7;
    var maxPerCat = opts.maxPerCategory || 25;

    function inr(v) { return 'Rs ' + Math.round(v).toLocaleString('en-IN'); }
    function short(s) { s = String(s == null ? '' : s); return s.length > 50 ? s.slice(0, 50) + '...' : s; }
    function specKey(r) { return [r.type, r.size, r.thickness, r.dim].join('|'); }

    var anchorItems = data.filter(function (r) { return r.brand === anchorBrand; });
    var compItems = data.filter(function (r) { return r.brand !== anchorBrand; });
    var alerts = [];

    // Cheapest competitor per identical spec
    var compBySpec = {};
    compItems.forEach(function (r) {
      var p = posOrNull(r.price); if (p == null) return;
      var k = specKey(r);
      if (!compBySpec[k] || p < compBySpec[k].price) compBySpec[k] = r;
    });

    // 1) Identical-spec undercuts
    var undercuts = [];
    anchorItems.forEach(function (a) {
      var ap = posOrNull(a.price); if (ap == null) return;
      var c = compBySpec[specKey(a)];
      if (c && c.price < ap) {
        var upct = Math.round((ap - c.price) / ap * 100);
        if (upct >= 1) undercuts.push({ a: a, c: c, gap: ap - c.price, pct: upct }); // ignore negligible (-0%) gaps
      }
    });
    undercuts.sort(function (x, y) { return y.pct - x.pct; });
    undercuts.slice(0, maxPerCat).forEach(function (u) {
      alerts.push({
        severity: u.pct >= undercutHighPct ? 'high' : (u.pct >= undercutMedPct ? 'medium' : 'low'),
        type: 'Undercut', metric: '-' + u.pct + '%', brand: u.c.brand, model: u.a.title,
        title: anchorBrand + ' undercut by ' + u.c.brand,
        detail: u.c.brand + ' lists an identical ' + u.a.type + ' ' + u.a.size + ' at ' + inr(u.c.price) + ' vs your ' + inr(u.a.price) + ' (-' + u.pct + '%).',
        action: 'Review pricing or add a best-price/bank offer on "' + short(u.a.title) + '".'
      });
    });

    // 2) Low-rated anchor listings
    anchorItems.filter(function (r) { var rt = posOrNull(r.rating); return rt != null && rt < ratingFloor; })
      .sort(function (a, b) { return a.rating - b.rating; }).slice(0, maxPerCat).forEach(function (r) {
        alerts.push({
          severity: r.rating < 3.8 ? 'high' : 'medium', type: 'Rating', metric: r.rating.toFixed(1) + ' stars',
          brand: anchorBrand, model: r.title, title: 'Low rating on ' + anchorBrand + ' listing',
          detail: '"' + short(r.title) + '" is rated ' + r.rating.toFixed(1) + ' (' + (r.reviews || 0) + ' reviews), below the ' + ratingFloor + ' floor.',
          action: 'Audit review sentiment and listing quality for "' + short(r.title) + '".'
        });
      });

    // 3) Out-of-stock anchor listings
    anchorItems.filter(function (r) { return r.inStock === 'Out of Stock'; }).slice(0, maxPerCat).forEach(function (r) {
      alerts.push({
        severity: 'medium', type: 'Stock', metric: 'Out of stock', brand: anchorBrand, model: r.title,
        title: anchorBrand + ' listing out of stock',
        detail: '"' + short(r.title) + '" (' + r.platform + ') is currently out of stock.',
        action: 'Restock or replace "' + short(r.title) + '" to avoid lost demand.'
      });
    });

    // 4) Competitor price drops between the last two snapshots
    var dates = distinctDates(data);
    if (dates.length >= 2) {
      var dPrev = dates[dates.length - 2], dLast = dates[dates.length - 1];
      var prevMap = {}, lastMap = {};
      // Require a STABLE identity (pid or url); never fall back to title, which
      // would pair unrelated products. On duplicates within a snapshot, keep the
      // cheapest priced row deterministically so the prev/last pairing is defined.
      function assignSnap(map, r, key) {
        var ex = map[key]; if (!ex) { map[key] = r; return; }
        var pe = posOrNull(ex.price), pr = posOrNull(r.price);
        if (pr != null && (pe == null || pr < pe)) map[key] = r;
      }
      data.forEach(function (r) {
        var key = (r.pid && String(r.pid).trim()) ? String(r.pid).trim()
                : ((r.url && String(r.url).trim()) ? String(r.url).trim() : null);
        if (!key) return;
        if (r.scrapeDate === dPrev) assignSnap(prevMap, r, key);
        else if (r.scrapeDate === dLast) assignSnap(lastMap, r, key);
      });
      var drops = [];
      Object.keys(lastMap).forEach(function (key) {
        var l = lastMap[key], p = prevMap[key]; if (!p || l.brand === anchorBrand) return;
        var pl = posOrNull(l.price), pp = posOrNull(p.price);
        if (pl != null && pp != null && pl < pp) { var pct = Math.round((pp - pl) / pp * 100); if (pct >= 5) drops.push({ l: l, from: pp, to: pl, pct: pct }); }
      });
      drops.sort(function (x, y) { return y.pct - x.pct; });
      drops.slice(0, maxPerCat).forEach(function (d) {
        alerts.push({
          severity: d.pct >= 12 ? 'high' : 'medium', type: 'Competitor price drop', metric: '-' + d.pct + '%',
          brand: d.l.brand, model: d.l.title, title: d.l.brand + ' cut price ' + d.pct + '%',
          detail: d.l.brand + ' dropped "' + short(d.l.title) + '" from ' + inr(d.from) + ' to ' + inr(d.to) + ' (' + dPrev + ' to ' + dLast + ').',
          action: 'Reassess competitiveness vs ' + d.l.brand + ' in this segment.'
        });
      });
    }

    // 5) Discount-strategy gap (anchor materially less promotional than market)
    var bsum = groupSummary(data, 'brand');
    var anchorRow = bsum.filter(function (b) { return b.key === anchorBrand; })[0];
    var market = bsum.filter(function (b) { return b.key !== anchorBrand && b.avgDiscount != null; });
    var marketDisc = market.length ? market.reduce(function (s, b) { return s + b.avgDiscount; }, 0) / market.length : null;
    if (anchorRow && anchorRow.avgDiscount != null && marketDisc != null && (marketDisc - anchorRow.avgDiscount) >= 10) {
      var gap = Math.round(marketDisc - anchorRow.avgDiscount);
      alerts.push({
        severity: 'low', type: 'Discount gap', metric: gap + 'pt gap', brand: anchorBrand, model: '',
        title: anchorBrand + ' less promotional than market',
        detail: anchorBrand + ' average discount is ' + anchorRow.avgDiscount.toFixed(1) + '% vs market ' + marketDisc.toFixed(1) + '%.',
        action: 'Consider targeted promotions to close the ' + gap + 'pt discount gap.'
      });
    }

    var order = { high: 0, medium: 1, low: 2 };
    alerts.sort(function (a, b) { return order[a.severity] - order[b.severity]; });
    var counts = { high: 0, medium: 0, low: 0 };
    alerts.forEach(function (a) { counts[a.severity]++; });
    var actionItems = [];
    alerts.forEach(function (a) { if (a.severity !== 'low' && actionItems.indexOf(a.action) < 0 && actionItems.length < 12) actionItems.push(a.action); });
    return { alerts: alerts, counts: counts, total: alerts.length, anchor: anchorBrand, actionItems: actionItems, dates: dates };
  }

  // ---------------------------------------------------------------------------
  // Minimal SQL engine (SELECT ... FROM ? [WHERE ...] [GROUP BY ...] [ORDER BY ...]).
  // Operates on flat row objects (caller flattens canonical records).
  // ---------------------------------------------------------------------------
  function tokenize(str) {
    var tokens = [], i = 0;
    while (i < str.length) {
      var ch = str[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === "'" || ch === '"') {
        var q = ch, val = ''; i++;
        while (i < str.length && str[i] !== q) { if (str[i] === '\\') i++; val += str[i]; i++; }
        i++; tokens.push({ type: 'STRING', value: val }); continue;
      }
      if (/[0-9]/.test(ch)) {
        var num = '';
        while (i < str.length && /[0-9.]/.test(str[i])) { num += str[i]; i++; }
        tokens.push({ type: 'NUMBER', value: parseFloat(num) }); continue;
      }
      if (ch === '(' || ch === ')') { tokens.push({ type: 'PAREN', value: ch }); i++; continue; }
      var two = str.substr(i, 2);
      if (two === '!=' || two === '<>' || two === '<=' || two === '>=' || two === '==') {
        tokens.push({ type: 'OP', value: two === '<>' ? '!=' : two }); i += 2; continue;
      }
      if (two === '&&' || two === '||') { tokens.push({ type: 'OP', value: two }); i += 2; continue; }
      if ('+-*/=<>'.indexOf(ch) >= 0) { tokens.push({ type: 'OP', value: ch === '=' ? '==' : ch }); i++; continue; }
      if (/[a-zA-Z_$]/.test(ch)) {
        var w = '';
        while (i < str.length && /[a-zA-Z0-9_$]/.test(str[i])) { w += str[i]; i++; }
        var up = w.toUpperCase();
        if (up === 'AND') tokens.push({ type: 'OP', value: '&&' });
        else if (up === 'OR') tokens.push({ type: 'OP', value: '||' });
        else if (up === 'LIKE') tokens.push({ type: 'OP', value: 'LIKE' });
        else tokens.push({ type: 'ID', value: w });
        continue;
      }
      i++;
    }
    return tokens;
  }
  var PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, 'LIKE': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
  function shunt(tokens) {
    var out = [], ops = [];
    tokens.forEach(function (t) {
      if (t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'ID') out.push(t);
      else if (t.type === 'OP') {
        while (ops.length) {
          var top = ops[ops.length - 1];
          if (top.type === 'OP' && PREC[top.value] >= PREC[t.value]) out.push(ops.pop());
          else break;
        }
        ops.push(t);
      } else if (t.type === 'PAREN' && t.value === '(') ops.push(t);
      else if (t.type === 'PAREN' && t.value === ')') {
        var found = false;
        while (ops.length) { var o = ops[ops.length - 1]; if (o.type === 'PAREN' && o.value === '(') { ops.pop(); found = true; break; } out.push(ops.pop()); }
        if (!found) throw new Error('Mismatched parentheses');
      }
    });
    while (ops.length) { var x = ops.pop(); if (x.type === 'PAREN') throw new Error('Mismatched parentheses'); out.push(x); }
    return out;
  }
  function evalRpn(rpn, row) {
    var st = [], lower = {};
    Object.keys(row).forEach(function (k) { lower[k.toLowerCase()] = row[k]; });
    rpn.forEach(function (t) {
      if (t.type === 'NUMBER' || t.type === 'STRING') st.push(t.value);
      else if (t.type === 'ID') { var n = t.value.toLowerCase(); st.push(lower.hasOwnProperty(n) ? lower[n] : null); }
      else if (t.type === 'OP') {
        var r = st.pop(), l = st.pop();
        switch (t.value) {
          case '+': st.push((l || 0) + (r || 0)); break;
          case '-': st.push((l || 0) - (r || 0)); break;
          case '*': st.push((l || 0) * (r || 0)); break;
          case '/': st.push((l || 0) / (r || 1)); break;
          case '==': st.push(String(l).toLowerCase() === String(r).toLowerCase() || l == r); break;
          case '!=': st.push(l != r); break;
          case '<': st.push(l < r); break;
          case '>': st.push(l > r); break;
          case '<=': st.push(l <= r); break;
          case '>=': st.push(l >= r); break;
          case '&&': st.push(l && r); break;
          case '||': st.push(l || r); break;
          case 'LIKE': {
            var ls = String(l || '').toLowerCase(), rs = String(r || '').toLowerCase();
            if (rs.charAt(0) === '%' && rs.charAt(rs.length - 1) === '%') st.push(ls.indexOf(rs.slice(1, -1)) >= 0);
            else if (rs.charAt(0) === '%') st.push(ls.lastIndexOf(rs.slice(1)) === ls.length - rs.slice(1).length && ls.length >= rs.length - 1);
            else if (rs.charAt(rs.length - 1) === '%') st.push(ls.indexOf(rs.slice(0, -1)) === 0);
            else st.push(ls === rs);
            break;
          }
          default: throw new Error('Unknown operator ' + t.value);
        }
      }
    });
    if (st.length !== 1) throw new Error('Bad expression');
    return st[0];
  }
  function parseAlias(f) {
    var m = f.match(/(.+?)\s+AS\s+(.+?)$/i);
    if (m) return { expr: m[1].trim(), alias: m[2].trim() };
    return { expr: f.trim(), alias: f.trim() };
  }
  function runSql(sql, dataset) {
    var cleaned = sql.replace(/\s+/g, ' ').trim();
    if (cleaned.charAt(cleaned.length - 1) === ';') cleaned = cleaned.slice(0, -1).trim();
    var sel = cleaned.match(/SELECT\s+(.+?)\s+FROM\s*\?/i);
    if (!sel) throw new Error("Query must be: SELECT [fields] FROM ? [WHERE ...]");
    var fields = sel[1].trim();
    var where = null, w = cleaned.match(/WHERE\s+(.+?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|$)/i); if (w) where = w[1].trim();
    var groupBy = null, g = cleaned.match(/GROUP\s+BY\s+(.+?)(?:\s+ORDER\s+BY|$)/i); if (g) groupBy = g[1].trim();
    var orderBy = null, dir = 'ASC', o = cleaned.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
    if (o) { var parts = o[1].trim().split(/\s+/); orderBy = parts[0]; if (parts[1] && parts[1].toUpperCase() === 'DESC') dir = 'DESC'; }
    var limit = null, lm = cleaned.match(/LIMIT\s+(\d+)/i); if (lm) limit = parseInt(lm[1], 10);

    var rows = dataset;
    if (where) { var rpn = shunt(tokenize(where)); rows = rows.filter(function (r) { return evalRpn(rpn, r); }); }
    var out = groupBy ? groupAgg(rows, groupBy, fields) : project(rows, fields);
    if (orderBy) {
      out.sort(function (a, b) {
        var ka = orderBy, lk = orderBy.toLowerCase();
        Object.keys(a).forEach(function (k) { if (k.toLowerCase() === lk) ka = k; });
        var va = a[ka], vb = b[ka];
        if (va == null) return 1; if (vb == null) return -1;
        if (typeof va === 'string') return dir === 'ASC' ? va.localeCompare(vb) : vb.localeCompare(va);
        return dir === 'ASC' ? va - vb : vb - va;
      });
    }
    if (limit != null) out = out.slice(0, limit);
    return out;
  }
  function project(list, fieldsStr) {
    if (fieldsStr === '*') return list.slice();
    var fields = splitTop(fieldsStr);
    return list.map(function (row) {
      var proj = {}, lower = {};
      Object.keys(row).forEach(function (k) { lower[k.toLowerCase()] = k; });
      fields.forEach(function (f) {
        var pa = parseAlias(f), le = pa.expr.toLowerCase();
        if (lower.hasOwnProperty(le)) proj[pa.alias] = row[lower[le]];
        else { try { proj[pa.alias] = evalRpn(shunt(tokenize(pa.expr)), row); } catch (e) { proj[pa.alias] = null; } }
      });
      return proj;
    });
  }
  function groupAgg(list, groupField, fieldsStr) {
    var groups = {}, gk = groupField;
    if (list.length) Object.keys(list[0]).forEach(function (k) { if (k.toLowerCase() === groupField.toLowerCase()) gk = k; });
    list.forEach(function (r) { var key = r[gk] == null ? 'Unknown' : r[gk]; (groups[key] = groups[key] || []).push(r); });
    var fields = splitTop(fieldsStr), out = [];
    Object.keys(groups).forEach(function (key) {
      var rows = groups[key], proj = {};
      fields.forEach(function (f) {
        var pa = parseAlias(f), le = pa.expr.toLowerCase(), m;
        if (le === groupField.toLowerCase()) proj[pa.alias] = key;
        else if (le.indexOf('count(*)') >= 0) proj[pa.alias] = rows.length;
        else if ((m = le.match(/avg\((.+?)\)/))) proj[pa.alias] = round1(meanCol(rows, m[1]));
        else if ((m = le.match(/sum\((.+?)\)/))) proj[pa.alias] = sumCol(rows, m[1]);
        else if ((m = le.match(/max\((.+?)\)/))) proj[pa.alias] = extreme(rows, m[1], true);
        else if ((m = le.match(/min\((.+?)\)/))) proj[pa.alias] = extreme(rows, m[1], false);
        else proj[pa.alias] = rows.length ? colVal(rows[0], pa.expr) : null;
      });
      out.push(proj);
    });
    return out;
  }
  function splitTop(s) {
    var res = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') depth++; if (c === ')') depth--;
      if (c === ',' && depth === 0) { res.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) res.push(cur.trim());
    return res;
  }
  function colKey(row, name) { var lk = name.toLowerCase(), key = name; Object.keys(row).forEach(function (k) { if (k.toLowerCase() === lk) key = k; }); return key; }
  function colVal(row, name) { return row[colKey(row, name)]; }
  function meanCol(rows, col) { var k = rows.length ? colKey(rows[0], col.trim()) : col, s = 0, n = 0; rows.forEach(function (r) { var v = parseFloat(r[k]); if (!isNaN(v)) { s += v; n++; } }); return n ? s / n : 0; }
  function sumCol(rows, col) { var k = rows.length ? colKey(rows[0], col.trim()) : col, s = 0; rows.forEach(function (r) { var v = parseFloat(r[k]); if (!isNaN(v)) s += v; }); return s; }
  function extreme(rows, col, max) { var k = rows.length ? colKey(rows[0], col.trim()) : col, vals = rows.map(function (r) { return parseFloat(r[k]); }).filter(function (v) { return !isNaN(v); }); if (!vals.length) return 0; return max ? Math.max.apply(null, vals) : Math.min.apply(null, vals); }
  function round1(v) { return Math.round(v * 10) / 10; }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------
  var ApexEngine = {
    toNum: toNum, toISODate: toISODate, classifyFromTitle: classifyFromTitle,
    buildHeaderMap: buildHeaderMap, normalizeRows: normalizeRows, cleanRows: cleanRows,
    DIMENSIONS: DIMENSIONS, MEASURES: MEASURES, AGGS: AGGS,
    dimByKey: dimByKey, measureByKey: measureByKey, aggregate: aggregate,
    applyFilters: applyFilters, buildPivot: buildPivot,
    latestSnapshot: latestSnapshot, distinctDates: distinctDates, distinctValues: distinctValues,
    computeKpis: computeKpis, groupSummary: groupSummary, compareAvsB: compareAvsB,
    rowMatchesOpts: rowMatchesOpts, buildAlerts: buildAlerts,
    runSql: runSql, smartSort: smartSort
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ApexEngine;
  root.ApexEngine = ApexEngine;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
