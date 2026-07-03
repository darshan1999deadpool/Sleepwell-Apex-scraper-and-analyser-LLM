/*
 * Rivalry Radar — Amazon.in content script (READ-ONLY scraper).
 *
 * Injected on https://www.amazon.in/*. Listens for {type:RR.MSG.SCRAPE} from
 * the worker and responds with this search-results page's sponsored/organic
 * placements as RawPlacement[] (Placement WITHOUT `classification`; the worker
 * classifies brands later).
 *
 * SAFETY INVARIANT: every line here only READS the DOM (querySelector /
 * textContent / getAttribute). It NEVER clicks, focuses, submits, navigates,
 * window.open()s, or dispatches synthetic events on any ad, card, link, or
 * button. Product URLs are captured as strings for reference ONLY.
 */
(function (g) {
  const RR = (g.RR = g.RR || {});
  const S = RR.scrape;

  // Candidate selectors for a card root (the page sometimes nests results).
  const CARD_SELECTORS = [
    'div[data-component-type="s-search-result"]',
    'div.s-result-item[data-asin]',
  ];

  // Sponsored-label detectors (any match => sponsored). Amazon rotates these.
  const SPONSORED_SELECTORS = [
    '[data-component-type="s-sponsored-label-text"]',
    '.puis-sponsored-label-text',
    '.s-sponsored-label-info-icon',
    'a[aria-label="View Sponsored information"]',
  ];

  const TITLE_SELECTORS = [
    'h2 a span',
    'h2 span',
    '.a-size-medium.a-color-base.a-text-normal',
    '.a-size-base-plus.a-color-base.a-text-normal',
  ];

  const BRAND_SELECTORS = [
    'h2.a-size-mini span',
    '.a-row .a-size-base-plus.a-color-base',
    '.s-line-clamp-1',
  ];

  const PRICE_SELECTORS = ['span.a-price:not(.a-text-price) span.a-offscreen', 'span.a-price span.a-offscreen'];
  const MRP_SELECTORS = ['.a-price.a-text-price span.a-offscreen', 'span.a-price.a-text-price span.a-offscreen'];
  const RATING_SELECTORS = ["[aria-label*='out of 5']", 'span.a-icon-alt', 'i.a-icon-star-small'];
  const REVIEW_SELECTORS = [
    "[aria-label$='ratings']",
    "[aria-label$='rating']",
    'span.a-size-base.s-underline-text',
    'a[href*="#customerReviews"] span',
  ];

  // Find the first matching card root list across candidate container selectors.
  function collectCards() {
    for (const sel of CARD_SELECTORS) {
      const els = S.qa(document, sel);
      if (els.length) return els;
    }
    return [];
  }

  function isSponsored(card) {
    for (const sel of SPONSORED_SELECTORS) {
      if (S.q(card, sel)) return true;
    }
    // Fallback: any descendant whose trimmed text is exactly "Sponsored".
    const candidates = S.qa(card, 'span, a, div');
    for (const el of candidates) {
      // Only inspect leaf-ish nodes to avoid matching big containers.
      if (el.children.length === 0 && S.txt(el) === 'Sponsored') return true;
    }
    return false;
  }

  function readRating(card) {
    // Prefer an aria-label like "4.3 out of 5 stars".
    const ariaEl = S.q(card, "[aria-label*='out of 5']");
    if (ariaEl) {
      const v = S.rating(S.attr(ariaEl, 'aria-label'));
      if (v != null) return v;
    }
    // Fallback to the alt text inside the star icon.
    const altText = S.firstText(card, ['span.a-icon-alt']);
    return S.rating(altText);
  }

  function readReviews(card) {
    // aria-label like "1,234 ratings" first.
    for (const sel of ["[aria-label$='ratings']", "[aria-label$='rating']"]) {
      const el = S.q(card, sel);
      if (el) {
        const n = S.int(S.attr(el, 'aria-label'));
        if (n != null) return n;
      }
    }
    // Then visible count text near the rating row.
    const text = S.firstText(card, ['span.a-size-base.s-underline-text', 'a[href*="#customerReviews"] span', '.a-row a .a-size-base']);
    return S.int(text);
  }

  // Leading generic words to skip when deriving a brand from a title — these are
  // never a brand name on their own.
  const GENERIC_TITLE_WORDS = new Set([
    'the', 'a', 'an', 'new', 'genuine', 'original', 'premium', 'best', 'top',
    'buy', 'set', 'pack', 'combo', 'of',
  ]);

  // Multiword brand prefixes worth keeping intact (so we don't truncate e.g.
  // "Amazon Basics" down to just "Amazon").
  const MULTIWORD_BRANDS = [
    'amazon basics',
    'the sleep company',
    'wakefit',
  ];

  // Derive a display brand from a product title: skip leading generic words, then
  // take the first 1-2 significant words. Returns '' if nothing usable.
  function brandFromTitle(title) {
    if (!title) return '';
    const lower = title.toLowerCase();
    for (const b of MULTIWORD_BRANDS) {
      if (lower.startsWith(b)) {
        // Re-slice from the ORIGINAL title to preserve original casing.
        return title.slice(0, b.length).trim();
      }
    }
    const words = title.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && GENERIC_TITLE_WORDS.has(words[i].toLowerCase())) i++;
    const significant = words.slice(i);
    if (significant.length === 0) return '';
    // First significant word; include a second if the first is very short (e.g.
    // an initial / brand prefix like "Dr"), to keep multiword brands meaningful.
    if (significant.length >= 2 && significant[0].replace(/[^A-Za-z0-9]/g, '').length <= 3) {
      return (significant[0] + ' ' + significant[1]).trim();
    }
    return significant[0].trim();
  }

  function readBrand(card) {
    // Best-effort: explicit brand line first.
    const t = S.firstText(card, BRAND_SELECTORS);
    if (t) return t;
    // Fallback: derive a display brand from the title so the dashboard's brand
    // column / leaderboard is meaningful instead of "Unknown". Only return ''
    // when there's truly no title.
    const title = S.firstText(card, TITLE_SELECTORS);
    return brandFromTitle(title) || '';
  }

  function readUrl(card) {
    const a = S.firstEl(card, ['h2 a', 'a.a-link-normal.s-no-outline', 'a.a-link-normal[href]']);
    if (!a) return '';
    return S.abs(S.attr(a, 'href'));
  }

  function scrapeCard(card, rank, adRankRef) {
    const sponsored = isSponsored(card);
    const adRank = sponsored ? ++adRankRef.n : null;
    return {
      rank: rank,
      adRank: adRank,
      sponsored: sponsored,
      brand: readBrand(card),
      title: S.firstText(card, TITLE_SELECTORS),
      price: S.price(S.firstText(card, PRICE_SELECTORS)),
      mrp: S.price(S.firstText(card, MRP_SELECTORS)),
      rating: readRating(card),
      reviews: readReviews(card),
      itemId: S.attr(card, 'data-asin'),
      url: readUrl(card),
    };
  }

  function scrapePage() {
    const cards = collectCards();
    const placements = [];
    const adRankRef = { n: 0 };
    let rank = 0;
    for (const card of cards) {
      const asin = S.attr(card, 'data-asin');
      if (!asin) continue; // skip non-product / structural rows
      rank += 1;
      try {
        placements.push(scrapeCard(card, rank, adRankRef));
      } catch (_) {
        // Degrade gracefully: a malformed card must never break the whole scan.
        // Roll back the rank we optimistically incremented for this card.
        rank -= 1;
      }
    }
    return placements;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== RR.MSG.SCRAPE) return; // not ours

    (async () => {
      try {
        // Results render progressively; wait briefly for at least one card.
        await S.waitFor(() => collectCards().some((c) => S.attr(c, 'data-asin')), {
          timeout: 6000,
          interval: 250,
        });

        const placements = scrapePage();
        const resp = { ok: true, url: location.href, placements: placements };
        if (placements.length === 0) {
          // captcha / "dog" page / not a search page — still a valid empty scan.
          resp.note = 'no-results';
        }
        sendResponse(resp);
      } catch (e) {
        // Never throw out of the listener; return an empty, valid scan.
        sendResponse({ ok: true, url: location.href, placements: [], note: 'error:' + (e && e.message ? e.message : 'unknown') });
      }
    })();

    return true; // keep the message channel open for the async sendResponse
  });
})(typeof self !== 'undefined' ? self : this);
