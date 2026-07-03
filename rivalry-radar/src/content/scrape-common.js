/*
 * Rivalry Radar — shared DOM-scraping helpers for content scripts. Attaches
 * RR.scrape. Loaded before amazon.js / flipkart.js.
 *
 * SAFETY: every function here READS the DOM only. Nothing clicks, focuses, or
 * dispatches events on result elements.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});

  const scrape = {
    txt(el) {
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    },
    attr(el, name) {
      return el ? el.getAttribute(name) || '' : '';
    },
    q(root, sel) {
      try { return (root || document).querySelector(sel); } catch (_) { return null; }
    },
    qa(root, sel) {
      try { return Array.from((root || document).querySelectorAll(sel)); } catch (_) { return []; }
    },
    // First matching selector's text from a list of candidate selectors.
    firstText(root, selectors) {
      for (const sel of selectors) {
        const el = this.q(root, sel);
        const t = this.txt(el);
        if (t) return t;
      }
      return '';
    },
    firstEl(root, selectors) {
      for (const sel of selectors) {
        const el = this.q(root, sel);
        if (el) return el;
      }
      return null;
    },
    // Parse a rupee/number string -> float (handles "₹1,23,499" / "1,299.00").
    price(s) {
      if (!s) return null;
      const m = String(s).replace(/[, ]/g, '').match(/(\d+(\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    },
    // Parse first integer out of a string ("1,234 ratings" -> 1234).
    int(s) {
      if (!s) return null;
      const m = String(s).replace(/[, ]/g, '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    },
    // Parse a rating like "4.3 out of 5 stars" / "4.3" -> 4.3.
    rating(s) {
      if (!s) return null;
      const m = String(s).match(/(\d(\.\d)?)/);
      const v = m ? parseFloat(m[1]) : null;
      return v != null && v >= 0 && v <= 5 ? v : null;
    },
    abs(href) {
      if (!href) return '';
      try { return new URL(href, location.origin).href; } catch (_) { return href; }
    },
    // Wait until `fn()` is truthy or timeout; resolves with the value or null.
    waitFor(fn, { timeout = 8000, interval = 250 } = {}) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          let v = null;
          try { v = fn(); } catch (_) {}
          if (v) return resolve(v);
          if (Date.now() - t0 >= timeout) return resolve(null);
          setTimeout(tick, interval);
        };
        tick();
      });
    },
  };

  RR.scrape = scrape;
})(typeof self !== 'undefined' ? self : this);
