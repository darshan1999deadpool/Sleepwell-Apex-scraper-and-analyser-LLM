/* ============================================================================
   Apex Analyzer Pro - Back-test harness
   Runs the real engine against the full 32,901-row workbook export and asserts
   that pivot/aggregation/summary outputs match the workbook's own cached values
   (Type Master, A-vs-B, pivot view) to the decimal. Pure logic, no browser.
   Run with:  node test/backtest.js
   ========================================================================== */
var fs = require('fs');
var path = require('path');
var E = require('../engine.js');

var FIXTURE = process.env.APEX_FIXTURE ||
  'C:\\Users\\DARSHAN\\Desktop\\apex_test_data\\consolidated.json';

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function near(a, b, tol) { return a != null && b != null && Math.abs(a - b) <= (tol == null ? 0.01 : tol); }

console.log('Loading fixture: ' + FIXTURE);
var raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
console.log('Raw rows: ' + raw.length);

// --- Normalisation -----------------------------------------------------------
var hm = E.buildHeaderMap(Object.keys(raw[0]));
console.log('\nHeader map resolved fields: ' + Object.keys(hm).length + '/' + Object.keys(require('../engine.js').DIMENSIONS).length);
ok('brand maps to Brand (Std)', hm.brandStd === 'Brand (Std)', hm.brandStd);
ok('price maps to Active Price', hm.activePrice === 'Active Price', hm.activePrice);
ok('type maps to Product Type', hm.productType === 'Product Type', hm.productType);
ok('size maps to Mattress Size', hm.size === 'Mattress Size', hm.size);
ok('scrapeDate maps to Scrape Date', hm.scrapeDate === 'Scrape Date', hm.scrapeDate);
ok('wow maps to Wow/Best Price', hm.wow === 'Wow/Best Price (Hist)', hm.wow);

var norm = E.normalizeRows(raw);
ok('normalized count == raw count', norm.length === raw.length, norm.length + '');

// Brand standardisation merges KURLON + Kurl-On -> Kurlon
var rawKurlonish = raw.filter(function (r) { return /kurl/i.test(r['Brand Name'] || ''); }).length;
var normKurlon = norm.filter(function (r) { return r.brand === 'Kurlon'; }).length;
ok('KURLON + Kurl-On merge into "Kurlon"', normKurlon === rawKurlonish, normKurlon + ' == ' + rawKurlonish);

// --- Snapshot integrity (Excel: latest snapshot 2026-06-19 has 8087 rows) ----
var d0619 = norm.filter(function (r) { return r.scrapeDate === '2026-06-19'; });
ok('latest snapshot detected = 2026-06-19', E.latestSnapshot(norm) === '2026-06-19', E.latestSnapshot(norm));
ok('2026-06-19 row count == 8087 (Type Master ALL)', d0619.length === 8087, d0619.length + '');

// --- Cleaning keeps the snapshot intact, drops blank-date stubs --------------
var cleaned = E.cleanRows(norm);
console.log('\nCleaning: kept ' + cleaned.clean.length + ', dropped ' + cleaned.dropped);
var clean0619 = cleaned.clean.filter(function (r) { return r.scrapeDate === '2026-06-19'; });
ok('cleaning does NOT drop any 2026-06-19 rows', clean0619.length === 8087, clean0619.length + '');
var wowRows = cleaned.clean.filter(function (r) { return r.wow != null && r.wow > 0; });
ok('historical wow-price block preserved (>6000 rows)', wowRows.length >= 6000, wowRows.length + '');

// --- Type Master replication (snapshot 2026-06-19) ---------------------------
var typeSummary = E.groupSummary(d0619, 'type');
function findType(k) { for (var i = 0; i < typeSummary.length; i++) if (typeSummary[i].key === k) return typeSummary[i]; return null; }
var grid = findType('Grid');
ok('Type Master: Grid model count == 695', grid && grid.count === 695, grid ? grid.count + '' : 'none');
ok('Type Master: Grid avg price == 19475.161', grid && near(grid.avgPrice, 19475.161481481482, 0.01), grid ? grid.avgPrice : 'none');
var coir = findType('Coir');
ok('Type Master: Coir avg price == 12416.874', coir && near(coir.avgPrice, 12416.874226804124, 0.01), coir ? coir.avgPrice : 'none');
ok('Type Master: Coir %% in-stock == 0.98571', coir && near(coir.pctInStock, 0.9857142857142858, 0.0001), coir ? coir.pctInStock : 'none');
var typeTotal = typeSummary.reduce(function (s, t) { return s + t.count; }, 0);
ok('Type Master: type counts sum to 8087', typeTotal === 8087, typeTotal + '');

