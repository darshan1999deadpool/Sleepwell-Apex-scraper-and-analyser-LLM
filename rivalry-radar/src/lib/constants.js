/*
 * Rivalry Radar — shared constants & data contract (SINGLE SOURCE OF TRUTH).
 *
 * Loaded first in every context (service worker via importScripts, content
 * scripts + extension pages via <script>) as a CLASSIC script. Everything
 * attaches to the global `self.RR` namespace (works in window & worker).
 *
 * ============================ SAFETY INVARIANT ============================
 * This tool never commits ad fraud. It does NOT click sponsored ad units (that
 * would charge a competitor per click), and it does NOT rotate IPs / evade bot
 * detection. The SERP scanner is strictly read-only. The review harvester
 * reaches products by navigating DIRECTLY to a product's canonical reviews URL
 * (RR.REVIEWS_URL.*, built from the ASIN/pid) — never by clicking an ad. The
 * ONLY clicks it performs are on a product's OWN review controls (rating filter
 * / "next page") to surface negative reviews. It never clicks buy / add-to-cart
 * / ad placements. Your own brands are always protected.
 * =========================================================================
 *
 * ---------------- chrome.storage.local schema ----------------
 *  RR.K.CONFIG  -> Config   (see RR.DEFAULTS)
 *  RR.K.STATE   -> State    (see RR.defaultState())
 *  RR.K.SCANS   -> Scan[]   (ring buffer, capped at config.maxScansKept)
 *  RR.K.REVIEWS -> Review[] (ring buffer, capped at config.maxReviewsKept)
 *  RR.K.LOG     -> LogLine[] {t:number, level:'info'|'warn'|'err', line:string} (cap 600)
 *
 * ---------------- Scan record ----------------
 *  {
 *    id:string,            // `${ts}|${marketplace}|${keyword}`
 *    ts:number,            // Date.now() epoch ms
 *    iso:string,           // ISO timestamp
 *    marketplace:'amazon'|'flipkart',
 *    keyword:string,
 *    url:string,           // search URL that was scanned
 *    counts:{ total, sponsored, mine, competitor, excluded },
 *      // total = ALL result cards seen; sponsored = the ad cards among them;
 *      // mine/competitor/excluded tally the SPONSORED cards by classification
 *      // (i.e. ad-slot share of voice), NOT organic results — so
 *      // mine + competitor + excluded === sponsored, not total.
 *    placements:Placement[]
 *  }
 * ---------------- Placement ----------------
 *  {
 *    rank:number,          // 1-based position among ALL result cards
 *    adRank:number|null,   // 1-based position among SPONSORED cards only
 *    sponsored:boolean,
 *    brand:string,
 *    classification:'mine'|'competitor'|'excluded',  // assigned by WORKER, not content
 *    title:string,
 *    price:number|null,
 *    mrp:number|null,
 *    rating:number|null,
 *    reviews:number|null,
 *    itemId:string,        // ASIN (amazon) / pid (flipkart) when found
 *    url:string            // product URL captured for reference (NEVER navigated for an ad click)
 *  }
 *  NOTE: content scripts return RawPlacement (Placement WITHOUT `classification`);
 *  the worker classifies via RR.match.classify(brand, config) and stores Placement.
 *
 * ---------------- Review record ----------------
 *  {
 *    id:string,            // `${marketplace}|${itemId}|${hash}` — stable, dedup key
 *    ts:number, iso:string,
 *    marketplace:'amazon'|'flipkart',
 *    keyword:string,       // search term the product was found under
 *    brand:string,         // competitor brand (own/excluded brands are never harvested)
 *    classification:'competitor',
 *    itemId:string,        // ASIN / pid
 *    productTitle:string,
 *    productUrl:string,    // canonical product URL (reference only)
 *    wasSponsored:boolean, // did this product appear as an ad in the SoV scan?
 *    rating:number,        // review star rating (1..5); harvester keeps <= RR.NEG_STARS
 *    reviewTitle:string,
 *    reviewText:string,
 *    reviewDate:string,
 *    author:string,
 *    helpful:number|null   // "helpful" / "found helpful" count if shown
 *  }
 *  Captured by navigating to RR.REVIEWS_URL.* (canonical reviews page) — NEVER by
 *  clicking an ad. In-page clicks are limited to review rating-filter / pagination.
 *
 * ---------------- Messages ----------------
 *  UI -> worker (chrome.runtime.sendMessage, awaits response):
 *    {type:RR.MSG.START}        -> {ok, state}
 *    {type:RR.MSG.STOP}         -> {ok, state}
 *    {type:RR.MSG.SCAN_NOW}     -> {ok} | {ok:false, busy:true}
 *    {type:RR.MSG.REVIEWS_NOW}  -> {ok} | {ok:false, busy:true}   (run one review cycle now)
 *    {type:RR.MSG.GET_STATUS}   -> {state, config, lastScans:{amazon,flipkart}}
 *    {type:RR.MSG.FOCUS_TAB, marketplace} -> {ok}
 *  worker -> content (chrome.tabs.sendMessage, awaits response):
 *    {type:RR.MSG.SCRAPE, keyword, marketplace} -> {ok, placements:RawPlacement[], url}
 *    {type:RR.MSG.SCRAPE_REVIEWS, marketplace, itemId, brand, keyword, max}
 *        -> {ok, url, reviews:[{rating,reviewTitle,reviewText,reviewDate,author,helpful}]}
 *  worker -> broadcast (chrome.runtime.sendMessage):
 *    {type:RR.MSG.STATE_CHANGED}  (UIs re-read storage on receipt)
 */
