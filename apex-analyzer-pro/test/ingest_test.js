/* Validates the REAL ingestion path: xlsx.mini.min.js reads the actual .xlsx,
   sheet_to_json -> ApexEngine.normalizeRows -> cleanRows -> buildPivot, and the
   numbers still match the workbook. This exercises the same code popup.js runs. */
var fs = require('fs');
var XLSX = require('../xlsx.mini.min.js');
var E = require('../engine.js');

var XLSX_FILE = process.env.APEX_XLSX || 'C:\\Users\\DARSHAN\\Downloads\\Apex_Competitor_Dashboard_1.xlsx';
var pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n + (x ? '  [' + x + ']' : '')); } else { fail++; console.log('  FAIL  ' + n + (x ? '  [' + x + ']' : '')); } }
function near(a, b, t) { return a != null && b != null && Math.abs(a - b) <= (t == null ? 0.01 : t); }

console.log('Reading workbook with xlsx.mini: ' + XLSX_FILE);
var buf = fs.readFileSync(XLSX_FILE);
var wb = XLSX.read(buf, { type: 'buffer' });
console.log('Sheets: ' + wb.SheetNames.join(', '));
ok('xlsx.mini can read .xlsx', wb.SheetNames.length > 0, wb.SheetNames.length + ' sheets');

// replicate chooseSheet
var name = wb.SheetNames.find(function (n) { return /consolidated/i.test(n); }) || wb.SheetNames[0];
ok('auto-selects Consolidated Data sheet', name === 'Consolidated Data', name);

var json = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
ok('sheet_to_json yields rows', json.length > 30000, json.length + ' rows');

var norm = E.normalizeRows(json);
var c = E.cleanRows(norm);
console.log('Normalized ' + norm.length + ', cleaned ' + c.clean.length + ', dropped ' + c.dropped);

var d0619 = c.clean.filter(function (r) { return r.scrapeDate === '2026-06-19'; });
ok('snapshot 2026-06-19 == 8087 rows (via real xlsx read)', d0619.length === 8087, d0619.length + '');

var p = E.buildPivot(c.clean, { rows: ['brand'], cols: ['scrapeDate'], measure: 'price', agg: 'avg' });
var dCol = p.leafCols.filter(function (x) { return x.label === '2026-06-19'; })[0];
var sw = p.rows.filter(function (r) { return r.labels[0] === 'Sleepwell'; })[0];
ok('pivot avg Sleepwell x 2026-06-19 == 15965.599 (via real xlsx read)',
   sw && dCol && near(sw.cells[dCol.colId].value, 15965.599348534202, 0.01), sw && dCol ? sw.cells[dCol.colId].value : 'none');

var typeSum = E.groupSummary(d0619, 'type');
var grid = typeSum.filter(function (t) { return t.key === 'Grid'; })[0];
ok('Type Master Grid count 695 / avg 19475.161 (via real xlsx read)',
   grid && grid.count === 695 && near(grid.avgPrice, 19475.161481481482, 0.01), grid ? grid.count + '/' + Math.round(grid.avgPrice) : 'none');

console.log('\n  INGESTION RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
