# Rivalry Radar — Ad Intelligence

**Read-only competitor ad-intelligence for Amazon.in and Flipkart.**

Rivalry Radar is a Manifest V3 Chrome extension that watches search results all
day, records which products are running **sponsored (ad) placements**, and tracks
their prices, ranks, ratings and **share-of-voice** over time. It turns raw search
pages into a clean analytics dashboard so you can see exactly where your competitors
are buying visibility — and where your own brands stand.

---

## Ethics & stance — read this first

This tool exists to be the **legitimate, defensible alternative** to ad-click fraud.
It is built around one non-negotiable rule:

> **Rivalry Radar is strictly READ-ONLY. It only reads the page. It never interacts
> with what it sees.**

Concretely, Rivalry Radar:

- **Does NOT click ads.** There is no code path that clicks, taps, focuses-to-activate,
  submits, navigates to, `window.open()`s, or dispatches synthetic events on any ad,
  sponsored card, product link, add-to-cart, or button. Content scripts only call
  read APIs (`querySelector` / `textContent` / `getAttribute`).
- **Does NOT drain competitor ad budgets.** Because it never clicks, it never costs a
  competitor a single rupee of ad spend. Click fraud is illegal and unethical;
  this is market research.
- **Does NOT rotate IPs or use a VPN**, and **does NOT evade bot detection.** There is
  no stealth, fingerprint-spoofing or anti-detection logic anywhere, by design. It
  behaves like an ordinary, openly-running browser tab.
- **Protects your own brands.** Brands you list in *My Brands* are always classified
  as `mine` and are **never** counted as competitors or targeted in any way.
- **Keeps all data on your machine.** No servers, no accounts, no telemetry, no
  network calls beyond loading the same public search pages a shopper would see.
- Is **deliberately rate-limited** (configurable cadence, minimum 30 seconds between
  scans) so it stays a polite, low-volume observer.

It is safe to run openly because it does nothing a human reading the same search
results couldn't do — it just keeps notes.

---

## Features

| Feature | What it does |
| --- | --- |
| **Live Twin** | A real-time mirror of the latest scan per marketplace — the sponsored vs. organic cards exactly as they ranked. |
| **Share-of-Voice** | The percentage of sponsored slots held by your brands vs. competitors vs. excluded, per keyword and marketplace. |
| **Competitor Leaderboard** | Ranks rival brands by how often and how high they appear in sponsored placements. |
| **Trends** | Hand-drawn SVG charts of share-of-voice, prices and ad presence over time. |
| **CSV Export** | One-click export of every captured placement for analysis in Excel / Sheets. |
| **All-Day Scanning** | Cycles through your keywords on a timer and keeps going until you press Stop. |
| **Brand & Exclude Lists** | Define *My Brands* (protected) and *Exclude Brands* (ignored) to shape the stats. |
| **Configurable Cadence** | Set how many seconds elapse between scans (minimum 30s). |
| **Read-only by design** | No clicks, no IP rotation, no bot evasion — ever. |

---

## Install

1. Download / clone this project so you have the `rivalry-radar` folder on disk.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `rivalry-radar` folder.
5. **Pin** the extension (puzzle-piece icon → pin Rivalry Radar) so its toolbar
   button is always visible.
