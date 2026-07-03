/*
 * Rivalry Radar — Flipkart negative-review harvester (content script).
 * Injected on https://www.flipkart.com/*  AFTER flipkart.js (manifest order).
 *
 * CONTRACT (see constants.js data doc):
 *   worker -> content: {type:RR.MSG.SCRAPE_REVIEWS, marketplace, itemId, brand, keyword, max}
 *   content -> worker: {ok:true, url:location.href,
 *                       reviews:[{rating,reviewTitle,reviewText,reviewDate,author,helpful}]}
 *   On nothing useful: {ok:true, reviews:[], note:'no-reviews'}. NEVER throws.
 *
 * The worker has already navigated THIS tab to the product's canonical reviews
 * page (/product-reviews/...). We only read that page (and, narrowly, click the
 * product's OWN 1-star / 2-star rating filter — see ALLOW-LIST below) to surface negatives.
 *
 * ============================ SAFETY INVARIANT ============================
 * We reached this page by DIRECT navigation to the canonical reviews URL — never
 * by clicking an ad (that would bill the competitor). The ONLY clicks performed
 * here are on the product's OWN review rating-filter control (1 star / 2 star),
 * via a TIGHT allow-list. We NEVER click buy / add-to-cart / share / wishlist /
 * ad / pagination-to-product / or any unrelated control. Everything else is a
 * pure read of the DOM. Each click is wrapped in try/catch and is best-effort.
 * =========================================================================
 */
