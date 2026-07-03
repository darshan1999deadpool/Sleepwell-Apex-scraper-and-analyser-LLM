/*
 * Rivalry Radar — storage layer. Thin promise wrapper over chrome.storage.local
 * implementing the schema documented in constants.js. Attaches RR.storage.
 * Safe to load in worker and page contexts.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});

  const area = () => chrome.storage.local;

  const storage = {
    async getRaw(key, def) {
      const o = await area().get(key);
      return key in o ? o[key] : def;
    },
    async setRaw(key, val) {
      await area().set({ [key]: val });
    },

    // ---- config ----
    async getConfig() {
      const c = await this.getRaw(RR.K.CONFIG, {});
      // Defaults fill gaps; clickAds is ALWAYS forced false (safety invariant).
      const cfg = Object.assign({}, RR.DEFAULTS, c);
      cfg.clickAds = false;
      cfg.cadenceSec = Math.max(RR.LIMITS.MIN_CADENCE_SEC, Number(cfg.cadenceSec) || RR.DEFAULTS.cadenceSec);
      cfg.pagesPerKeyword = Math.min(RR.LIMITS.MAX_PAGES_PER_KEYWORD, Math.max(1, Number(cfg.pagesPerKeyword) || RR.DEFAULTS.pagesPerKeyword));
      cfg.maxScansKept = Math.min(RR.LIMITS.MAX_SCANS_KEPT, Math.max(50, Number(cfg.maxScansKept) || RR.DEFAULTS.maxScansKept));
      cfg.keywords = (cfg.keywords || []).map((s) => String(s).trim()).filter(Boolean);
      cfg.myBrands = (cfg.myBrands || []).map((s) => String(s).trim()).filter(Boolean);
      cfg.excludeBrands = (cfg.excludeBrands || []).map((s) => String(s).trim()).filter(Boolean);
      cfg.marketplaces = Object.assign({ amazon: true, flipkart: true }, cfg.marketplaces || {});

      // review-harvest settings
      cfg.reviewsEnabled = cfg.reviewsEnabled !== false;
      cfg.reviewCadenceMin = Math.max(RR.LIMITS.MIN_REVIEW_CADENCE_MIN, Number(cfg.reviewCadenceMin) || RR.DEFAULTS.reviewCadenceMin);
      cfg.reviewsPerProduct = Math.min(50, Math.max(1, Number(cfg.reviewsPerProduct) || RR.DEFAULTS.reviewsPerProduct));
      cfg.productsPerReviewCycle = Math.min(30, Math.max(1, Number(cfg.productsPerReviewCycle) || RR.DEFAULTS.productsPerReviewCycle));
      cfg.maxReviewsKept = Math.min(RR.LIMITS.MAX_REVIEWS_KEPT, Math.max(100, Number(cfg.maxReviewsKept) || RR.DEFAULTS.maxReviewsKept));
      return cfg;
    },
    async saveConfig(patch) {
      const next = Object.assign({}, await this.getConfig(), patch);
      next.clickAds = false; // can never be enabled
      await this.setRaw(RR.K.CONFIG, next);
      return this.getConfig();
    },

    // ---- state ----
    async getState() {
      return Object.assign(RR.defaultState(), await this.getRaw(RR.K.STATE, {}));
    },
    async setState(patch) {
      const next = Object.assign(await this.getState(), patch);
      await this.setRaw(RR.K.STATE, next);
      return next;
    },

    // ---- scans (ring buffer) ----
    async addScan(scan) {
      const cfg = await this.getConfig();
      const arr = await this.getRaw(RR.K.SCANS, []);
      arr.push(scan);
      while (arr.length > cfg.maxScansKept) arr.shift();
      await this.setRaw(RR.K.SCANS, arr);
      return arr.length;
    },
    async getScans() {
      return this.getRaw(RR.K.SCANS, []);
    },
    async clearScans() {
      await this.setRaw(RR.K.SCANS, []);
    },
    // Latest scan per marketplace (used by dashboard live twin).
    async latestByMarket() {
      const arr = await this.getScans();
      const out = { amazon: null, flipkart: null };
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i];
        if (!out[s.marketplace]) out[s.marketplace] = s;
        if (out.amazon && out.flipkart) break;
      }
      return out;
    },
    // Most recent scan for a specific (marketplace, keyword) — used by the review
    // harvester to learn which products are competitors for that search term.
    async latestScanFor(marketplace, keyword) {
      const arr = await this.getScans();
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i];
        if (s.marketplace === marketplace && s.keyword === keyword) return s;
      }
      return null;
    },

    // ---- reviews (ring buffer, deduped by id) ----
    async addReviews(recs) {
      if (!recs || !recs.length) return 0;
      const cfg = await this.getConfig();
      const arr = await this.getRaw(RR.K.REVIEWS, []);
      const seen = new Set(arr.map((r) => r.id));
      let added = 0;
      for (const r of recs) {
        if (r && r.id && !seen.has(r.id)) {
          arr.push(r);
          seen.add(r.id);
          added++;
        }
      }
      while (arr.length > cfg.maxReviewsKept) arr.shift();
      await this.setRaw(RR.K.REVIEWS, arr);
      return added;
    },
    async getReviews() {
      return this.getRaw(RR.K.REVIEWS, []);
    },
    async clearReviews() {
      await this.setRaw(RR.K.REVIEWS, []);
    },

    // ---- activity log (ring buffer) ----
    async log(line, level) {
      const arr = await this.getRaw(RR.K.LOG, []);
      arr.push({ t: Date.now(), level: level || 'info', line: String(line) });
      while (arr.length > RR.LIMITS.MAX_LOG) arr.shift();
      await this.setRaw(RR.K.LOG, arr);
    },
    async getLog() {
      return this.getRaw(RR.K.LOG, []);
    },
    async clearLog() {
      await this.setRaw(RR.K.LOG, []);
    },
  };

  RR.storage = storage;
})(typeof self !== 'undefined' ? self : this);