6. Open **Settings** (the extension's options page), set your **keywords** and
   **My Brands**, choose marketplaces and cadence, then save.
7. Open the popup and press **Start**.

---

## Usage

1. **Configure** in Settings: add the search keywords you want monitored and the
   brands you own.
2. **Start** from the popup. Rivalry Radar opens (or reuses) a pinned scanner tab
   per enabled marketplace and begins cycling through your keywords.
3. **Watch** the dashboard fill with placements, share-of-voice and the competitor
   leaderboard as scans land.
4. **Export** to CSV whenever you want a snapshot for offline analysis.
5. **Stop** from the popup to halt scanning. It will otherwise run all day.

The scanner tabs are normal tabs — you can leave them pinned in the background. If a
marketplace shows a captcha or interstitial, Rivalry Radar simply records nothing for
that scan and keeps cycling; it never tries to solve or bypass it.

### Configuration reference

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `keywords` | `string[]` | `["memory foam mattress", "orthopedic mattress"]` | Search terms to monitor. Each keyword × enabled marketplace is one work item. |
| `myBrands` | `string[]` | `["Sleepwell"]` | Brands you own. Always classified `mine`; never a competitor. |
| `excludeBrands` | `string[]` | `[]` | Brands removed from all stats (e.g. accessories, irrelevant sellers). |
| `marketplaces` | `{amazon:bool, flipkart:bool}` | both `true` | Which marketplaces to scan. |
| `cadenceSec` | `number` | `40` | Seconds between scans. **Minimum 30** (enforced). |
| `maxScansKept` | `number` | `2000` | Ring-buffer cap on stored scans; oldest are dropped beyond this. |

Brand matching is case-insensitive and handled by `RR.match.classify()`. A placement's
brand text is compared against *My Brands* → `mine`, *Exclude Brands* → `excluded`,
everything else → `competitor`.

---

## How it works

Rivalry Radar is a standard Manifest V3 extension with four moving parts:

1. **Service worker** (`src/background/service-worker.js`) — the brain. It owns the
   work queue (round-robin over keyword × marketplace), classifies scraped brands,
   writes results to storage and broadcasts state changes to the UI.
2. **Alarms timer** — `chrome.alarms` fires on your cadence (min 30s). Each tick the
   worker picks the next work item and asks the relevant scanner tab to scrape.
3. **Pinned scanner tabs** — one background tab per enabled marketplace, navigated to
   the search URL for the current keyword. These are the same public search pages any
   shopper sees.
4. **Content-script scrapers** (`src/content/amazon.js`, `src/content/flipkart.js`,
   built on `src/content/scrape-common.js`) — they **only read** the DOM, return a list
   of raw placements, and never touch the page.

All data is stored in `chrome.storage.local` on your machine. Nothing is uploaded
anywhere — there are no servers and no telemetry.

```
chrome.alarms tick
        │
        ▼
service worker  ──picks keyword × marketplace──►  pinned scanner tab (search page)
        ▲                                                   │
        │           RawPlacement[] (read-only scrape)        │
        └───────────────────────────────────────────────────┘
        │
        ├─ classify each brand  (RR.match.classify)
        └─ store Scan           (chrome.storage.local, ring buffer)
                │
                ▼
        popup + dashboard read storage and render
```

---

## Data schema

Stored in `chrome.storage.local`. Definitive shapes live in `src/lib/constants.js`.

### Scan

```js
{
  id: "1719655200000|amazon|memory foam mattress", // `${ts}|${marketplace}|${keyword}`
  ts: 1719655200000,                                // epoch ms
  iso: "2026-06-29T10:00:00.000Z",                  // ISO timestamp
  marketplace: "amazon" | "flipkart",
  keyword: "memory foam mattress",
  url: "https://www.amazon.in/s?k=memory%20foam%20mattress",
  counts: { total, sponsored, mine, competitor, excluded },
  placements: Placement[]
}
```

### Placement

```js
{
  rank: 1,                 // 1-based position among ALL result cards
  adRank: 1 | null,        // 1-based position among SPONSORED cards only
  sponsored: true,
  brand: "Wakefit",
  classification: "mine" | "competitor" | "excluded", // assigned by the worker
  title: "Wakefit Dual Comfort Mattress",
  price: 8999,
  mrp: 15999,
  rating: 4.3,
  reviews: 12045,
  itemId: "B07XYZ1234",    // ASIN (Amazon) / pid (Flipkart) when found
  url: "https://www.amazon.in/..."  // captured for reference only — NEVER navigated
}
```

> Content scripts return *RawPlacement* (a Placement **without** `classification`).
> The service worker assigns `classification` via `RR.match.classify(brand, config)`.

### CSV columns

`RR.csv.placementsToCSV()` emits one row per placement with these columns, in order:

```
iso, marketplace, keyword, rank, adRank, sponsored, classification,
brand, title, price, mrp, rating, reviews, itemId, url
```

---

## Negative review harvesting

Beyond watching ad placements, Rivalry Radar can periodically harvest the **top
negative reviews of your competitors' products** so you can see, in one place, what
real shoppers complain about across the rivals who are buying visibility against you.

### What it does

On its own timer — every `reviewCadenceMin` minutes (**default 60 = hourly**) — the
harvester runs one cycle. For each search term, on each enabled marketplace, it:

1. Takes the **latest SoV scan** for that `(marketplace, keyword)`.
2. Picks the **competitor** products from it (up to `productsPerReviewCycle` per cycle).
   Products classified `mine` or `excluded` are skipped entirely.
3. Navigates to each product's **own canonical reviews page** (built from its ASIN /
   pid) and captures up to `reviewsPerProduct` of its top reviews rated **≤ 2★**
   (`RR.NEG_STARS`).