// --- A vs B replication (snapshot 2026-06-19, Sleepwell vs Kurlon, All/All) --
var avb = E.compareAvsB(d0619, 'Sleepwell', 'Kurlon', { type: 'All', size: 'All' });
ok('A-vs-B: Sleepwell count == 4016', avb.a.count === 4016, avb.a.count + '');
ok('A-vs-B: Kurlon count == 2758', avb.b.count === 2758, avb.b.count + '');
ok('A-vs-B: Sleepwell avg price == 15965.599', near(avb.a.avgPrice, 15965.599348534202, 0.01), avb.a.avgPrice + '');
ok('A-vs-B: Kurlon avg price == 13224.654', near(avb.b.avgPrice, 13224.654058313632, 0.01), avb.b.avgPrice + '');
ok('A-vs-B: Sleepwell in-stock == 3146', avb.a.inStock === 3146, avb.a.inStock + '');
ok('A-vs-B: Sleepwell %% in-stock == 0.78337', near(avb.a.pctInStock, 0.7833665338645418, 0.0001), avb.a.pctInStock + '');
ok('A-vs-B: Kurlon %% in-stock == 0.86439', near(avb.b.pctInStock, 0.864394488759971, 0.0001), avb.b.pctInStock + '');
ok('A-vs-B: Kurlon out-of-stock == 149', avb.b.outStock === 149, avb.b.outStock + '');
ok('A-vs-B: Sleepwell total reviews == 657140', avb.a.totalReviews === 657140, avb.a.totalReviews + '');

// --- Pivot engine: rows=Type, cols=Scrape Date, measure=price, agg=count -----
var pCount = E.buildPivot(cleaned.clean, { rows: ['type'], cols: ['scrapeDate'], measure: 'price', agg: 'count', includeRowSubtotals: false });
var dateCol = pCount.leafCols.filter(function (c) { return c.label === '2026-06-19'; })[0];
ok('pivot has a 2026-06-19 column', !!dateCol, dateCol ? dateCol.label : 'none');
var gridRow = pCount.rows.filter(function (r) { return r.labels[0] === 'Grid'; })[0];
ok('pivot count Grid x 2026-06-19 == 695', gridRow && dateCol && gridRow.cells[dateCol.colId].value === 695,
   gridRow && dateCol ? gridRow.cells[dateCol.colId].value + '' : 'none');
// Column total for 2026-06-19 across all type rows == 8087
var grandRow = pCount.rows.filter(function (r) { return r.isGrandTotal; })[0];
ok('pivot grand-total row exists', !!grandRow);
ok('pivot count total for 2026-06-19 == 8087', grandRow && dateCol && grandRow.cells[dateCol.colId].value === 8087,
   grandRow && dateCol ? grandRow.cells[dateCol.colId].value + '' : 'none');

// --- Pivot engine: rows=Brand, cols=Scrape Date, measure=price, agg=avg ------
var pAvg = E.buildPivot(cleaned.clean, { rows: ['brand'], cols: ['scrapeDate'], measure: 'price', agg: 'avg', includeRowSubtotals: false });
var dCol = pAvg.leafCols.filter(function (c) { return c.label === '2026-06-19'; })[0];
var swRow = pAvg.rows.filter(function (r) { return r.labels[0] === 'Sleepwell'; })[0];
ok('pivot avg Sleepwell x 2026-06-19 == 15965.599',
   swRow && dCol && near(swRow.cells[dCol.colId].value, 15965.599348534202, 0.01),
   swRow && dCol ? swRow.cells[dCol.colId].value : 'none');

// --- Drill-down integrity: leaf-cell row indices reconcile to cell counts ----
var drillCheckRow = pCount.rows.filter(function (r) { return r.labels[0] === 'Grid'; })[0];
var reconcile = true, sumLeaf = 0;
pCount.leafCols.forEach(function (lc) {
  var cell = drillCheckRow.cells[lc.colId];
  if (pCount.drill[cell.cellId].length !== cell.count) reconcile = false;
  sumLeaf += cell.count;
});
ok('drill-down: each cell index list length == cell.count', reconcile);
ok('drill-down: leaf cell counts sum to row total', sumLeaf === drillCheckRow.cells['__total'].count, sumLeaf + ' == ' + drillCheckRow.cells['__total'].count);