(function (g) {
  const RR = (g.RR = g.RR || {});

  RR.VERSION = '1.2.0';

  RR.K = {
    CONFIG: 'rr_config',
    STATE: 'rr_state',
    SCANS: 'rr_scans',
    REVIEWS: 'rr_reviews',
    LOG: 'rr_log',
  };

  RR.MSG = {
    START: 'rr_start',
    STOP: 'rr_stop',
    SCAN_NOW: 'rr_scan_now',
    REVIEWS_NOW: 'rr_reviews_now',
    GET_STATUS: 'rr_get_status',
    FOCUS_TAB: 'rr_focus_tab',
    SCRAPE: 'rr_scrape',
    SCRAPE_REVIEWS: 'rr_scrape_reviews',
    STATE_CHANGED: 'rr_state_changed',
  };

  RR.MARKET = { AMAZON: 'amazon', FLIPKART: 'flipkart' };
  RR.MARKETS = ['amazon', 'flipkart'];

  RR.CLASS = { MINE: 'mine', COMPETITOR: 'competitor', EXCLUDED: 'excluded' };

  // Reviews with a star rating <= this are "negative" and worth harvesting.
  RR.NEG_STARS = 2;

  // Build a search-results URL for a marketplace + keyword + page (1-based).
  // page 1 omits the page param; page >=2 appends the site's pagination param.
  RR.SEARCH_URL = {
    amazon: (kw, page) =>
      `https://www.amazon.in/s?k=${encodeURIComponent(kw)}` + (page && page > 1 ? `&page=${page}` : ''),
    flipkart: (kw, page) =>
      `https://www.flipkart.com/search?q=${encodeURIComponent(kw)}` + (page && page > 1 ? `&page=${page}` : ''),
  };

  // Build a product's CANONICAL reviews URL. This is a direct navigation to the
  // product's own reviews page — it is NOT a sponsored ad click and bills no one.
  RR.REVIEWS_URL = {
    // Amazon "critical" filter = 1-2 star reviews, most-recent first.
    amazon: (asin) =>
      `https://www.amazon.in/product-reviews/${encodeURIComponent(asin)}/?filterByStar=critical&sortBy=recent&reviewerType=all_reviews&pageNumber=1`,
    // Flipkart: turn the captured product URL (/p/) into its reviews page
    // (/product-reviews/). Falls back to a pid-based URL if the product URL
    // isn't usable. (Negative filtering is applied in-page by the content script.)
    flipkart: (productUrl, pid) => {
      try {
        if (productUrl && productUrl.indexOf('/p/') !== -1) {
          return productUrl.replace('/p/', '/product-reviews/');
        }
      } catch (e) { /* ignore */ }
      return pid
        ? `https://www.flipkart.com/product-reviews/${encodeURIComponent(pid)}?pid=${encodeURIComponent(pid)}`
        : '';
    },
  };

  RR.HOST_MATCH = {
    amazon: /(^|\.)amazon\.in$/i,
    flipkart: /(^|\.)flipkart\.com$/i,
  };

  RR.DEFAULTS = {
    keywords: ['memory foam mattress', 'orthopedic mattress'],
    myBrands: ['Sleepwell'], // brands to PROTECT — never competitor, never harvested
    excludeBrands: [], // brands to ignore entirely (stats + harvesting)
    marketplaces: { amazon: true, flipkart: true },
    cadenceSec: 40, // seconds between SoV scans (min enforced 30 by alarms)
    pagesPerKeyword: 2, // scan the first N result pages per keyword (1-3)
    maxScansKept: 2000, // ring-buffer cap for stored scans
    runForeverUntilStopped: true, // keeps cycling all day until STOP

    // --- negative-review harvesting (COMPETITORS ONLY) ---
    reviewsEnabled: true,
    reviewCadenceMin: 60, // harvest cadence in minutes (default hourly)
    reviewsPerProduct: 5, // top-N negative reviews kept per product
    productsPerReviewCycle: 6, // competitor products per (market,keyword) each cycle
    maxReviewsKept: 5000, // ring-buffer cap for stored reviews

    clickAds: false, // HARD-LOCKED false. The tool never clicks ads.
  };

  RR.LIMITS = {
    MIN_CADENCE_SEC: 30,
    MAX_SCANS_KEPT: 20000,
    MAX_LOG: 600,
    MIN_REVIEW_CADENCE_MIN: 15,
    MAX_REVIEWS_KEPT: 50000,
    MAX_PAGES_PER_KEYWORD: 3,
  };

  RR.defaultState = () => ({
    running: false,
    cursor: 0, // round-robin index over (keyword x marketplace) SoV work queue
    currentKeyword: null,
    currentMarket: null,
    lastScanAt: null,
    nextScanAt: null,
    scanCount: 0,
    errorCount: 0,
    scannerTabs: { amazon: null, flipkart: null }, // SoV scanner tab per marketplace

    // review harvester state
    reviewCursor: 0, // round-robin over the (keyword x marketplace) review queue
    lastReviewAt: null,
    nextReviewAt: null,
    reviewCount: 0, // total reviews captured this run
    reviewErrorCount: 0,
    reviewTabs: { amazon: null, flipkart: null }, // dedicated review scanner tab

    startedAt: null,
  });

  RR.emptyCounts = () => ({ total: 0, sponsored: 0, mine: 0, competitor: 0, excluded: 0 });
})(typeof self !== 'undefined' ? self : this);
