/*
 * Rivalry Radar — Amazon.in negative-review harvester (READ-ONLY scraper).
 *
 * Injected on https://www.amazon.in/* AFTER amazon.js. Listens for
 * {type:RR.MSG.SCRAPE_REVIEWS} from the worker. The worker has already navigated
 * THIS tab directly to the product's canonical reviews page
 * (RR.REVIEWS_URL.amazon, filterByStar=critical) — never via an ad click — so
 * this script only has to READ the rendered review blocks.
 *
 * Responds async with:
 *   {ok:true, url:location.href, reviews:[
 *      {rating, reviewTitle, reviewText, reviewDate, author, helpful}
 *   ]}
 *
 * SAFETY INVARIANT: every line here only READS the DOM (querySelector /
 * textContent / getAttribute). Because the URL is already filtered to "critical"
 * (1-2 star) reviews, NO clicking is required and NONE is performed. It never
 * clicks, focuses, submits, navigates, window.open()s, or dispatches synthetic
 * events on any element. It only handles SCRAPE_REVIEWS; SCRAPE is left to
 * amazon.js. It never throws out of the listener.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});
  const S = RR.scrape;

  // Candidate selectors for a single review block on the reviews page.
  const REVIEW_BLOCK_SELECTORS = [
    'div[data-hook="review"]',
    '[data-hook="review"]',
    'li[data-hook="review"]',
  ];

  // Rating ("4.0 out of 5 stars") inside a review block.
  const RATING_SELECTORS = [
    "[data-hook='review-star-rating'] .a-icon-alt",
    "[data-hook='cmps-review-star-rating'] .a-icon-alt",
    'i.a-icon-star .a-icon-alt',
  ];

  function collectReviewBlocks() {
    for (const sel of REVIEW_BLOCK_SELECTORS) {
      const els = S.qa(document, sel);
      if (els.length) return els;
    }
    return [];
  }

  function readRating(block) {
    for (const sel of RATING_SELECTORS) {
      const el = S.q(block, sel);
      const v = S.rating(S.txt(el));
      if (v != null) return v;
    }
    return null;
  }

  function readReviewTitle(block) {
    const el = S.q(block, "[data-hook='review-title']");
    if (!el) return '';
    // The title element often contains a hidden star-label span (e.g.
    // "2.0 out of 5 stars") FOLLOWED by the actual title span. Prefer the LAST
    // span's text to avoid that prefix; fall back to the element text.
    const spans = S.qa(el, 'span');
    for (let i = spans.length - 1; i >= 0; i--) {
      const t = S.txt(spans[i]);
      if (t) return t;
    }
    return S.txt(el);
  }

  function readReview(block) {
    return {
      rating: readRating(block),
      reviewTitle: readReviewTitle(block),
      reviewText: S.firstText(block, ["[data-hook='review-body']"]),
      reviewDate: S.firstText(block, ["[data-hook='review-date']"]),
      author: S.firstText(block, ['.a-profile-name']),
      helpful: S.int(S.firstText(block, ["[data-hook='helpful-vote-statement']"])),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== RR.MSG.SCRAPE_REVIEWS) return; // not ours (amazon.js handles SCRAPE)

    (async () => {
      try {
        const max = msg.max && msg.max > 0 ? msg.max : 5;

        // Reviews render progressively; wait briefly for at least one block.
        await S.waitFor(() => collectReviewBlocks().length > 0, {
          timeout: 7000,
          interval: 250,
        });

        const blocks = collectReviewBlocks();
        if (blocks.length === 0) {
          sendResponse({ ok: true, url: location.href, reviews: [], note: 'no-reviews' });
          return;
        }

        const reviews = [];
        for (const block of blocks) {
          try {
            const r = readReview(block);
            // The page is already filtered to critical, but enforce the negative
            // bound defensively. Keep only rating <= RR.NEG_STARS.
            if (r.rating == null || r.rating > RR.NEG_STARS) continue;
            reviews.push(r);
            if (reviews.length >= max) break;
          } catch (_) {
            // A malformed review block must never break the harvest.
          }
        }

        const resp = { ok: true, url: location.href, reviews: reviews };
        if (reviews.length === 0) resp.note = 'no-reviews';
        sendResponse(resp);
      } catch (e) {
        // Never throw out of the listener; return a valid empty result.
        sendResponse({
          ok: true,
          url: location.href,
          reviews: [],
          note: 'error:' + (e && e.message ? e.message : 'unknown'),
        });
      }
    })();

    return true; // keep the message channel open for the async sendResponse
  });
})(typeof self !== 'undefined' ? self : this);