// No NaN / undefined leaking into populated pivot cells
var anyBad = false;
pAvg.rows.forEach(function (r) {
  Object.keys(r.cells).forEach(function (cid) {
    var v = r.cells[cid].value;
    if (v !== null && (typeof v !== 'number' || isNaN(v))) anyBad = true;
  });
});
ok('pivot values are number-or-null (no NaN/undefined)', !anyBad);

// --- Multi-level pivot (rows=Platform+Type, cols=Scrape Date+Brand) ----------
var pMulti = E.buildPivot(cleaned.clean, { rows: ['platform', 'type'], cols: ['scrapeDate', 'brand'], measure: 'price', agg: 'avg' });
ok('multi-level pivot builds without error', pMulti.rows.length > 0 && pMulti.leafCols.length > 0,
   pMulti.rows.length + ' rows x ' + pMulti.leafCols.length + ' leaf cols');
var hasSubtotal = pMulti.rows.some(function (r) { return r.isSubtotal; });
ok('multi-level pivot emits row subtotals', hasSubtotal);

// --- SQL engine --------------------------------------------------------------
var flat = cleaned.clean.map(function (r) {
  return { brand: r.brand, platform: r.platform, type: r.type, price: r.price || 0, rating: r.rating || 0, scrapeDate: r.scrapeDate };
});
var sqlBrandCount = E.runSql("SELECT brand, COUNT(*) AS n, AVG(price) AS avgp FROM ? WHERE scrapeDate = '2026-06-19' GROUP BY brand ORDER BY n DESC", flat);
var sqlSw = sqlBrandCount.filter(function (r) { return r.brand === 'Sleepwell'; })[0];
ok('SQL GROUP BY brand: Sleepwell n == 4016', sqlSw && sqlSw.n === 4016, sqlSw ? sqlSw.n + '' : 'none');
var sqlWhere = E.runSql("SELECT brand, price FROM ? WHERE brand = 'Sleepwell' AND price > 20000", flat);
ok('SQL WHERE numeric+string filter returns rows', sqlWhere.length > 0, sqlWhere.length + ' rows');
var sqlLike = E.runSql("SELECT brand FROM ? WHERE brand LIKE '%well%'", flat);
ok('SQL LIKE filter works', sqlLike.length > 0 && sqlLike.every(function (r) { return /well/i.test(r.brand); }), sqlLike.length + ' rows');

// --- Filters -----------------------------------------------------------------
var filtered = E.applyFilters(cleaned.clean, { scrapeDate: ['2026-06-19'], platform: ['Amazon'] });
var allAmazon0619 = filtered.every(function (r) { return r.scrapeDate === '2026-06-19' && r.platform === 'Amazon'; });
ok('applyFilters: multi-dim filter is exact', allAmazon0619 && filtered.length > 0, filtered.length + ' rows');

// --- New: L/B/H dimensions + pivot by them -----------------------------------
ok('Length/Breadth/Height are registered dimensions',
   !!E.dimByKey('length') && !!E.dimByKey('breadth') && !!E.dimByKey('height'));
var pLen = E.buildPivot(d0619, { rows: ['length'], cols: [], measure: 'price', agg: 'count', includeRowSubtotals: false });
var lenTotal = pLen.rows.filter(function (r) { return !r.isGrandTotal; }).reduce(function (s, r) { return s + (r.cells[pLen.leafCols[0].colId].value || 0); }, 0);
ok('pivot by Length covers all 8087 snapshot rows', lenTotal === 8087, lenTotal + '');

// --- New: ranking stats in group summary -------------------------------------
var bsumRank = E.groupSummary(d0619, 'brand');
var swRank = bsumRank.filter(function (r) { return r.key === 'Sleepwell'; })[0];
ok('group summary exposes avg/best/worst rank fields',
   swRank && ('avgRank' in swRank) && ('bestRank' in swRank) && ('worstRank' in swRank));
ok('best rank <= worst rank when ranks exist',
   !swRank.rankedCount || (swRank.bestRank <= swRank.worstRank), swRank.bestRank + ' <= ' + swRank.worstRank);

// --- New: A-vs-B respects platform filter ------------------------------------
var avbAmazon = E.compareAvsB(d0619, 'Sleepwell', 'Kurlon', { platform: 'Amazon' });
var swAmazon = d0619.filter(function (r) { return r.brand === 'Sleepwell' && r.platform === 'Amazon'; }).length;
ok('A-vs-B platform=Amazon filter is exact', avbAmazon.a.count === swAmazon, avbAmazon.a.count + ' == ' + swAmazon);
ok('A-vs-B platform filter narrows vs unfiltered', avbAmazon.a.count < avb.a.count, avbAmazon.a.count + ' < ' + avb.a.count);

