# Apex Analyzer Pro

A world-class competitor-intelligence workbench delivered as a Chrome extension.
It reads your scraped competitor export (the same `Consolidated Data` sheet your
workbook uses, or any Excel/CSV with comparable columns) and turns it into a
configurable pivot with drill-down, plus a full analytics suite. It is a **new,
separate tool** - the original `apex-analyzer` is left untouched.

Everything runs locally in your browser. No data leaves your machine.

## What is new vs the original

- **Pivot Explorer (headline feature).** Build any pivot: up to two row levels and
  two column levels, eight measures, six aggregations (average / sum / min / max /
  median / count), live filters, subtotals, grand totals, a value heatmap, and
  one-click **drill-down** - click any cell to see the exact underlying listings,
  sort them, and export just that slice. Mirrors and extends your `pivot view`.
- **Uses your standardized columns.** Reads `Brand (Std)`, `Product Type`,
  `Mattress Size`, `Thickness`, `Dimensions`, `Effective Price`,
  `Wow/Best Price`, in-stock and prime flags directly, instead of guessing from
  the title. (Title-based classification remains as a fallback for simpler files.)
- **Overview** with KPI tiles, a brand leaderboard, an average-price bar chart,
  and a per-product-type table that reproduces your `Type Master` sheet.
- **Competitive Matrix** - lock a spec bucket and compare every brand against the
  market average for that exact bucket.
- **Trends** - any measure across crawl dates by any dimension, plus a per-product
  snapshot A-vs-B comparison matched by product ID.
- **A vs B Compare** - head-to-head brand metrics, reproducing your `A vs B` sheet.
- **SQL Workspace** and **AI Insights** (local Ollama with a transparent
  statistical fallback), both rebuilt on the standardized schema.
- **No emoji or icons anywhere.** All affordances are typographic/geometric.
  The original Apex double-peak logo and favicon are included in the header.

## Enhancements in this build

- **Overview** has Platform and Product Type filters, and the brand leaderboard
  now shows Bestseller-Rank stats: Average / Top (best) / Lowest (worst) rank.
- **Pivot Explorer**, **Trends**, **Competitive Matrix** and **A vs B** all gain
  Length / Breadth / Height filters (plus Platform / Thickness where relevant)
  for precise size-by-size comparison. L/B/H are also usable as pivot rows,
  columns and trend breakdowns.
- **Competitive Matrix** rows include a clickable **Open listing** link to the
  product page.
- **Alert Center** (AI Insights) scans the data for what is wrong from the anchor
  brand's point of view - identical-spec undercuts, low-rated and out-of-stock
  listings, competitor price drops between snapshots, and discount-strategy gaps -
  ranked by severity with concrete action items.
- **Email & notifications**: push the AI report or the critical alerts + action
  items to your team. Two channels: the email client (mailto, zero setup) or a
  webhook POST (JSON payload) for automated delivery via Zapier / Make / Google
  Apps Script / an SMTP relay. Recipients and webhook are saved on your machine.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`C:\Users\DARSHAN\Desktop\apex-analyzer-pro`).
4. Click the Apex Analyzer Pro toolbar icon - it opens the workbench in a tab.
5. Click **Load Data File** and pick your `.xlsx` / `.csv`. The
   `Consolidated Data` sheet is auto-detected; use **Sheet** to switch sheets.

## Correctness / back-testing

The analytics engine (`engine.js`) is pure and unit-tested against the real
32,901-row workbook. Every number is verified to match the workbook's own cached
values (counts, averages, % in stock, reviews, pivot cells, drill-down totals).

```
# Node is available at the Playwright path on this machine:
& "C:\Users\DARSHAN\AppData\Local\ms-playwright-go\1.57.0\node.exe" test\backtest.js
& "C:\Users\DARSHAN\AppData\Local\ms-playwright-go\1.57.0\node.exe" test\ingest_test.js
```

- `test/backtest.js` - 40 assertions against the engine (fixture at
  `C:\Users\DARSHAN\Desktop\apex_test_data\consolidated.json`).
- `test/ingest_test.js` - reads the real `.xlsx` through the bundled SheetJS
  build and re-checks the numbers end-to-end.

## Files

| File | Purpose |
|------|---------|
| `engine.js` | Pure, tested analytics engine (normalize, clean, pivot, summaries, A/B, SQL) |
| `popup.html` / `popup.css` / `popup.js` | The workbench UI |
| `background.js` | Opens the workbench tab |
| `manifest.json` | MV3 extension manifest |
| `xlsx.mini.min.js` | SheetJS (Excel read/write) |
| `test/` | Back-test harnesses |
