/*
 * Rivalry Radar — settings page controller.
 * Reads/writes config via RR.storage; clears scans/log. All events wired with
 * addEventListener (no inline handlers). READ-ONLY tool: there is no UI here
 * that could enable ad-clicking — clickAds stays hard-locked false in storage.
 */
(function () {
  'use strict';

  const RR = self.RR;

  if (!RR || !RR.storage) {
    // Spine scripts didn't load — surface a visible message instead of a dead page.
    const showDead = () => {
      const e = document.getElementById('err');
      if (e) {
        e.textContent =
          'Settings could not initialize because the extension scripts did not load. ' +
          'Open chrome://extensions and click Reload on Rivalry Radar, then reopen Settings.';
        e.hidden = false;
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showDead);
    else showDead();
    return;
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('cfg-form'),
    keywords: $('keywords'),
    kwcount: $('kwcount'),
    myBrands: $('myBrands'),
    excludeBrands: $('excludeBrands'),
    amazon: $('mkt-amazon'),
    flipkart: $('mkt-flipkart'),
    cadenceSec: $('cadenceSec'),
    maxScansKept: $('maxScansKept'),
    pagesPerKeyword: $('pagesPerKeyword'),
    uploadSheetBtn: $('uploadSheetBtn'),
    sheetInput: $('sheetInput'),
    reviewsEnabled: $('reviewsEnabled'),
    reviewCadenceMin: $('reviewCadenceMin'),
    reviewsPerProduct: $('reviewsPerProduct'),
    productsPerReviewCycle: $('productsPerReviewCycle'),
    err: $('err'),
    save: $('save'),
    clearScans: $('clear-scans'),
    clearReviews: $('clear-reviews'),
    clearLog: $('clear-log'),
    toast: $('toast'),
    version: $('version'),
  };

  const MIN_CADENCE = (RR.LIMITS && RR.LIMITS.MIN_CADENCE_SEC) || 30;
  const MAX_SCANS = (RR.LIMITS && RR.LIMITS.MAX_SCANS_KEPT) || 20000;
  const MIN_REVIEW_CADENCE = (RR.LIMITS && RR.LIMITS.MIN_REVIEW_CADENCE_MIN) || 15;
  const MAX_PAGES = (RR.LIMITS && RR.LIMITS.MAX_PAGES_PER_KEYWORD) || 3;
  const DEF = (RR.DEFAULTS) || {};

  // Clamp a value into [lo, hi], falling back to def when not a finite number.
  function clamp(value, lo, hi, def) {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = def;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  // Split a textarea value into a clean string[] — accepts newline, comma, or
  // semicolon separators (also tolerates Windows \r). Forgiving so manual
  // multi-keyword entry "just works" however the user separates terms.
  function toList(text) {
    return String(text || '')
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Live count of distinct keywords entered — immediate feedback that
  // multi-keyword entry is being recognized.
  function updateKwCount() {
    if (!el.kwcount) return;
    const n = dedupe(toList(el.keywords.value)).length;
    el.kwcount.textContent = n === 0 ? 'No keywords yet' : n + (n === 1 ? ' keyword' : ' keywords');
  }

  // De-dupe case-insensitively while preserving first-seen casing/order.
  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const k = item.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('toast-err', !!isErr);
    el.toast.hidden = false;
    // Force reflow so the transition runs even on rapid repeat calls.
    void el.toast.offsetWidth;
    el.toast.setAttribute('data-show', '1');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.removeAttribute('data-show');
      setTimeout(() => { el.toast.hidden = true; }, 220);
    }, 2200);
  }

  function showError(msg) {
    el.err.textContent = msg;
    el.err.hidden = false;
  }
  function clearError() {
    el.err.textContent = '';
    el.err.hidden = true;
  }

  // Populate the form from stored config.
  async function load() {
    const cfg = await RR.storage.getConfig();
    el.keywords.value = (cfg.keywords || []).join('\n');
    updateKwCount();
    el.myBrands.value = (cfg.myBrands || []).join('\n');
    el.excludeBrands.value = (cfg.excludeBrands || []).join('\n');
    el.amazon.checked = !!(cfg.marketplaces && cfg.marketplaces.amazon);
    el.flipkart.checked = !!(cfg.marketplaces && cfg.marketplaces.flipkart);
    el.cadenceSec.value = cfg.cadenceSec;
    el.maxScansKept.value = cfg.maxScansKept;
    el.pagesPerKeyword.value = cfg.pagesPerKeyword;
    el.reviewsEnabled.checked = cfg.reviewsEnabled !== false;
    el.reviewCadenceMin.value = cfg.reviewCadenceMin;
    el.reviewsPerProduct.value = cfg.reviewsPerProduct;
    el.productsPerReviewCycle.value = cfg.productsPerReviewCycle;
    if (el.version) el.version.textContent = 'v' + (RR.VERSION || '1.0.0');
  }

  // Validate + build a config patch. Returns {patch} or {error}.
  function collect() {
    const keywords = dedupe(toList(el.keywords.value));
    const myBrands = dedupe(toList(el.myBrands.value));
    const excludeBrands = dedupe(toList(el.excludeBrands.value));

    if (!keywords.length) {
      return { error: 'Add at least one keyword to track.' };
    }
    if (!el.amazon.checked && !el.flipkart.checked) {
      return { error: 'Select at least one marketplace.' };
    }

    let cadence = Math.round(Number(el.cadenceSec.value));
    if (!Number.isFinite(cadence) || cadence < MIN_CADENCE) {
      return { error: 'Scan cadence must be at least ' + MIN_CADENCE + ' seconds (minimum 30s).' };
    }

    let maxKept = Math.round(Number(el.maxScansKept.value));
    if (!Number.isFinite(maxKept) || maxKept < 50) {
      return { error: 'Max scans kept must be 50 or more.' };
    }
    if (maxKept > MAX_SCANS) maxKept = MAX_SCANS;

    // Pages per keyword — clamp 1..MAX_PAGES (3).
    const pagesPerKeyword = clamp(el.pagesPerKeyword.value, 1, MAX_PAGES, DEF.pagesPerKeyword || 2);

    // Review-harvest settings: clamp to the same ranges storage normalization uses.
    const reviewsEnabled = !!el.reviewsEnabled.checked;
    const reviewCadenceMin = clamp(el.reviewCadenceMin.value, MIN_REVIEW_CADENCE, 100000, DEF.reviewCadenceMin || 60);
    const reviewsPerProduct = clamp(el.reviewsPerProduct.value, 1, 50, DEF.reviewsPerProduct || 5);
    const productsPerReviewCycle = clamp(el.productsPerReviewCycle.value, 1, 30, DEF.productsPerReviewCycle || 6);

    return {
      patch: {
        keywords,
        myBrands,
        excludeBrands,
        marketplaces: { amazon: el.amazon.checked, flipkart: el.flipkart.checked },
        cadenceSec: cadence,
        maxScansKept: maxKept,
        pagesPerKeyword,
        reviewsEnabled,
        reviewCadenceMin,
        reviewsPerProduct,
        productsPerReviewCycle,
      },
    };
  }

  async function onSave(e) {
    e.preventDefault();
    clearError();
    const res = collect();
    if (res.error) {
      showError(res.error);
      toast('Could not save', true);
      return;
    }
    el.save.disabled = true;
    try {
      await RR.storage.saveConfig(res.patch);
      await load(); // reflect any normalization the storage layer applied
      toast('Saved');
    } catch (err) {
      showError('Save failed: ' + (err && err.message ? err.message : String(err)));
      toast('Save failed', true);
    } finally {
      el.save.disabled = false;
    }
  }

  async function onClearScans() {
    if (!confirm('Delete all recorded scan data? This cannot be undone.')) return;
    el.clearScans.disabled = true;
    try {
      await RR.storage.clearScans();
      toast('Scan data cleared');
    } catch (err) {
      toast('Could not clear scans', true);
    } finally {
      el.clearScans.disabled = false;
    }
  }

  async function onClearReviews() {
    if (!confirm('Delete all harvested competitor review data? This cannot be undone.')) return;
    el.clearReviews.disabled = true;
    try {
      await RR.storage.clearReviews();
      toast('Review data cleared');
    } catch (err) {
      toast('Could not clear reviews', true);
    } finally {
      el.clearReviews.disabled = false;
    }
  }

  async function onClearLog() {
    if (!confirm('Clear the activity log?')) return;
    el.clearLog.disabled = true;
    try {
      await RR.storage.clearLog();
      toast('Activity log cleared');
    } catch (err) {
      toast('Could not clear log', true);
    } finally {
      el.clearLog.disabled = false;
    }
  }

  // Header cells to skip when a sheet's first cell is an obvious column title.
  const HEADER_CELLS = new Set(['keyword', 'keywords', 'search term', 'search terms']);

  // Parse an uploaded sheet's raw text into a keyword list. Rows split on
  // newlines; each row split on comma / tab / semicolon; non-empty trimmed
  // cells collected. A leading header cell ('keyword(s)'/'search term(s)') is
  // skipped. Case-insensitive de-dupe is applied on merge, not here.
  function parseSheet(text) {
    const rows = String(text || '').split(/\r\n|\r|\n/);
    const out = [];
    let checkedHeader = false;
    for (const row of rows) {
      const cells = row.split(/[,\t;]/);
      for (const raw of cells) {
        const cell = raw.trim();
        if (!cell) continue;
        // Skip a single header cell the first time we see any content.
        if (!checkedHeader) {
          checkedHeader = true;
          if (HEADER_CELLS.has(cell.toLowerCase())) continue;
        }
        out.push(cell);
      }
    }
    return out;
  }

  // Merge parsed keywords into the textarea: append only ones not already
  // present (case-insensitive), one per line, then refresh the live counter.
  function mergeKeywords(incoming) {
    const existing = toList(el.keywords.value);
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    let added = 0;
    for (const kw of incoming) {
      const k = kw.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      existing.push(kw);
      added++;
    }
    el.keywords.value = existing.join('\n');
    updateKwCount();
    return added;
  }

  function onSheetChange(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    // .xlsx is a binary zip we can't parse client-side without a lib — guide out.
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      toast('Excel files aren’t supported — export as CSV, then upload.', true);
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseSheet(reader.result);
      if (!parsed.length) {
        toast('No keywords found in that file', true);
        input.value = '';
        return;
      }
      const added = mergeKeywords(parsed);
      clearError();
      toast(added ? added + (added === 1 ? ' keyword added' : ' keywords added') : 'No new keywords to add');
      input.value = ''; // allow re-uploading the same file
    };
    reader.onerror = () => {
      toast('Could not read that file', true);
      input.value = '';
    };
    reader.readAsText(file);
  }

  function wire() {
    el.form.addEventListener('submit', onSave);
    el.uploadSheetBtn.addEventListener('click', () => el.sheetInput.click());
    el.sheetInput.addEventListener('change', onSheetChange);
    el.clearScans.addEventListener('click', onClearScans);
    el.clearReviews.addEventListener('click', onClearReviews);
    el.clearLog.addEventListener('click', onClearLog);
    // Clear the inline error as soon as the user starts fixing input.
    [el.keywords, el.myBrands, el.excludeBrands, el.cadenceSec, el.maxScansKept,
      el.pagesPerKeyword, el.reviewCadenceMin, el.reviewsPerProduct, el.productsPerReviewCycle]
      .forEach((node) => node.addEventListener('input', clearError));
    [el.amazon, el.flipkart, el.reviewsEnabled].forEach((node) => node.addEventListener('change', clearError));
    // Live keyword counter feedback as the user types.
    el.keywords.addEventListener('input', updateKwCount);
  }

  function init() {
    wire();
    load().catch((err) => showError('Could not load settings: ' + (err && err.message ? err.message : String(err))));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