// --- New: alert engine -------------------------------------------------------
var alertsSet = E.buildAlerts(cleaned.clean, 'Sleepwell');
ok('buildAlerts returns structured result', alertsSet && Array.isArray(alertsSet.alerts) && alertsSet.counts != null, alertsSet.total + ' alerts');
ok('alerts are severity-sorted (high first)', (function () {
  var rank = { high: 0, medium: 1, low: 2 }, ok2 = true, prev = -1;
  alertsSet.alerts.forEach(function (a) { if (rank[a.severity] < prev) ok2 = false; prev = rank[a.severity]; });
  return ok2;
})());
ok('alert counts reconcile with alert list', (alertsSet.counts.high + alertsSet.counts.medium + alertsSet.counts.low) === alertsSet.total,
   alertsSet.counts.high + '/' + alertsSet.counts.medium + '/' + alertsSet.counts.low);
ok('every alert has severity, title, detail, action', alertsSet.alerts.every(function (a) { return a.severity && a.title && a.detail && a.action; }));
ok('action items derived from non-low alerts', Array.isArray(alertsSet.actionItems));
console.log('  (alerts: ' + alertsSet.counts.high + ' high, ' + alertsSet.counts.medium + ' medium, ' + alertsSet.counts.low + ' low)');

// --- Regression: header-map collision fix (Height vs Thickness) --------------
var hmHeightOnly = E.buildHeaderMap(['Brand (Std)', 'Height (in)', 'Active Price']);
ok('Height-only header binds heightDim, not thickness', hmHeightOnly.heightDim === 'Height (in)' && !hmHeightOnly.thickness,
   'h=' + hmHeightOnly.heightDim + ' t=' + hmHeightOnly.thickness);
var hmBoth = E.buildHeaderMap(['Thickness (in)', 'Height (in)']);
ok('Thickness + Height map to distinct columns', hmBoth.thickness === 'Thickness (in)' && hmBoth.heightDim === 'Height (in)',
   't=' + hmBoth.thickness + ' h=' + hmBoth.heightDim);
ok('no two fields share a header in real workbook map', (function () {
  var seen = {}; var dup = false;
  Object.keys(hm).forEach(function (f) { if (seen[hm[f]]) dup = true; seen[hm[f]] = true; });
  return !dup;
})());

// --- Regression: rowMatchesOpts compares through dim.get (thickness/(blank)) --
var thRow = d0619.filter(function (r) { return r.thickness; })[0];
var thVal = E.dimByKey('thickness').get(thRow);
ok('rowMatchesOpts thickness matches the dim-formatted option ("' + thVal + '")', E.rowMatchesOpts(thRow, { thickness: thVal }) === true);
ok('rowMatchesOpts thickness rejects a non-matching value', E.rowMatchesOpts(thRow, { thickness: '__nope__' }) === false);
var blankLenRow = cleaned.clean.filter(function (r) { return r.length == null; })[0];
ok('rowMatchesOpts "(blank)" length matches a null-length row',
   !blankLenRow || E.rowMatchesOpts(blankLenRow, { length: '(blank)' }) === true);

// --- Regression: A-vs-B thickness filter now actually narrows (was 0) --------
var avbTh = E.compareAvsB(d0619, 'Sleepwell', 'Kurlon', { thickness: thVal });
var swThManual = d0619.filter(function (r) { return r.brand === 'Sleepwell' && E.dimByKey('thickness').get(r) === thVal; }).length;
ok('A-vs-B thickness filter matches rows (regression)', avbTh.a.count === swThManual && avbTh.a.count > 0, avbTh.a.count + ' == ' + swThManual);

// --- Regression: undercut alerts never emit a -0% metric ---------------------
var freshAlerts = E.buildAlerts(cleaned.clean, 'Sleepwell');
ok('no undercut alert has a -0% metric', freshAlerts.alerts.filter(function (a) { return a.type === 'Undercut'; }).every(function (a) { return a.metric !== '-0%'; }));

// --- Summary -----------------------------------------------------------------
console.log('\n=============================================');
console.log('  BACK-TEST RESULT:  ' + pass + ' passed, ' + fail + ' failed');
console.log('=============================================');
process.exit(fail ? 1 : 0);
