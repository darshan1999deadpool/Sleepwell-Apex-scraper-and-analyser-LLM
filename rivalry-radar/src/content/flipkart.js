/*
 * Rivalry Radar — Flipkart SERP scraper (content script).
 * Injected on https://www.flipkart.com/*  (manifest content_scripts).
 *
 * CONTRACT (see constants.js data doc):
 *   worker -> content: {type:RR.MSG.SCRAPE, keyword, marketplace}
 *   content -> worker: {ok:true, url:location.href, placements:RawPlacement[]}
 *   RawPlacement = Placement WITHOUT `classification` (the worker classifies).
 *
 * ============================ SAFETY INVARIANT ============================
 * STRICTLY READ-ONLY. This file ONLY reads the DOM (querySelector / textContent
 * / getAttribute) via RR.scrape helpers. It NEVER clicks, taps, focuses,
 * submits, navigates, window.open()s, or dispatches synthetic events on any ad,
 * sponsored card, product link, or button. Product URLs are captured as strings
 * for reference ONLY and are never opened.
 * =========================================================================
 *
 * Flipkart SERP markup is volatile and has TWO layouts (grid vs list), served on
 * BOTH search page 1 and page 2 (same markup). We do not bet on a single class
 * name: we locate product anchors (a[href*="/p/"]), walk up to the true card
 * container, dedupe by the product's pid, then extract fields with layered class
 * fallbacks. Everything degrades gracefully and never throws.
 *
 * ------------------------- WHERE TO TUNE SELECTORS -------------------------
 * Every hard-coded class below is VOLATILE — Flipkart rotates them frequently.
 * When Flipkart ships a redesign, re-inspect a live SERP and update the SEL.*
 * arrays + CARD_WRAP_RE + AD_BADGE_CLASS_RE below. The card-discovery /
 * dedupe / sponsored / field logic is class-tolerant and should survive most
 * churn; the string lists are the parts most likely to need refreshing.
 * ---------------------------------------------------------------------------
 */
