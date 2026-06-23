/**
 * ApexEnrich — derives the "Consolidated Data" enrichment columns (AF–BC)
 * from a scraped record, in the browser, so the exported workbook matches the
 * dashboard's "Consolidated Data" worksheet WITHOUT pasting into Excel first.
 *
 * INTEGRITY: like the extractor, this never invents product facts. Every value
 * is either read from the scraped record or derived by documented rules:
 *   • Product Type   — title + SEO keywords matched against the Maps keyword table
 *                      (last-match-wins, same as the workbook's LOOKUP formula).
 *   • Mattress Size  — stated width (ground truth) → size; else a size word in title.
 *   • Dimensions     — LxBxH parsed from the title ("Stated on listing"); else the
 *                      same brand+size footprint table the workbook ships with
 *                      ("Brand-typical"); else a generic India chart ("Size-standard").
 *   • Brand (Std)    — raw brand/title normalised via the Maps brand table.
 *   • Effective Price— Wow/Best price if captured, else the Active price.
 *
 * Vocabulary and lookup tables are transcribed from the workbook's "Maps",
 * "Type Master" and "How to Use" sheets so output buckets match 1:1.
 */
(function (root) {
  'use strict';

  // title/keyword substring -> Product Type. ORDER MATTERS: when several match,
  // the LAST one wins (mirrors the workbook's LOOKUP(2,1/SEARCH(...)) behaviour),
  // so "memory foam" -> Memory Foam and "ortho foam" -> Ortho Foam, not Other Foam.
  const TYPE_KEYWORDS = [
    ['foam', 'Other Foam'],
    ['memory', 'Memory Foam'],
    ['spine', 'Ortho Foam'],
    ['ortho', 'Ortho Foam'],
    ['dual', 'Dual Foam'],
    ['rubberi', 'Coir'],
    ['coir', 'Coir'],
    ['bonnell', 'Spring'],
    ['pocket', 'Spring'],
    ['spring', 'Spring'],
    ['latex', 'Latex Foam'],
    ['grid', 'Grid']
  ];

  // raw brand/title substring -> standardised brand name
  const BRAND_MAP = [
    ['duro flex', 'Duroflex'],
    ['duroflex', 'Duroflex'],
    ['sleep company', 'The Sleep Company'],
    ['sleepwell', 'Sleepwell'],
    ['sleepyhead', 'Sleepyhead'],
    ['sleepycat', 'SleepyCat'],
    ['sleepyhug', 'SleepyHug'],
    ['wakefit', 'Wakefit'],
    ['centuary', 'Centuary'],
    ['nilkamal', 'Nilkamal'],
    ['springtek', 'Springtek'],
    ['kurl', 'Kurlon'],
    ['peps', 'Peps'],
    ['emma', 'Emma'],
    ['loom', 'Loom & Needles'],
    ['flo', 'Flo']
  ];

  const SIZE_KEYWORDS = [
    ['diwan', 'Diwan'],
    ['single', 'Single'],
    ['double', 'Double'],
    ['queen', 'Queen'],
    ['king', 'King']
  ];

  // brand|size -> [Length, Breadth] in inches (transcribed from the Maps sheet).
  const FOOTPRINT = {
    'Wakefit|King': [78, 72], 'Sleepwell|King': [72, 70], 'Duroflex|King': [78, 72],
    'Wakefit|Single': [72, 30], 'Wakefit|Queen': [75, 60], 'Sleepyhead|Single': [72, 35],
    'Sleepyhead|Double': [75, 48], 'Duroflex|Double': [72, 48], 'SleepyHug|King': [72, 72],
    'Nilkamal|Queen': [78, 60], 'Emma|King': [72, 72], 'Emma|Double': [72, 48],
    'Interio By Godrej|Queen': [78, 60], 'Flo|Double': [72, 48], 'Duroflex|Queen': [78, 60],
    'Duroflex|Single': [72, 30], 'Sleepyhead|Queen': [75, 60], 'The Sleep Company|King': [78, 72],
    'The Sleep Company|Double': [78, 48], 'Emma|Queen': [75, 60], 'Emma|Single': [72, 36],
    'Wakefit|Double': [72, 48], 'Sleepwell|Queen': [72, 60], 'Centuary|Single': [72, 36],
    'Centuary|Queen': [75, 60], 'Centuary|King': [78, 72], 'The Sleep Company|Queen': [78, 60],
    'The Sleep Company|Single': [72, 36], 'Peps|Queen': [78, 60], 'Springtek|Queen': [75, 60],
    'Sleepyhead|King': [78, 72], 'Peps|Single': [75, 36], 'Peps|King': [78, 72],
    'Peps|Double': [78, 48], 'SleepyHug|Queen': [72, 60], 'SleepyHug|Single': [72, 36],
    'Nilkamal|King': [78, 72], 'Nilkamal|Single': [75, 36], 'Nilkamal|Double': [72, 47],
    'SleepyCat|Queen': [75, 60], 'SleepyCat|Double': [75, 48], 'SleepyCat|King': [84, 72],
    'SleepyCat|Single': [72, 36], 'Wakefit|Diwan': [72, 48], 'Flo|King': [78, 72],
    'Repose|Single': [72, 36], 'Centuary|Double': [72, 48], 'Flo|Single': [72, 30],
    'Livpure Smart|Queen': [72, 60], 'SleepyHug|Double': [72, 48], 'Mm Foam|Double': [72, 48],
    'Restofit|Single': [72, 30], 'Atootfusion|Single': [72, 35], 'Livpure Smart|King': [78, 72],
    'Mm Foam|Queen': [75, 60], 'Interio By Godrej|King': [78, 72], 'Livpure Smart|Single': [72, 36],
    'Mm Foam|Single': [72, 36], 'Kurlon|Single': [72, 30], 'Kurlon|Double': [75, 48],
    'Sleepwell|Double': [72, 48], 'Sleepwell|Single': [72, 30], 'Kurlon|King': [78, 72],
    'Kurlon|Queen': [72, 60], 'Comforto|Queen': [78, 66], 'Springtek|King': [75, 72],
    'Flo|Queen': [78, 60]
  };

  // generic India size chart — last-resort [Length, Breadth] when no footprint match
  const SIZE_CHART = {
    'King': [78, 72], 'Queen': [78, 60], 'Double': [75, 48], 'Single': [75, 36], 'Diwan': [72, 35]
  };

  function num(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? '' : n;
  }

  function titleCase(s) {
    return String(s || '').trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }

  // last-match-wins classifier (returns '' when nothing matches)
  function classifyType(text) {
    const t = (text || '').toLowerCase();
    if (!t) return '';
    // Pure Latex is a stronger signal than the generic "latex" keyword
    if (/(pure|natural|100\s*%|organic)\s*latex/.test(t)) return 'Pure Latex';
    let best = '', bestIdx = -1;
    for (let i = 0; i < TYPE_KEYWORDS.length; i++) {
      if (t.includes(TYPE_KEYWORDS[i][0]) && i > bestIdx) { bestIdx = i; best = TYPE_KEYWORDS[i][1]; }
    }
    return best;
  }

  function stdBrand(rawBrand, title) {
    const b = (rawBrand || '').toLowerCase();
    for (const [k, v] of BRAND_MAP) if (b && b.includes(k)) return v;
    const t = (title || '').toLowerCase();
    for (const [k, v] of BRAND_MAP) if (t.includes(k)) return v;
    if (rawBrand && rawBrand.trim()) return titleCase(rawBrand);
    return 'Unknown';
  }

  function sizeFromKeyword(text) {
    const t = (text || '').toLowerCase();
    if (!t) return '';
    for (const [k, v] of SIZE_KEYWORDS) if (t.includes(k)) return v;
    return '';
  }

  // width (breadth, inches) -> size, per the workbook's "width is ground truth" rule
  function sizeFromWidth(width) {
    if (!width || width <= 0) return '';
    if (width >= 69) return 'King';
    if (width >= 54) return 'Queen';
    if (width >= 42) return 'Double';
    return 'Single';
  }

  // parse "72x72x6" / "78 X 72 X 8" / "(72x72x6)" from the title -> [L,B,H?]
  function parseDimsFromTitle(title) {
    const t = String(title || '');
    const m = t.match(/(\d{2,3})\s*[x×X*]\s*(\d{2,3})(?:\s*[x×X*]\s*(\d{1,2}))?/);
    if (!m) return null;
    const L = parseInt(m[1], 10), B = parseInt(m[2], 10);
    const H = m[3] != null ? parseInt(m[3], 10) : null;
    if (L < 30 || L > 120 || B < 20 || B > 100) return null; // sanity for mattress inches
    return [L, B, H];
  }

  // thickness in inches from the title ("6-inch", "6 inch", '6"')
  function thicknessFromTitle(title) {
    const t = String(title || '');
    let m = t.match(/(\d{1,2})\s*-?\s*inch/i);
    if (m) return parseInt(m[1], 10);
    m = t.match(/(\d{1,2})\s*["”]/);
    if (m) return parseInt(m[1], 10);
    return '';
  }

  function inStockFlag(availability) {
    const a = (availability || '').toLowerCase();
    if (!a) return 'Unknown';
    if (/out of stock|unavailable|sold out/.test(a)) return 'Out of Stock';
    if (/in stock|available|left in stock|order soon/.test(a)) return 'In Stock';
    return 'Unknown';
  }

  function primeAssuredFlag(assured) {
    const a = (assured || '').toLowerCase();
    return /yes|prime|assured/.test(a) ? 'Yes' : 'No';
  }

  // "6/9/2026, 3:35:13 PM" (or ISO date) -> { dateObj: Date|'' , timeStr: 'HH:MM:SS'|'' }
  function splitTimestamp(ts, dateStr) {
    let d = null;
    if (ts) { const p = new Date(ts); if (!isNaN(p.getTime())) d = p; }
    if (!d && dateStr) { const p = new Date(dateStr + 'T00:00:00'); if (!isNaN(p.getTime())) d = p; }
    if (!d) return { dateObj: '', timeStr: '' };
    const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const pad = n => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { dateObj: dateOnly, timeStr };
  }

  /**
   * Given a scraped record (as produced by ApexExtractor + background bookkeeping),
   * return the 24 derived "Consolidated Data" fields (AF–BC).
   */
  function enrich(r) {
    r = r || {};
    const title = r.title || '';
    const seo = r.topKeywords || '';

    // ---- timestamp split ----
    const { dateObj, timeStr } = splitTimestamp(r.scrapeTime, r.scrapeDate);

    // ---- brand / type ----
    const brandStd = stdBrand(r.brand, title);
    const typeFromTitle = classifyType(title);
    const typeFromSeo = classifyType(seo);
    const productType = typeFromTitle || typeFromSeo || 'Other';

    let typeConfidence;
    if (typeFromTitle && typeFromSeo) {
      typeConfidence = (typeFromTitle === typeFromSeo) ? 'Title+SEO agree' : 'Title+SEO differ';
    } else if (typeFromTitle) typeConfidence = 'Title only';
    else if (typeFromSeo) typeConfidence = 'SEO only';
    else typeConfidence = 'Unclassified';

    // ---- dimensions (L x B x H) ----
    let L = '', B = '', H = '', basis = 'Not determinable';
    const stated = parseDimsFromTitle(title);
    const titleSize = sizeFromKeyword(title);
    let size = '';

    if (stated) {
      L = stated[0]; B = stated[1];
      H = stated[2] != null ? stated[2] : (thicknessFromTitle(title) || '');
      basis = 'Stated on listing';
      // width is the ground truth for size; fall back to the title's size word
      size = sizeFromWidth(B) || titleSize || 'Unspecified';
      if (/diwan/i.test(title)) size = 'Diwan';
    } else {
      size = titleSize || 'Unspecified';
      const fp = FOOTPRINT[brandStd + '|' + size];
      if (fp) {
        L = fp[0]; B = fp[1]; basis = 'Brand-typical';
      } else if (SIZE_CHART[size]) {
        L = SIZE_CHART[size][0]; B = SIZE_CHART[size][1]; basis = 'Size-standard';
      }
      H = thicknessFromTitle(title) || '';
    }

    const thickness = (H !== '' && H != null) ? H : (thicknessFromTitle(title) || '');
    const dimToken = (L !== '' && B !== '' && H !== '' && H != null)
      ? `${L}x${B}x${H}`
      : (L !== '' && B !== '' ? `${L}x${B}` : '');

    // ---- pricing ----
    const active = num(r.price);
    const wow = num(r.wowPrice);
    const bank = num(r.bankOfferPrice);
    let best = '';
    if (wow !== '' && wow > 0) best = wow;
    else if (bank !== '' && bank > 0) best = bank;
    else best = active;
    const effective = best;

    return {
      scrapedDate: dateObj,
      scrapedTime: timeStr,
      brandStd: brandStd,
      productType: productType,
      mattressSize: size || 'Unspecified',
      thickness: thickness,
      inStockFlag: inStockFlag(r.availability),
      primeAssuredFlag: primeAssuredFlag(r.assured || r.flipkartAssured),
      effectivePrice: effective,
      dimensions: dimToken,
      wowBestPrice: best,
      dimToken: dimToken,
      length: L,
      breadth: B,
      height: (H !== '' && H != null) ? H : '',
      dimensionBasis: basis,
      typeConfidence: typeConfidence
    };
  }

  const api = { enrich, classifyType, stdBrand, parseDimsFromTitle, FOOTPRINT, SIZE_CHART };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ApexEnrich = api;
})(typeof self !== 'undefined' ? self : this);
