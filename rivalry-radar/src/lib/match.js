/*
 * Rivalry Radar — brand classification. Attaches RR.match.
 * Decides whether a scraped brand/title belongs to YOU (mine), an EXCLUDED
 * brand (ignored in stats), or a COMPETITOR. This is what powers the core
 * promise: your own brand is never treated as a competitor.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});

  const match = {
    norm(s) {
      return (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    // True if any brand in `list` matches the text (whole-word or phrase contains).
    hit(text, list) {
      const t = this.norm(text);
      if (!t) return false;
      const words = new Set(t.split(' '));
      return (list || []).some((b) => {
        const nb = this.norm(b);
        if (!nb) return false;
        if (t === nb) return true;
        // multi-word brand -> phrase contains; single word -> whole-word match
        if (nb.includes(' ')) return t.includes(nb);
        return words.has(nb);
      });
    },

    // brandText should be the most brand-identifying string available
    // (explicit brand element, else product title). cfg = full config.
    classify(brandText, cfg) {
      if (this.hit(brandText, cfg.myBrands)) return RR.CLASS.MINE;
      if (this.hit(brandText, cfg.excludeBrands)) return RR.CLASS.EXCLUDED;
      return RR.CLASS.COMPETITOR;
    },
  };

  RR.match = match;
})(typeof self !== 'undefined' ? self : this);