4. Stores the new reviews (deduplicated) in a ring buffer capped at `maxReviewsKept`.

### Ethics & boundary — read this

The review harvester obeys the **exact same non-negotiable rule** as the rest of the
tool: **it never commits ad fraud and stays as close to read-only as the task allows.**

- **It NEVER clicks ads to reach reviews.** It reaches a product's reviews by
  navigating *directly* to that product's **canonical reviews URL**, built from its
  ASIN / pid (`RR.REVIEWS_URL.amazon` / `RR.REVIEWS_URL.flipkart`). Because no
  sponsored ad unit or ad link is ever clicked, **no competitor is billed a single
  rupee** of ad spend.
- **The only clicks are on a product's OWN review controls.** A tight allow-list of
  selectors lets it click that product's **rating filter** (1★/2★ / "critical") and
  **review pagination / "load more"** — nothing else. It never clicks buy,
  add-to-cart, ads, or any unrelated link.
- **Competitors only.** It harvests products classified `competitor`. It **never**
  harvests your own brands (*My Brands*) or anything on the *Exclude Brands* list.
- **No IP / VPN rotation, no bot evasion**, ever — the same openly-running browser tab
  as the SoV scanner.

Everything else remains ordinary read-only DOM reading.

### Configuration reference

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `reviewsEnabled` | `boolean` | `true` | Master switch for review harvesting. |
| `reviewCadenceMin` | `number` | `60` | Minutes between harvest cycles (hourly by default). **Minimum 15** (enforced). |
| `reviewsPerProduct` | `number` | `5` | Max negative (≤ 2★) reviews kept per product per cycle. |
| `productsPerReviewCycle` | `number` | `6` | Max competitor products harvested per `(marketplace, keyword)` each cycle. |
| `maxReviewsKept` | `number` | `5000` | Ring-buffer cap on stored reviews; oldest dropped beyond this. |

New controls in the UI:

- **Settings → Clear review data** — empties the stored `Review[]` (`RR.storage.clearReviews`).
- **Dashboard → Reviews now** — runs one review cycle immediately (`RR.MSG.REVIEWS_NOW`),
  without waiting for the next scheduled tick.
- **Dashboard → Export reviews CSV** — downloads every stored review
  (`RR.csv.reviewsToCSV`).

### Review record schema

Stored in `chrome.storage.local` under `RR.K.REVIEWS`. Definitive shape lives in
`src/lib/constants.js`.

```js
{
  id: "amazon|B07XYZ1234|3f9a2c",  // `${marketplace}|${itemId}|${hash}` — stable dedup key
  ts: 1719655200000,               // epoch ms
  iso: "2026-06-29T10:00:00.000Z", // ISO timestamp
  marketplace: "amazon" | "flipkart",
  keyword: "memory foam mattress", // search term the product was found under
  brand: "Wakefit",                // competitor brand (own/excluded never harvested)
  classification: "competitor",
  itemId: "B07XYZ1234",            // ASIN (Amazon) / pid (Flipkart)
  productTitle: "Wakefit Dual Comfort Mattress",
  productUrl: "https://www.amazon.in/...", // canonical product URL (reference only)
  wasSponsored: true,              // did this product appear as an ad in the SoV scan?
  rating: 1,                       // review star rating (1..5); harvester keeps <= 2
  reviewTitle: "Sagged within a month",
  reviewText: "Started dipping in the middle after four weeks...",
  reviewDate: "12 May 2026",
  author: "A. Shopper",
  helpful: 37                      // "found helpful" count if shown, else null
}
```

