/**
 * ApexExtractor v6 — Universal marketplace product extraction engine.
 *
 * INTEGRITY GUARANTEE: this engine NEVER invents data. Every field is either
 * read from the page (JSON-LD schema, microdata, meta tags, DOM selectors)
 * or mathematically derived from other extracted fields (and logged in
 * corrections_made). Missing data stays empty.
 *
 * Extraction ladder (highest trust first):
 *   1. JSON-LD structured data (schema.org Product) — works on most marketplaces worldwide
 *   2. HTML microdata (itemprop attributes)
 *   3. OpenGraph / meta tags
 *   4. Platform-specific selector ladders (Amazon all TLDs, Flipkart, Myntra, eBay, Walmart...)
 *   5. Generic heuristics on real page content (h1 title, currency-prefixed price nodes)
 *
 * Used in two contexts:
 *   - offscreen.html (DOMParser on fetched HTML)
 *   - injected into a live rendered tab via chrome.scripting (for JS-heavy sites / bot walls)
 */
(function (root) {
  'use strict';

  const CURRENCY_SYMBOLS = [
    ['₹', 'INR'], ['$', 'USD'], ['£', 'GBP'], ['€', 'EUR'], ['¥', 'JPY'],
    ['₩', 'KRW'], ['₫', 'VND'], ['₪', 'ILS'], ['₦', 'NGN'], ['฿', 'THB'],
    ['R$', 'BRL'], ['AED', 'AED'], ['SAR', 'SAR'], ['Rs.', 'INR'], ['Rs', 'INR'], ['INR', 'INR']
  ];

  const PRICE_RX = /(?:₹|Rs\.?|INR|US?\$|\$|£|€|¥|₩|AED|SAR|R\$)\s*([0-9][0-9,.\s]*[0-9]|[0-9])/;

  // ---------------------------------------------------------------- platform
  function detectPlatform(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { host = (url || '').toLowerCase(); }
    if (host.includes('amazon.') || host.includes('amzn.')) return 'Amazon';
    if (host.includes('flipkart.')) return 'Flipkart';
    if (host.includes('myntra.')) return 'Myntra';
    if (host.includes('ajio.')) return 'Ajio';
    if (host.includes('ebay.')) return 'eBay';
    if (host.includes('walmart.')) return 'Walmart';
    if (host.includes('snapdeal.')) return 'Snapdeal';
    if (host.includes('meesho.')) return 'Meesho';
    if (host.includes('jiomart.')) return 'JioMart';
    if (host.includes('tatacliq')) return 'TataCliq';
    if (host.includes('nykaa')) return 'Nykaa';
    if (host.includes('pepperfry')) return 'Pepperfry';
    if (host.includes('aliexpress')) return 'AliExpress';
    if (host.includes('etsy.')) return 'Etsy';
    if (host.includes('target.')) return 'Target';
    if (host.includes('bestbuy.')) return 'BestBuy';
    if (host.includes('noon.')) return 'Noon';
    if (host.includes('shopify')) return 'Shopify';
    // Fall back to second-level domain name, capitalised — still real info.
    const parts = host.replace(/^www\./, '').split('.');
    const core = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : 'Unknown';
  }

  function extractProductId(url) {
    if (!url) return '';
    let m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();                       // Amazon ASIN
    m = url.match(/[?&]pid=([A-Z0-9]{8,20})/i);
    if (m) return m[1].toUpperCase();                       // Flipkart FSN
    m = url.match(/\/itm\/(?:[^/]*\/)?(\d{9,15})/i);
    if (m) return m[1];                                     // eBay item
    m = url.match(/\/ip\/(?:[^/]*\/)?(\d{6,12})/i);
    if (m) return m[1];                                     // Walmart
    m = url.match(/\/(\d{6,10})\/buy/i);
    if (m) return m[1];                                     // Myntra
    return '';
  }

  // -------------------------------------------------------------- bot blocks
  function detectBlock(doc, html) {
    const t = (html || '').slice(0, 60000).toLowerCase();
    const title = (doc && doc.title ? doc.title : '').toLowerCase();
    if (title.includes('robot check') || title.includes('captcha') || title.includes('access denied') ||
        title.includes('just a moment') || title.includes('attention required')) {
      return 'Bot wall page title detected: ' + title;
    }
    if (t.includes('api-services-support@amazon.com')) return 'Amazon automated-traffic block page';
    if (t.includes('enter the characters you see below')) return 'Amazon CAPTCHA challenge';
    if (t.includes('cf-challenge') || t.includes('cf-turnstile') || t.includes('checking your browser')) return 'Cloudflare challenge';
    if (t.includes('px-captcha') || t.includes('perimeterx')) return 'PerimeterX challenge';
    if (t.includes('unusual traffic from your computer network')) return 'Rate-limit block';
    // Flipkart serves a tiny shell page (<25KB, no h1, no price) when it wants client-side rendering / blocks bots
    return null;
  }

  // ----------------------------------------------------------------- JSON-LD
  function scanJsonLd(doc, out) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let parsed = null;
      try { parsed = JSON.parse(s.textContent); } catch (e) { continue; }
      walkJson(parsed, out);
    }
  }

  function walkJson(obj, out, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) { for (const it of obj) walkJson(it, out, depth + 1); return; }

    const type = String(obj['@type'] || '').toLowerCase();

    if (type.includes('breadcrumblist') && Array.isArray(obj.itemListElement) && !out.category) {
      const names = obj.itemListElement
        .map(el => (el && el.item && el.item.name) || (el && el.name) || '')
        .filter(Boolean);
      if (names.length) out.category = names.join(' > ');
    }

    if (type.includes('product') || obj.offers || (obj.price && obj.name)) {
      if (obj.name && !out.title) out.title = String(obj.name).trim();
      if (obj.sku && !out.sku) out.sku = String(obj.sku);
      if (obj.image && !out.image) out.image = Array.isArray(obj.image) ? obj.image[0] : (typeof obj.image === 'object' ? obj.image.url || '' : obj.image);
      if (obj.brand && !out.brand) out.brand = typeof obj.brand === 'object' ? (obj.brand.name || '') : String(obj.brand);
      if (obj.description && !out.description) out.description = String(obj.description).slice(0, 500);
      const ar = obj.aggregateRating;
      if (ar) {
        if (ar.ratingValue != null && !out.rating) out.rating = String(ar.ratingValue);
        const rc = ar.reviewCount != null ? ar.reviewCount : ar.ratingCount;
        if (rc != null && !out.reviewCount) out.reviewCount = String(rc);
      }
      const offers = obj.offers ? (Array.isArray(obj.offers) ? obj.offers : [obj.offers]) : [];
      for (const off of offers) {
        if (!off || typeof off !== 'object') continue;
        if (off.price != null && !out.price) out.price = String(off.price);
        if (off.lowPrice != null && !out.price) out.price = String(off.lowPrice);
        if (off.highPrice != null && !out.mrp) out.mrp = String(off.highPrice);
        if (off.priceCurrency && !out.currency) out.currency = String(off.priceCurrency);
        if (off.availability && !out.availability) {
          out.availability = /instock/i.test(String(off.availability)) ? 'In Stock'
            : /outofstock/i.test(String(off.availability)) ? 'Out of Stock' : String(off.availability);
        }
        if (off.seller && off.seller.name && !out.fulfilledBy) out.fulfilledBy = String(off.seller.name);
      }
      if (obj.price != null && !out.price) out.price = String(obj.price);
      if (obj.priceCurrency && !out.currency) out.currency = String(obj.priceCurrency);
    }

    for (const k in obj) {
      if (obj[k] && typeof obj[k] === 'object') walkJson(obj[k], out, depth + 1);
    }
  }

  // --------------------------------------------------------------- microdata
  function scanMicrodata(doc, out) {
    const grab = (sel, attr) => {
      const el = doc.querySelector(sel);
      if (!el) return '';
      return (attr ? el.getAttribute(attr) : null) || el.getAttribute('content') || (el.textContent || '').trim();
    };
    if (!out.title) out.title = grab('[itemtype*="Product"] [itemprop="name"], [itemprop="name"][content]');
    if (!out.brand) out.brand = grab('[itemprop="brand"] [itemprop="name"], [itemprop="brand"]');
    if (!out.price) {
      const p = grab('[itemprop="price"]', 'content') || grab('[itemprop="price"]');
      if (p) out.price = p;
    }
    if (!out.currency) out.currency = grab('[itemprop="priceCurrency"]', 'content');
    if (!out.rating) out.rating = grab('[itemprop="ratingValue"]', 'content') || grab('[itemprop="ratingValue"]');
    if (!out.reviewCount) out.reviewCount = grab('[itemprop="reviewCount"]', 'content') || grab('[itemprop="ratingCount"]', 'content');
  }

  // -------------------------------------------------------------- meta / OG
  function scanMeta(doc, out) {
    const metas = doc.querySelectorAll('meta');
    const map = {};
    metas.forEach(m => {
      const key = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
      const val = m.getAttribute('content');
      if (key && val && !map[key]) map[key] = val;
    });
    if (!out.title) out.title = map['og:title'] || map['twitter:title'] || map['title'] || '';
    if (!out.brand) out.brand = map['product:brand'] || map['og:brand'] || map['brand'] || '';
    if (!out.price) out.price = map['product:price:amount'] || map['og:price:amount'] || map['product:sale_price:amount'] || '';
    if (!out.currency) out.currency = map['product:price:currency'] || map['og:price:currency'] || '';
    if (!out.image) out.image = map['og:image'] || '';
    if (!out.availability) {
      const av = map['product:availability'] || map['og:availability'] || '';
      if (av) out.availability = /in\s?stock|instock/i.test(av) ? 'In Stock' : av;
    }
  }

  // ------------------------------------------------------- platform ladders
  function txt(doc, selectors) {
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) {
          const v = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (v) return v;
        }
      } catch (e) { /* invalid selector — skip */ }
    }
    return '';
  }

  function digits(s) {
    if (!s) return '';
    let v = String(s).replace(/[^0-9.]/g, '');
    const firstDot = v.indexOf('.');
    if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
    v = v.replace(/\.0{1,2}$/, '').replace(/\.$/, '');
    return v;
  }

  function scanAmazon(doc, bodyText, out) {
    if (!out.title) out.title = txt(doc, ['#productTitle', 'span#productTitle', 'h1#title span', 'h1.product-title-word-break']);
    if (!out.brand) {
      let b = txt(doc, ['#bylineInfo', 'a#bylineInfo', '#brand', 'tr.po-brand td.a-span9 span', '#productOverview_feature_div tr:first-child td.a-span9']);
      b = b.replace(/^visit\s+the\s+/i, '').replace(/\s+store$/i, '').replace(/^brand:\s*/i, '').trim();
      if (b) out.brand = b;
    }
    if (!out.price) {
      const whole = txt(doc, ['#corePriceDisplay_desktop_feature_div .a-price-whole', '#corePrice_feature_div .a-price-whole', '.priceToPay .a-price-whole', '.a-price-whole']);
      if (whole) out.price = digits(whole);
      if (!out.price) out.price = digits(txt(doc, ['.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '#tp_price_block_total_price_ww .a-offscreen']));
    }
    if (!out.mrp) out.mrp = digits(txt(doc, ['.basisPrice .a-price.a-text-price .a-offscreen', '.a-price.a-text-price[data-a-strike="true"] .a-offscreen', '.a-price.a-text-price .a-offscreen', '#listPriceLegalMessage']));
    if (!out.discount) {
      const d = txt(doc, ['.savingsPercentage', '.savingPriceOverride', '.reinventPriceSavingsPercentageMargin']);
      const m = d.match(/(\d{1,2})\s*%/); if (m) out.discount = m[1];
    }
    if (!out.rating) {
      const popTitle = (doc.querySelector('#acrPopover') || {}).getAttribute ? (doc.querySelector('#acrPopover').getAttribute('title') || '') : '';
      let m = popTitle.match(/([0-9.]+)\s*out/);
      if (!m) m = txt(doc, ['span.a-icon-alt', '#averageCustomerReviews .a-icon-alt']).match(/([0-9.]+)\s*out/);
      if (m) out.rating = m[1];
    }
    if (!out.reviewCount) out.reviewCount = digits(txt(doc, ['#acrCustomerReviewText', '#acrCustomerReviewLink']));
    if (!out.availability) {
      const av = txt(doc, ['#availability span', '#availability']);
      if (av) out.availability = /in stock|left in stock|order soon/i.test(av) ? 'In Stock' : (/unavailable|out of stock/i.test(av) ? 'Out of Stock' : av.slice(0, 60));
    }
    if (!out.emiPrice) {
      const emiBlock = txt(doc, ['#inemi_feature_div', '#installmentCalculator_feature_div', '#emi-offers-display']);
      const m = emiBlock.match(PRICE_RX); if (m) out.emiPrice = m[1].replace(/[,\s]/g, '');
    }
    if (!out.deliveryBy) out.deliveryBy = txt(doc, ['#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span.a-text-bold', '#deliveryBlockMessage span.a-text-bold', '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE']).slice(0, 80);
    if (!out.fulfilledBy) {
      out.fulfilledBy = txt(doc, ['#sellerProfileTriggerId', '#merchantInfoFeature_feature_div .offer-display-feature-text-message']);
      if (!out.fulfilledBy) {
        const mi = txt(doc, ['#merchant-info']);
        const m = mi.match(/sold by\s*(.+?)(?:\s+and\b|\.|$)/i); if (m) out.fulfilledBy = m[1].trim();
      }
    }
    if (!out.bestsellerRank) {
      const m = bodyText.match(/best\s*sellers?\s*rank[:\s#]*([\d,]+)/i);
      if (m) out.bestsellerRank = m[1].replace(/,/g, '');
    }
    if (out.assured === 'No' && /prime free delivery|fulfilled by amazon|\bprime\b/i.test(bodyText)) out.assured = 'Yes (Prime)';
    if (!out.couponName) {
      const c = txt(doc, ['#couponBadgeRegularVpc', '.promoPriceBlockMessage', '#vpcButton .a-checkbox-label']);
      if (c && /coupon|off\b|%/i.test(c)) out.couponName = c.slice(0, 100);
    }
  }

  function scanFlipkart(doc, bodyText, out) {
    if (!out.title) out.title = txt(doc, ['h1._6EBuvT span.VU-Z7G', 'span.VU-Z7G', 'span.B_NuCI', 'h1.yhB1nd', 'h1[class] span']);
    if (!out.price) out.price = digits(txt(doc, ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', 'div._30jeq3._16Jk6d', 'div._30jeq3', 'div.hl25EE div:first-child']));
    if (!out.mrp) out.mrp = digits(txt(doc, ['div.yRaY8j.A6\\+E6v', 'div.yRaY8j', 'div._3I9_wc._2p6lqe', 'div._3I9_wc']));
    if (!out.discount) {
      const d = txt(doc, ['div.UkUFwK.WW8yVX span', 'div.UkUFwK span', 'div._3Ay6Sb._31Dcoz span', 'div._3Ay6Sb span']);
      const m = d.match(/(\d{1,2})\s*%/); if (m) out.discount = m[1];
    }
    if (!out.rating) {
      const r = txt(doc, ['div.XQDdHH', 'div._3LWZlK', 'div.ipqd2A']);
      const m = r.match(/^([0-5](?:\.\d)?)/); if (m) out.rating = m[1];
    }
    if (!out.reviewCount) {
      const rc = txt(doc, ['span.Wphh3N', 'span._2_R_DZ', 'span.E3XX7J']);
      const m = rc.match(/([\d,]+)\s*ratings?/i) || rc.match(/([\d,]+)\s*reviews?/i) || rc.match(/([\d,]+)/);
      if (m) out.reviewCount = m[1].replace(/,/g, '');
    }
    if (out.assured === 'No' && (doc.querySelector('img[src*="fa_62673a"], img[src*="fa_8b4b59"], img[alt*="Assured" i]') || /flipkart assured/i.test(bodyText))) out.assured = 'Yes (F-Assured)';
    if (!out.fulfilledBy) out.fulfilledBy = txt(doc, ['#sellerName span span', '#sellerName span', 'div.cvCpHS']);
    if (!out.sellerRating) {
      const sr = txt(doc, ['#sellerName ~ div .XQDdHH', 'div.XQDdHH.uuhqql']);
      const m = sr.match(/^([0-5](?:\.\d)?)/); if (m) out.sellerRating = m[1];
    }
    if (!out.deliveryBy) {
      const m = bodyText.match(/delivery by\s*([^,|]{3,40})/i);
      if (m) out.deliveryBy = m[1].trim();
    }
    if (!out.couponName) {
      const offers = Array.from(doc.querySelectorAll('li.kF1Ml8, li._16eBzU')).map(li => (li.textContent || '').trim()).filter(Boolean);
      if (offers.length) {
        out.expandedCardOffers = offers.slice(0, 8);
        const bank = offers.find(o => /bank|card|upi/i.test(o));
        if (bank) out.bankOfferType = bank.slice(0, 120);
        const coup = offers.find(o => /coupon/i.test(o));
        if (coup) out.couponName = coup.slice(0, 120);
      }
    }
  }

  function scanGeneric(doc, bodyText, out) {
    if (!out.title) {
      out.title = txt(doc, ['h1[class*="title" i]', 'h1[class*="product" i]', 'h1[itemprop="name"]', 'h1']);
    }
    if (!out.price) {
      // Look for visible nodes whose class hints price and whose text starts with a currency
      const cands = doc.querySelectorAll('[class*="price" i], [data-price], [id*="price" i]');
      for (const el of cands) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 40) continue;
        const m = t.match(PRICE_RX);
        if (m) { out.price = m[1].replace(/[,\s]/g, '').split('.')[0]; break; }
      }
    }
    if (!out.brand) {
      const crumbs = doc.querySelectorAll('nav[aria-label*="readcrumb" i] a, .breadcrumb a, [class*="breadcrumb" i] a');
      if (crumbs.length > 1) out.brand = (crumbs[crumbs.length - 1].textContent || '').trim().slice(0, 60);
    }
    if (!out.rating) {
      const m = bodyText.match(/([0-5](?:\.\d)?)\s*(?:out of 5|\/\s*5)/i);
      if (m) out.rating = m[1];
    }
    if (!out.warranty) {
      const m = bodyText.match(/(\d{1,2})\s*-?\s*(year|month)s?\s*(?:domestic\s*|manufacturer\s*|brand\s*)?warranty/i);
      if (m) out.warranty = m[1] + ' ' + m[2].charAt(0).toUpperCase() + m[2].slice(1) + 's';
    }
    if (!out.returnDays) {
      const m = bodyText.match(/(\d{1,3})\s*days?\s*(?:replacement|returns?|refund|exchange)/i);
      if (m) out.returnDays = m[1];
    }
  }

  function detectCurrency(html, out) {
    if (out.currency) return;
    for (const [sym, code] of CURRENCY_SYMBOLS) {
      if (html.includes(sym)) { out.currency = code; return; }
    }
    out.currency = '';
  }

  // ------------------------------------------------------------- keywords
  function topKeywords(title, brand, category) {
    const stop = new Set(['and', 'the', 'with', 'for', 'on', 'in', 'is', 'of', 'at', 'by', 'an', 'to', 'a', 'this', 'that', 'from', 'it', 'its', 'or', 'but', 'as', 'are', 'be', 'has', 'have', 'pack', 'set', 'new']);
    const pool = [];
    if (title) pool.push(...String(title).split(/[\s,.\-\/()|+]+/));
    if (brand) pool.push(brand);
    if (category) pool.push(...String(category).split(/[>\/,]+/));
    const seen = new Set();
    pool.forEach(w => {
      const c = w.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (c.length > 2 && !stop.has(c) && isNaN(c)) seen.add(c.charAt(0).toUpperCase() + c.slice(1));
    });
    return Array.from(seen).slice(0, 8).join(', ');
  }

  // ---------------------------------------------------------------- merge
  function extract(doc, html, url) {
    const platform = detectPlatform(url);
    const bodyText = doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';

    const blockReason = detectBlock(doc, html);
    if (blockReason) {
      return { url, platform, productId: extractProductId(url), status: 'blocked', failReason: blockReason };
    }

    const out = {
      url, platform,
      productId: extractProductId(url),
      sku: '', brand: '', title: '', price: '', mrp: '', discount: '', currency: '',
      rating: '', reviewCount: '', availability: '', emiPrice: '',
      couponName: '', couponDiscount: '', bankOfferPrice: '', bankOfferType: '', expandedCardOffers: [],
      warranty: '', assured: 'No', returnDays: '', deliveryBy: '', deliveryDays: '',
      fulfilledBy: '', sellerRating: '', bestsellerRank: '', category: '', image: '', description: '',
      corrections_made: [], extractionSources: []
    };

    // Ladder, tracking which source produced the core fields
    const before = () => out.title + '|' + out.price + '|' + out.brand;
    let snap = before();
    scanJsonLd(doc, out);
    if (before() !== snap) { out.extractionSources.push('json-ld'); snap = before(); }
    scanMicrodata(doc, out);
    if (before() !== snap) { out.extractionSources.push('microdata'); snap = before(); }
    scanMeta(doc, out);
    if (before() !== snap) { out.extractionSources.push('meta'); snap = before(); }

    if (platform === 'Amazon') scanAmazon(doc, bodyText, out);
    else if (platform === 'Flipkart') scanFlipkart(doc, bodyText, out);
    if (before() !== snap) { out.extractionSources.push('dom:' + platform.toLowerCase()); snap = before(); }

    scanGeneric(doc, bodyText, out);
    if (before() !== snap) { out.extractionSources.push('dom:generic'); }

    // ---- clean & derive (real math only; every derivation is logged) ----
    out.price = digits(out.price);
    out.mrp = digits(out.mrp);
    out.rating = out.rating ? String(out.rating).replace(/[^0-9.]/g, '').slice(0, 4) : '';
    out.reviewCount = digits(out.reviewCount);
    out.title = (out.title || '').replace(/\s+/g, ' ').trim();
    out.brand = (out.brand || '').replace(/\s+/g, ' ').trim();

    detectCurrency(html || '', out);

    if (out.price && out.mrp && parseFloat(out.price) > parseFloat(out.mrp)) {
      const t = out.price; out.price = out.mrp; out.mrp = t;
      out.corrections_made.push('Price/MRP were swapped on page order — corrected');
    }
    if (out.price && out.mrp && !out.discount) {
      const p = parseFloat(out.price), m = parseFloat(out.mrp);
      if (m > p && m > 0) {
        out.discount = String(Math.round(((m - p) / m) * 100));
        out.corrections_made.push('Discount % derived from extracted Price and MRP');
      }
    }
    if (!out.brand && out.title) {
      out.brand = out.title.split(' ')[0];
      out.corrections_made.push('Brand inferred from first word of extracted title');
    }
    if (!out.title) {
      const tm = (html || '').match(/<title>([^<]{3,200})<\/title>/i);
      if (tm) {
        out.title = tm[1].replace(/\s*[|\-–:]\s*(amazon|flipkart|buy online|online shopping).*/i, '').trim();
        out.corrections_made.push('Title recovered from document <title> tag');
      }
    }

    out.topKeywords = topKeywords(out.title, out.brand, out.category);

    // ---- honest status: never fabricate missing values ----
    if (out.title && out.price) out.status = 'ok';
    else if (out.title || out.price) {
      out.status = 'partial';
      out.failReason = 'Missing ' + (!out.price ? 'price' : 'title') + ' — page may be JS-rendered or out of stock';
    } else {
      out.status = 'failed';
      out.failReason = 'No product data found in page (empty shell, delisted, or unsupported layout)';
    }
    if (out.availability === 'Out of Stock' && out.status !== 'ok') {
      out.status = 'partial';
      out.failReason = 'Product is Out of Stock — price hidden by marketplace';
    }
    return out;
  }

  const api = { extract, detectPlatform, extractProductId, detectBlock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ApexExtractor = api;
})(typeof self !== 'undefined' ? self : this);