(function (g) {
  const RR = (g.RR = g.RR || {});
  const S = RR.scrape; // shared DOM-read helpers (txt/q/qa/firstText/price/int/rating/abs/attr/firstEl)

  // ---- field selector fallbacks (most-specific first; VOLATILE) -------------
  // Grid layout uses one set of classes, list layout another; we list both.
  const SEL = {
    // Product title. Grid: ._4rR01T / .KzDlHZ / .wjcEIp ; List: .s1Q9rs / .IRpwTa.
    title: ['._4rR01T', '.KzDlHZ', '.wjcEIp', '.s1Q9rs', '.IRpwTa', '._2B_pmu'],
    // Explicit brand line (present mostly in grid layout).
    brand: ['._2WkVRV', '.syl9yP', '.YnbrH8'],
    // Selling price.
    price: ['._30jeq3', '.Nx9bqj', '._4b5DiR', '._1_WHN1'],
    // Struck-through MRP.
    mrp: ['._3I9_wc', '.yRaY8j', '._3auQ3N'],
    // Rating chip (the small "4.3 ★" badge).
    rating: ['._3LWZlK', '.XQDdHH', '.Y1HWO0', '._3LWZlK div'],
    // "1,234 Ratings & 56 Reviews" text.
    reviews: ['._2_R_DZ', '.Wphh3N', '._13vcmD'],
    // Ad-badge elements (see also AD_BADGE_CLASS_RE for class-substring matching).
    adBadge: ['._3iSbpg', '._2vQyrf', '.IHj9pp', '.s4mNcc', '._1Wy3Nm'],
  };

  // How far up from a product anchor we walk looking for the card wrapper. Kept
  // small so we can never climb out to a whole grid/column (or <body>).
  const MAX_WALK = 8;

  // Known Flipkart card-wrapper classes across grid/list layouts (VOLATILE;
  // additive — add new ones here as they appear). Used to snap to the real card.
  const CARD_WRAP_RE =
    /\b(_1AtVbE|_13oc-S|_4ddWXP|_1xHGtK|_2kHMtA|cPHDOP|tUxRFH|slAVV4|_75nlfW|_1sdMkc|DOjaWF|_2-gKeQ|_2B099V|Lcsfeu|_1sdMkc|_75nlfW|hCKiGj)\b/;

  // Ad-badge class substrings (VOLATILE). Flipkart's small "Ad" chip carries one
  // of these class fragments; substring match survives suffix churn.
  const AD_BADGE_CLASS_RE = /(_3iSbpg|_2vQyrf|IHj9pp|s4mNcc|_1Wy3Nm)/;

  // Category / breadcrumb titles that a stray [title] attr sometimes yields
  // (e.g. a breadcrumb chip "Furniture"). These are NOT product titles.
  const CATEGORY_TITLES = new Set([
    'furniture',
    'home & furniture',
    'home and furniture',
    'home',
    'mattresses',
    'mattress',
    'beds',
    'bedroom furniture',
    'electronics',
    'appliances',
    'fashion',
    'grocery',
    'all categories',
    'sponsored',
  ]);

  function looksLikeCategory(title) {
    if (!title) return true;
    const t = title.replace(/\s+/g, ' ').trim().toLowerCase();
    if (CATEGORY_TITLES.has(t)) return true;
    // Very short titles (1-2 words, no digits) that match a category word are
    // almost always breadcrumbs, never a real product name.
    if (
      t.length <= 18 &&
      !/\d/.test(t) &&
      /\b(furniture|mattress|home|beds?)\b/.test(t) &&
      t.split(' ').length <= 2
    ) {
      return true;
    }
    return false;
  }

  // -------- helpers (all READ-ONLY) ------------------------------------------

  function classOf(el) {
    return el && typeof el.className === 'string' ? el.className : '';
  }

  // Extract the Flipkart product pid from a href. pid= query param is the most
  // reliable identity; fall back to the /p/ pathname so each product counts once.
  function pidFromHref(href) {
    if (!href) return '';
    const m = String(href).match(/[?&]pid=([^&]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    return '';
  }

  // Stable dedupe key: prefer pid, else the /p/ pathname (query stripped) so the
  // same product reached via multiple anchors (image + title) counts once.
  function dedupeKey(href) {
    const pid = pidFromHref(href);
    if (pid) return 'pid:' + pid;
    try { return 'path:' + new URL(href, location.origin).pathname; } catch (_) {}
    return 'href:' + href;
  }

  // Walk up from a product anchor to the smallest sensible card container.
  // Strategy: prefer the nearest ancestor matching a known card-wrapper class;
  // otherwise keep the smallest ancestor that already contains a price/rating/
  // title signal (i.e. the full card, not just the bare link), capped at
  // MAX_WALK so we never reach a grid column or <body>.
  function cardFor(anchor) {
    let el = anchor;
    let best = anchor;
    for (let i = 0; i < MAX_WALK && el && el.parentElement; i++) {
      el = el.parentElement;
      if (!el || el === document.body) break;
      // Known Flipkart card wrappers across layouts — snap to the nearest.
      if (CARD_WRAP_RE.test(classOf(el))) return el;
      // Otherwise remember the first ancestor that looks like a full card
      // (contains a price/rating/reviews signal). First hit is the smallest.
      if (
        best === anchor &&
        (S.firstEl(el, SEL.price) || S.firstEl(el, SEL.rating) || S.firstEl(el, SEL.reviews))
      ) {
        best = el;
      }
    }
    return best || anchor;
  }

  // Sponsored / ad detection. Tight but resilient: (1) known ad-badge classes,
  // (2) any element whose CLASS carries an ad-badge fragment AND whose short text
  // is an ad label, (3) a short-text exact 'Ad'/'Sponsored' element. We cap text
  // length so body copy ("add to cart", "add to compare") can never match.
  function isSponsored(card) {
    // 1) Known ad-badge selector hits with an ad-ish label.
    for (const sel of SEL.adBadge) {
      const el = S.q(card, sel);
      if (!el) continue;
      const t = S.txt(el).toLowerCase();
      if (t === '' || t === 'ad' || t === 'ad ·' || t.includes('sponsored')) return true;
    }
    // 2/3) Scan small candidate elements for an exact ad label. Keep the set
    // tight and bail on long text so we never mistake body copy for a badge.
    const cands = S.qa(card, 'span, div, li');
    for (const el of cands) {
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length > 12) continue; // real badges are short
      const t = raw.toLowerCase();
      const isAdLabel =
        t === 'ad' || t === 'ad ·' || t === 'sponsored' || /^sponsored\b/.test(t);
      if (!isAdLabel) continue;
      // Exact 'Ad' is short and generic — require a badge-ish class to accept it
      // (avoids matching a stray 2-letter node); 'Sponsored' is accepted outright.
      if (t === 'ad' || t === 'ad ·') {
        if (AD_BADGE_CLASS_RE.test(classOf(el)) || AD_BADGE_CLASS_RE.test(classOf(el.parentElement))) {
          return true;
        }
        continue;
      }
      return true; // 'Sponsored' / 'Sponsored ...'
    }
    return false;
  }

  function cleanTitle(t) {
    return t ? t.replace(/\s+/g, ' ').trim() : '';
  }

  // Resolve the product title with layered fallbacks, rejecting breadcrumb junk.
  function titleFor(card, anchor) {
    // 1) Trust a [title] attribute ONLY when it sits on the actual PRODUCT anchor
    //    (href contains '/p/'). A stray [title] elsewhere in the card is often a
    //    breadcrumb/category chip ("Furniture"). Prefer the anchor's own [title].
    const ownTitle = cleanTitle(S.attr(anchor, 'title'));
    if (ownTitle && !looksLikeCategory(ownTitle)) return ownTitle;

    // A [title] on any /p/ product anchor within the card is also trustworthy.
    const pAnchor = S.firstEl(card, ['a[href*="/p/"][title]']);
    const pTitle = cleanTitle(S.attr(pAnchor, 'title'));
    if (pTitle && !looksLikeCategory(pTitle)) return pTitle;

    // 2) Known title classes (grid + list).
    const byClass = cleanTitle(S.firstText(card, SEL.title));
    if (byClass && !looksLikeCategory(byClass)) return byClass;

    // 3) Fall back to the product anchor's own visible text.
    const byText = cleanTitle(S.txt(anchor));
    if (byText && !looksLikeCategory(byText)) return byText;

    return '';
  }

  // Leading generic words that are never a brand on their own.
  const GENERIC_TITLE_WORDS = new Set([
    'the', 'a', 'an', 'new', 'genuine', 'original', 'premium', 'best', 'top',
    'buy', 'set', 'pack', 'combo', 'of',
  ]);

  // Derive a brand from the first 1-2 significant words of the title when no
  // explicit brand element exists (the worker still classifies the result).
  function brandFromTitle(title) {
    if (!title) return '';
    const words = title.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    let i = 0;
    while (i < words.length && GENERIC_TITLE_WORDS.has(words[i].toLowerCase())) i++;
    const significant = words.slice(i).filter((w) => w && !/^\d/.test(w) && w.length >= 2);
    if (!significant.length) return '';
    // Include a second word when the first is very short (e.g. "Dr", "The"),
    // to keep multiword brands meaningful.
    if (significant[0].replace(/[^A-Za-z0-9]/g, '').length <= 3 && significant[1]) {
      return significant[0] + ' ' + significant[1];
    }
    return significant[0];
  }

  function brandFor(card, title) {
    // Known brand classes; else derive from the title (worker still classifies).
    const explicit = S.firstText(card, SEL.brand);
    if (explicit && !looksLikeCategory(explicit)) return explicit;
    return brandFromTitle(title);
  }

  function reviewsFor(card) {
    // "1,234 Ratings & 56 Reviews" -> first int (the ratings count).
    return S.int(S.firstText(card, SEL.reviews));
  }

  // pid from the product href, else the card's data-id attribute.
  function itemIdFor(href, card) {
    const pid = pidFromHref(href);
    if (pid) return pid;
    return S.attr(card, 'data-id') || '';
  }

  // Pick the best product href on the card (a real /p/ anchor), preferring the
  // originating anchor. Used so url/pid reflect the product, not a stray link.
  function productHref(card, anchor) {
    const own = S.attr(anchor, 'href');
    if (own && own.indexOf('/p/') !== -1) return own;
    const a = S.firstEl(card, ['a[href*="/p/"]']);
    return a ? S.attr(a, 'href') : own;
  }

  // -------- main scrape (READ-ONLY) ------------------------------------------
  function scrape() {
    // Enumerate product anchors in DOM order (preserves rank across layouts).
    const anchors = S.qa(document, 'a[href*="/p/"]');
    const seenCards = new Set();
    const seenKeys = new Set(); // count each distinct product once
    const placements = [];
    let adRankCounter = 0;

    for (const anchor of anchors) {
      const rawHref = S.attr(anchor, 'href');
      if (!rawHref) continue;

      // Dedupe by pid / product path so image+title anchors count once.
      const key = dedupeKey(rawHref);
      if (seenKeys.has(key)) continue;

      const card = cardFor(anchor);
      if (!card || seenCards.has(card)) continue;

      const href = productHref(card, anchor);
      const title = titleFor(card, anchor);
      // Skip empties (image-only anchors, banners) and breadcrumb/category junk
      // ("Furniture") — neither is a real product card.
      if (!title || looksLikeCategory(title)) continue;

      seenCards.add(card);
      seenKeys.add(key);

      const sponsored = isSponsored(card);
      const brand = brandFor(card, title);
      const rank = placements.length + 1; // 1-based over KEPT cards, DOM order
      const adRank = sponsored ? ++adRankCounter : null;

      placements.push({
        rank,
        adRank,
        sponsored,
        brand,
        title,
        price: S.price(S.firstText(card, SEL.price)),
        mrp: S.price(S.firstText(card, SEL.mrp)),
        rating: S.rating(S.firstText(card, SEL.rating)),
        reviews: reviewsFor(card),
        itemId: itemIdFor(href, card),
        url: S.abs(href),
      });
    }

    return placements;
  }

  // -------- message handler ---------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== RR.MSG.SCRAPE) return; // not ours

    (async () => {
      let placements = [];
      try {
        // Results render progressively; wait briefly for at least one product
        // anchor + a title/price signal so we don't scrape an empty skeleton.
        await S.waitFor(
          () => {
            const a = S.q(document, 'a[href*="/p/"]');
            if (!a) return false;
            return !!(S.firstEl(document, SEL.title) || S.firstEl(document, SEL.price));
          },
          { timeout: 6000, interval: 250 }
        );
        placements = scrape();
      } catch (_) {
        placements = []; // never throw across the message boundary
      }
      const resp = { ok: true, url: location.href, placements };
      if (placements.length === 0) resp.note = 'no-results';
      sendResponse(resp);
    })();

    return true; // keep the channel open for the async sendResponse
  });
})(typeof self !== 'undefined' ? self : this);