### Reviews CSV columns

`RR.csv.reviewsToCSV()` emits one row per review with these columns, in order:

```
iso, marketplace, keyword, brand, rating, reviewTitle, reviewText,
reviewDate, author, helpful, wasSponsored, itemId, productTitle, productUrl
```

---

## Troubleshooting

- **Scans return nothing / counts are zero.** Amazon and Flipkart change their page
  HTML from time to time, which can break the CSS selectors. Update the selectors in
  `src/content/amazon.js` and `src/content/flipkart.js` (shared helpers live in
  `src/content/scrape-common.js`). The data contract and message protocol do not need
  to change.
- **Review harvesting captures nothing / Flipkart misbehaves.** **Flipkart's review
  and search (SERP) markup is volatile** and changes more often than Amazon's, which
  can break both the product/brand selectors and the review allow-list. Tune the
  Flipkart SERP selectors in `src/content/flipkart.js` and the review selectors
  (rating filter, pagination, review fields) in `src/content/flipkart-reviews.js`;
  the Amazon equivalents live in `src/content/amazon.js` and
  `src/content/amazon-reviews.js`. Keep the in-page click allow-list **tight** — only
  a product's own rating-filter and pagination controls — so the safety boundary holds.
- **A captcha or "are you a robot?" page appears.** Rivalry Radar does **not** attempt
  to solve or bypass it (no bot evasion, by design). It records an empty scan and keeps
  cycling; the page usually clears on its own. You can also solve it yourself in the
  pinned tab.
- **Cadence won't go below 30 seconds.** That's intentional — 30s is the enforced
  minimum to keep the tool a polite, low-volume observer.
- **Nothing happens after Start.** Confirm at least one marketplace is enabled and at
  least one keyword is set in Settings, and that the scanner tabs were allowed to open.
- **The extension feels stuck.** Press Stop, then Start again to rebuild the scanner
  tabs and work queue.

---

## File map

```
rivalry-radar/
├─ manifest.json                  # MV3 manifest: permissions, content scripts, action
├─ README.md                      # this file
├─ icons/
│  ├─ icon16.png  icon48.png  icon128.png
│  └─ logo.svg
├─ tools/
│  └─ make-icons.html             # standalone canvas tool to regenerate the icons
└─ src/
   ├─ lib/
   │  ├─ constants.js             # RR namespace, keys, messages, defaults, DATA CONTRACT
   │  ├─ storage.js               # RR.storage: config/state/scans/reviews/log helpers
   │  ├─ match.js                 # RR.match.classify(brand, cfg) -> mine|competitor|excluded
   │  └─ csv.js                   # RR.csv: placementsToCSV / reviewsToCSV / download
   ├─ content/
   │  ├─ scrape-common.js         # RR.scrape: read-only DOM helpers
   │  ├─ amazon.js                # Amazon.in search-page scraper (read-only)
   │  ├─ flipkart.js              # Flipkart search-page scraper (read-only)
   │  ├─ amazon-reviews.js        # Amazon.in negative-review harvester (competitors only)
   │  └─ flipkart-reviews.js      # Flipkart negative-review harvester (competitors only)
   ├─ background/
   │  └─ service-worker.js        # timer, work queue, classification, storage writes
   ├─ popup/
   │  ├─ popup.html  popup.js  popup.css     # Start/Stop + status
   └─ options/
      ├─ options.html  options.js  options.css  # settings + dashboard
```

(Exact UI file names may vary; the spine files under `src/lib/` and `src/content/`
are authoritative.)

---

## Legal / Terms note

Rivalry Radar is intended for **market research** on publicly visible search results.
Please respect each marketplace's Terms of Service and `robots` guidance. The tool is
deliberately **read-only** and **rate-limited** (minimum 30s cadence, no IP rotation,
no bot evasion) specifically so it stays within the bounds of ordinary, courteous
browsing. You are responsible for using it in compliance with applicable terms and
laws in your jurisdiction. Captured product URLs are stored as reference strings only
and are never opened or navigated.
