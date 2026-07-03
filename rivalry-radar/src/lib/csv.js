/*
 * Rivalry Radar — CSV export helpers. Attaches RR.csv.
 * Used by the dashboard (page context with DOM) to export scans/placements.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});

  const csv = {
    esc(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },

    // rows: array of objects; headers: ordered string[] of keys to emit.
    toCSV(rows, headers) {
      const head = headers.map((h) => this.esc(h)).join(',');
      const body = rows
        .map((r) => headers.map((h) => this.esc(r[h])).join(','))
        .join('\r\n');
      return head + '\r\n' + body;
    },

    // Flatten Scan[] into one row per placement (the analyst-friendly shape).
    placementsToCSV(scans) {
      const headers = [
        'iso', 'marketplace', 'keyword', 'rank', 'adRank', 'sponsored',
        'classification', 'brand', 'title', 'price', 'mrp', 'rating',
        'reviews', 'itemId', 'url',
      ];
      const rows = [];
      for (const s of scans) {
        for (const p of s.placements || []) {
          rows.push({
            iso: s.iso, marketplace: s.marketplace, keyword: s.keyword,
            rank: p.rank, adRank: p.adRank, sponsored: p.sponsored,
            classification: p.classification, brand: p.brand, title: p.title,
            price: p.price, mrp: p.mrp, rating: p.rating, reviews: p.reviews,
            itemId: p.itemId, url: p.url,
          });
        }
      }
      return this.toCSV(rows, headers);
    },

    // Flatten Review[] into one row per review (analyst-friendly).
    reviewsToCSV(reviews) {
      const headers = [
        'iso', 'marketplace', 'keyword', 'brand', 'rating', 'reviewTitle',
        'reviewText', 'reviewDate', 'author', 'helpful', 'wasSponsored',
        'itemId', 'productTitle', 'productUrl',
      ];
      return this.toCSV(reviews || [], headers);
    },

    // Trigger a browser download (page context only).
    download(filename, text) {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  RR.csv = csv;
})(typeof self !== 'undefined' ? self : this);