(function (g) {
  const RR = (g.RR = g.RR || {});
  const S = RR.scrape; // shared DOM-read helpers (txt/q/qa/firstText/rating/int/...)

  const NEG = (RR.NEG_STARS != null ? RR.NEG_STARS : 2);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- field selector fallbacks (most-specific first) -----------------------
  // Flipkart review markup is volatile; we layer class fallbacks and degrade.
  const SEL = {
    // Candidate review-block wrappers across layouts.
    block: ['div._27M-vq', 'div.col._2wzgFH', 'div.EKFha8', 'div.RcXBOT', 'div.cPHDOP'],
    rating: ['._3LWZlK', '.XQDdHH'],
    reviewTitle: ['p._2-N8zT', '.z9E0IG'],
    reviewText: ['div.t-ZTKy', '.ZmyHeo', '._6K-7Co'],
    // author lives in a secondary "._2sc7ZR" cluster; ._2V5EHH refines it.
    author: ['p._2sc7ZR._2V5EHH', '.AbGTjD', '._2NsDsF'],
    helpful: ['._3c3Px5', '.NTiEl0'],
  };

  // -------- ALLOW-LISTED rating-filter clicks (the ONLY clicks we ever do) ----
  // We look ONLY inside a ratings-filter container for a small clickable element
  // whose visible text is EXACTLY a star label ('1*'/'2*') or bare digit ('1'/'2').
  // We never click anything else. Each click is best-effort and isolated.
  const FILTER_CONTAINER_SEL = [
    '._2v0sM4', // known Flipkart "filter by rating" panel classes (volatile)
    '._1gIWoH',
    '.gQAQrW',
    '._3MuAT2',
    '[class*="filter" i]',
  ];
  // Acceptable EXACT filter-control labels for negative ratings.
  const NEG_FILTER_LABELS = new Set(['1★', '2★', '1', '2', '1 star', '2 star', '1 stars', '2 stars']);

  function findFilterContainers() {
    const out = [];
    for (const sel of FILTER_CONTAINER_SEL) {
      for (const el of S.qa(document, sel)) out.push(el);
    }
    return out;
  }

  // Find a single small clickable control whose EXACT text is `label` within a
  // ratings-filter container. Tight: short text only, no buy/cart/etc.
  function findNegFilterControl(label) {
    const containers = findFilterContainers();
    for (const container of containers) {
      const cands = S.qa(container, 'div, span, label, li, a, button');
      for (const el of cands) {
        const raw = (el.textContent || '').trim();
        if (!raw || raw.length > 8) continue; // filter labels are tiny
        const t = raw.toLowerCase().replace(/\s+/g, ' ');
        const norm = raw.replace(/\s+/g, '');
        if (NEG_FILTER_LABELS.has(norm) || NEG_FILTER_LABELS.has(t)) {
          // Extra safety: never a control that mentions buy/cart/add/share/etc.
          if (/\b(buy|cart|add|share|wishlist|sponsor|ad)\b/i.test(raw)) continue;
          return el;
        }
      }
    }
    return null;
  }

  // Best-effort: click 1* then 2* rating filter to narrow to negatives. If the
  // controls are not present we DO NOT click anything and just read the page.
  async function applyNegativeFilters() {
    for (const label of ['1★', '2★']) {
      try {
        const ctrl = findNegFilterControl(label);
        if (ctrl && typeof ctrl.click === 'function') {
          ctrl.click(); // ALLOW-LISTED: product's own rating filter only
          await sleep(1200);
        }
      } catch (_) {
        /* best-effort; never throw */
      }
    }
  }

  // -------- review-block discovery (READ-ONLY) -------------------------------
  // Locate candidate review blocks: known wrapper classes first; otherwise any
  // div that contains BOTH a rating badge and a text body.
  function findReviewBlocks() {
    const seen = new Set();
    const blocks = [];

    for (const sel of SEL.block) {
      for (const el of S.qa(document, sel)) {
        if (!seen.has(el)) { seen.add(el); blocks.push(el); }
      }
    }

    if (blocks.length) return blocks;

    // Fallback: derive blocks from rating badges, walking up to a container that
    // also holds a text body. Read-only DOM traversal.
    const badges = [];
    for (const rs of SEL.rating) {
      for (const el of S.qa(document, rs)) badges.push(el);
    }
    for (const badge of badges) {
      let el = badge;
      for (let i = 0; i < 6 && el && el.parentElement; i++) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        const hasText = SEL.reviewText.some((s) => S.q(el, s));
        if (hasText) {
          if (!seen.has(el)) { seen.add(el); blocks.push(el); }
          break;
        }
      }
    }
    return blocks;
  }

  // Extract one review record from a block. Returns null if no usable rating.
  function parseBlock(block) {
    const ratingVal = S.rating(S.firstText(block, SEL.rating));
    if (ratingVal == null) return null;

    const reviewTitle = S.firstText(block, SEL.reviewTitle);
    const reviewText = S.firstText(block, SEL.reviewText);

    // author + date both live in the secondary "._2sc7ZR" cluster. The refined
    // author selector gives the name; the date is a different "._2sc7ZR" line.
    const author = S.firstText(block, SEL.author);
    let reviewDate = '';
    const metaEls = S.qa(block, '._2sc7ZR');
    for (const el of metaEls) {
      const t = S.txt(el);
      if (!t || t === author) continue;
      // Prefer a line that looks like a date / month-year; else first non-author.
      if (/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ago|month|year)\b/i.test(t)) {
        reviewDate = t;
        break;
      }
      if (!reviewDate) reviewDate = t;
    }

    const helpful = S.int(S.firstText(block, SEL.helpful));

    return {
      rating: ratingVal,
      reviewTitle: reviewTitle || '',
      reviewText: reviewText || '',
      reviewDate: reviewDate || '',
      author: author || '',
      helpful: helpful != null ? helpful : null,
    };
  }

  // Read all negative reviews currently in the DOM, up to `max`.
  function collectReviews(max) {
    const cap = max && max > 0 ? max : 5;
    const blocks = findReviewBlocks();
    const reviews = [];
    for (const block of blocks) {
      const rec = parseBlock(block);
      if (!rec) continue;
      if (rec.rating > NEG) continue; // negatives only
      reviews.push(rec);
      if (reviews.length >= cap) break;
    }
    return reviews;
  }

  async function harvest(msg) {
    const max = msg && msg.max ? msg.max : 5;

    // Best-effort negative filtering via the product's own rating controls only.
    await applyNegativeFilters();

    // Give any filtered re-render a moment, then read.
    await sleep(300);

    let reviews = [];
    try {
      reviews = collectReviews(max);
    } catch (_) {
      reviews = [];
    }

    if (!reviews.length) {
      return { ok: true, url: location.href, reviews: [], note: 'no-reviews' };
    }
    return { ok: true, url: location.href, reviews };
  }

  // -------- message handler ---------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== RR.MSG.SCRAPE_REVIEWS) return; // not ours; ignore
    harvest(msg)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ ok: true, url: location.href, reviews: [], note: 'no-reviews' }));
    return true; // async response
  });
})(typeof self !== 'undefined' ? self : this);
