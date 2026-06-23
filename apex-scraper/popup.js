// Apex Scraper UI Controller
let links = [];
let scrapedData = [];
let activeAnchorBrand = 'Sleepwell';

// Safe mock wrapper for non-extension standalone environments
if (typeof chrome === 'undefined') {
  window.chrome = {};
}
if (!chrome.runtime) {
  chrome.runtime = {
    sendMessage: function(message, callback) {
      console.log('[Mock chrome.runtime.sendMessage]', message);
      setTimeout(() => {
        if (message.action === 'get_results') {
          const localResults = JSON.parse(localStorage.getItem('sleepwell_scraped_results') || '[]');
          if (callback) callback({ results: localResults });
        } else if (message.action === 'get_state') {
          const localQueue = JSON.parse(localStorage.getItem('sleepwell_queue') || '[]');
          const localIndex = parseInt(localStorage.getItem('sleepwell_currentIndex') || '0', 10);
          const isScraping = localStorage.getItem('sleepwell_isScraping') === 'true';
          const selfHealed = parseInt(localStorage.getItem('sleepwell_store_selfHealedCount') || '0', 10);
          if (callback) callback({
            isScraping: isScraping,
            isPaused: false,
            processed: localIndex,
            total: localQueue.length,
            selfHealedCount: selfHealed
          });
        } else if (message.action === 'start_scraping') {
          localStorage.setItem('sleepwell_queue', JSON.stringify(message.links));
          localStorage.setItem('sleepwell_currentIndex', '0');
          localStorage.setItem('sleepwell_isScraping', 'true');
          runSimulatedBrowserScrape(message.links, message.concurrency, message.delay);
          if (callback) callback({ status: 'started' });
        } else if (message.action === 'stop_scraping') {
          localStorage.setItem('sleepwell_isScraping', 'false');
          if (callback) callback({ status: 'stopped' });
        } else if (message.action === 'pause_scraping') {
          localStorage.setItem('sleepwell_isScraping', 'false');
          if (callback) callback({ status: 'paused' });
        } else if (message.action === 'resume_scraping') {
          localStorage.setItem('sleepwell_isScraping', 'true');
          const localQueue = JSON.parse(localStorage.getItem('sleepwell_queue') || '[]');
          const localIndex = parseInt(localStorage.getItem('sleepwell_currentIndex') || '0', 10);
          runSimulatedBrowserScrape(localQueue, 3, 1000, localIndex);
          if (callback) callback({ status: 'resumed' });
        } else {
          if (callback) callback(null);
        }
      }, 10);
    },
    onMessage: {
      addListener: function(listener) {
        window.mockMessageListener = listener;
      }
    }
  };
}
if (!chrome.storage) {
  chrome.storage = {
    local: {
      get: function(keys, callback) {
        const res = {};
        const keysList = Array.isArray(keys) ? keys : [keys];
        keysList.forEach(k => {
          res[k] = JSON.parse(localStorage.getItem('sleepwell_store_' + k) || 'null');
        });
        if (callback) callback(res);
      },
      set: function(payload, callback) {
        Object.keys(payload).forEach(k => {
          localStorage.setItem('sleepwell_store_' + k, JSON.stringify(payload[k]));
        });
        if (callback) callback();
      },
      remove: function(keys, callback) {
        const keysList = Array.isArray(keys) ? keys : [keys];
        keysList.forEach(k => {
          localStorage.removeItem('sleepwell_store_' + k);
        });
        if (callback) callback();
      },
      clear: function(callback) {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sleepwell_')) {
            localStorage.removeItem(key);
          }
        }
        if (callback) callback();
      }
    }
  };
}
if (!chrome.downloads) {
  chrome.downloads = {
    download: function(options, callback) {
      console.log('[Mock chrome.downloads.download]', options);
      const a = document.createElement('a');
      a.href = options.url;
      a.download = options.filename || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (callback) callback();
    }
  };
}

function runSimulatedBrowserScrape(linksList, concurrency, delay, resumeIndex = 0) {
  // INTEGRITY: standalone browser mode cannot fetch marketplace pages (CORS) and
  // this tool NEVER fabricates product data. Scraping requires the extension context.
  localStorage.setItem('sleepwell_isScraping', 'false');
  appendLog('Standalone page mode cannot scrape live marketplaces. Load this folder via chrome://extensions → "Load unpacked", then open the dashboard from the extension icon.', 'error');
  if (window.mockMessageListener) {
    window.mockMessageListener({
      action: 'progress_update',
      processed: 0, total: linksList.length, isComplete: false
    });
  }
}

function getMockDataBrowser(url) {
  // Mock data generation removed in v6 — the scraper only reports real extracted data.
  return {
    url: url,
    status: 'failed',
    failReason: 'Standalone mode cannot scrape. Load as a Chrome extension (chrome://extensions → Load unpacked).'
  };
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSliders();
  initControlDeck();
  initSqlConsole();
  restoreRunningState();
});

// ==========================================
// TABS NAVIGATION CONTROLLER
// ==========================================
function initTabs() {
  const tabs = document.querySelectorAll('.nav-sidebar .nav-tab-btn');
  const panes = document.querySelectorAll('.content-frame .tab-pane');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      const targetPane = document.getElementById(target);
      if (targetPane) targetPane.classList.add('active');

      appendLog(`Switched tab context to: ${tab.querySelector('.tab-title').innerText}`, 'info');
    });
  });
}

// ==========================================
// SPEED & THREAD SLIDERS
// ==========================================
function initSliders() {
  const concurrencyRange = document.getElementById('concurrencyRange');
  const concurrencyLabel = document.getElementById('concurrencyLabel');
  concurrencyRange.addEventListener('input', (e) => {
    concurrencyLabel.innerText = `${e.target.value} Workers`;
  });

  const delayRange = document.getElementById('delayRange');
  const delayLabel = document.getElementById('delayLabel');
  delayRange.addEventListener('input', (e) => {
    delayLabel.innerText = `${parseFloat(e.target.value).toFixed(1)}s`;
  });
}

// ==========================================
// LAYER 1: CONTROL DECK & FILE ACTIONS
// ==========================================
function initControlDeck() {
  const csvFileInput = document.getElementById('csvFileInput');
  const customFileBtn = document.getElementById('customFileBtn');
  const csvFileName = document.getElementById('csvFileName');
  const launchJobBtn = document.getElementById('launchJobBtn');
  const downloadScrapedExcelBtn = document.getElementById('downloadScrapedExcelBtn');

  customFileBtn.addEventListener('click', () => csvFileInput.click());

  csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    csvFileName.innerText = file.name;
    appendLog(`Reading uploaded CSV file: ${file.name}`, 'info');

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target.result;
      const parsedLinks = parseCsvLinks(text);
      
      if (parsedLinks.length > 0) {
        links = parsedLinks;
        document.getElementById('progressStatusLabel').innerText = `Loaded ${links.length} URLs. Ready to run scrape jobs.`;
        document.getElementById('metricTotalLinks').innerText = links.length;
        document.getElementById('metricProcessed').innerText = '0';
        launchJobBtn.disabled = false;
        appendLog(`Successfully loaded ${links.length} products from CSV file.`, 'success');
      } else {
        document.getElementById('progressStatusLabel').innerText = 'No valid links or product IDs detected in file.';
        launchJobBtn.disabled = true;
        appendLog('Failed to find valid product links or ASIN/FSN in CSV.', 'error');
      }
    };
    reader.readAsText(file);
  });

  // Sample URL loaders — load REAL marketplace links into the queue (no pre-generated data)
  document.getElementById('seedMattressBtn').addEventListener('click', () => {
    links = [
      'https://www.amazon.in/dp/B08R9YMQC1',
      'https://www.amazon.in/dp/B099S871TD',
      'https://www.amazon.in/dp/B08R9Y89VN',
      'https://www.amazon.in/dp/B00RAEVVCK',
      'https://www.flipkart.com/sleepwell-pro-nexa-supportec-technology-mattress-5-inch-king-high-resilience-ht-foam/p/itm921aff39ed4bd',
      'https://www.flipkart.com/duroflex-livein-3-zoned-orthopedic-6-inch-king-memory-foam-mattress/p/itmf42d6033c0937'
    ];
    document.getElementById('progressStatusLabel').innerText = `Loaded ${links.length} sample mattress URLs. Click Launch to scrape them live.`;
    document.getElementById('metricTotalLinks').innerText = links.length;
    document.getElementById('metricProcessed').innerText = '0';
    launchJobBtn.disabled = false;
    appendLog(`Loaded ${links.length} sample mattress URLs into the queue. These will be scraped LIVE — no canned data.`, 'info');
  });

  document.getElementById('seedProtectorBtn').addEventListener('click', () => {
    links = [
      'https://www.amazon.in/dp/B073Q9ZJF4',
      'https://www.amazon.in/dp/B0863TWUKD'
    ];
    document.getElementById('progressStatusLabel').innerText = `Loaded ${links.length} sample protector URLs. Click Launch to scrape them live.`;
    document.getElementById('metricTotalLinks').innerText = links.length;
    document.getElementById('metricProcessed').innerText = '0';
    launchJobBtn.disabled = false;
    appendLog(`Loaded ${links.length} sample protector URLs into the queue. These will be scraped LIVE — no canned data.`, 'info');
  });

  // Wipe scrapes
  document.getElementById('clearDatabaseBtn').addEventListener('click', () => {
    chrome.storage.local.clear(() => {
      links = [];
      scrapedData = [];
      document.getElementById('progressStatusLabel').innerText = 'Database cleared. Awaiting configurations...';
      document.getElementById('metricTotalLinks').innerText = '0';
      document.getElementById('metricProcessed').innerText = '0';
      document.getElementById('metricSelfHealed').innerText = '0';
      document.getElementById('progressFillBar').style.width = '0%';
      document.getElementById('progressPercentage').innerText = '0%';
      downloadScrapedExcelBtn.disabled = true;
      launchJobBtn.disabled = true;
      launchJobBtn.classList.remove('hidden');
      document.getElementById('jobControlsWrapper').classList.add('hidden');
      appendLog('Wiped local storage and cleared all scraped data tables.', 'warning');
    });
  });

  // Launch scraper job
  launchJobBtn.addEventListener('click', () => {
    const concurrency = parseInt(concurrencyRange.value, 10) || 3;
    const delay = parseFloat(delayRange.value) * 1000 || 1000;

    chrome.runtime.sendMessage({
      action: 'start_scraping',
      links: links,
      concurrency: concurrency,
      delay: delay
    });

    launchJobBtn.classList.add('hidden');
    document.getElementById('jobControlsWrapper').classList.remove('hidden');
    document.getElementById('pauseJobBtn').classList.remove('hidden');
    document.getElementById('resumeJobBtn').classList.add('hidden');
    document.getElementById('metricEngineState').innerText = 'Active';
    document.getElementById('metricEngineState').className = 'm-val state-running';
    downloadScrapedExcelBtn.disabled = true;
    appendLog(`Starting parallel crawler job. Speed limit: 1 link per ${delay/1000} second.`, 'info');
  });

  // Pause job
  document.getElementById('pauseJobBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'pause_scraping' }, () => {
      document.getElementById('pauseJobBtn').classList.add('hidden');
      document.getElementById('resumeJobBtn').classList.remove('hidden');
      document.getElementById('metricEngineState').innerText = 'Paused';
      document.getElementById('metricEngineState').className = 'm-val info-purple';
      downloadScrapedExcelBtn.disabled = false;
      appendLog('Scraper queue paused. Partial data ready for export/viewing.', 'warning');
    });
  });

  // Resume job
  document.getElementById('resumeJobBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'resume_scraping' }, () => {
      document.getElementById('resumeJobBtn').classList.add('hidden');
      document.getElementById('pauseJobBtn').classList.remove('hidden');
      document.getElementById('metricEngineState').innerText = 'Active';
      document.getElementById('metricEngineState').className = 'm-val state-running';
      downloadScrapedExcelBtn.disabled = true;
      appendLog('Scraper queue resumed.', 'info');
    });
  });

  // Stop job
  document.getElementById('stopJobBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stop_scraping' }, () => {
      resetControlsUI();
      appendLog('Scraper queue stopped. Unlocking workbook compilers.', 'warning');
    });
  });

  // Download Excel
  downloadScrapedExcelBtn.addEventListener('click', () => {
    downloadScrapedExcelBtn.disabled = true;
    downloadScrapedExcelBtn.innerText = '⌛ Compiling Workbook...';
    
    const allResults = [];
    processScrapedDataInChunks((chunk) => {
      allResults.push(...chunk);
    }).then(() => {
      if (allResults.length > 0) {
        exportScrapedExcel(allResults);
      } else {
        appendLog('No scraped data available to download.', 'warning');
      }
      downloadScrapedExcelBtn.disabled = false;
      downloadScrapedExcelBtn.innerText = '🏆 Export Scraped Matrix (.xlsx)';
    });
  });

  // Download template CSV
  document.getElementById('downloadCsvTemplateBtn').addEventListener('click', () => {
    const csvContent = [
      'URL',
      'https://www.amazon.in/dp/B08R9YMQC1',
      'https://www.amazon.in/dp/B099S871TD',
      'https://www.flipkart.com/sleepwell-pro-nexa-supportec-technology-mattress-5-inch-king-high-resilience-ht-foam/p/itm921aff39ed4bd'
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url: url,
      filename: 'apex_scraper_input_template.csv',
      saveAs: true
    });
    appendLog('Downloaded CSV upload format template.', 'info');
  });

  document.getElementById('clearLogsBtn').addEventListener('click', () => {
    document.getElementById('logsTerminalArea').innerHTML = '';
  });
}

function parseCsvLinks(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const links = [];
  for (const line of lines) {
    if (line.toLowerCase() === 'url' || line.toLowerCase().includes('http') === false) continue;
    const cleanUrl = line.split(',')[0].trim();
    if (cleanUrl.startsWith('http')) {
      links.push(cleanUrl);
    }
  }
  return links;
}

function resetControlsUI() {
  document.getElementById('jobControlsWrapper').classList.add('hidden');
  launchJobBtn.classList.remove('hidden');
  document.getElementById('metricEngineState').innerText = 'Idle';
  document.getElementById('metricEngineState').className = 'm-val state-idle';
  document.getElementById('downloadScrapedExcelBtn').disabled = false;
}

// ==========================================
// LOGGER ACTIVITY PRUNING
// ==========================================
function appendLog(message, type = 'info') {
  const logsTerminalArea = document.getElementById('logsTerminalArea');
  if (!logsTerminalArea) return;

  const time = new Date().toLocaleTimeString();
  const row = document.createElement('div');
  row.className = `terminal-row ${type}`;
  row.innerText = `[${time}] ${message}`;

  logsTerminalArea.appendChild(row);

  while (logsTerminalArea.children.length > 200) {
    logsTerminalArea.firstElementChild.remove();
  }

  logsTerminalArea.scrollTop = logsTerminalArea.scrollHeight;
}

// ==========================================
// BACKGROUND MESSAGE RECEIVER
// ==========================================
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'log') {
    let logType = 'info';
    const msg = request.message;
    if (msg.includes('✅')) logType = 'success';
    else if (msg.includes('⚠️')) logType = 'warning';
    else if (msg.includes('❌') || msg.includes('Error')) logType = 'error';
    
    appendLog(msg, logType);
  }
  else if (request.action === 'progress_update') {
    const { processed, total, isComplete, selfHealedCount } = request;
    document.getElementById('metricProcessed').innerText = processed;
    document.getElementById('metricSelfHealed').innerText = selfHealedCount || 0;
    
    const percentage = Math.min(100, Math.round((processed / total) * 100)) || 0;
    document.getElementById('progressFillBar').style.width = `${percentage}%`;
    document.getElementById('progressPercentage').innerText = `${percentage}%`;

    if (isComplete) {
      const fc = request.failedCount || 0;
      document.getElementById('progressStatusLabel').innerText = fc > 0
        ? `Job complete: ${processed - fc} captured, ${fc} failed (exported on the Failed sheet — never fabricated).`
        : 'Scraping job completed — all URLs captured successfully!';
      resetControlsUI();
      appendLog('Scraping queue processed fully. Data compiled successfully.', 'success');
      document.getElementById('downloadScrapedExcelBtn').disabled = false;
    }
  }
});

function restoreRunningState() {
  chrome.runtime.sendMessage({ action: 'get_state' }, (response) => {
    if (response) {
      const { isScraping, isPaused, processed, total, selfHealedCount } = response;
      document.getElementById('metricSelfHealed').innerText = selfHealedCount || 0;
      
      if (total > 0) {
        document.getElementById('metricTotalLinks').innerText = total;
        document.getElementById('metricProcessed').innerText = processed;
        
        const percentage = Math.min(100, Math.round((processed / total) * 100)) || 0;
        document.getElementById('progressFillBar').style.width = `${percentage}%`;
        document.getElementById('progressPercentage').innerText = `${percentage}%`;

        if (processed > 0) {
          document.getElementById('downloadScrapedExcelBtn').disabled = false;
        }

        if (isScraping && !isPaused) {
          launchJobBtn.classList.add('hidden');
          document.getElementById('jobControlsWrapper').classList.remove('hidden');
          document.getElementById('metricEngineState').innerText = 'Active';
          document.getElementById('metricEngineState').className = 'm-val state-running';
        } else if (isPaused) {
          launchJobBtn.classList.add('hidden');
          document.getElementById('jobControlsWrapper').classList.remove('hidden');
          document.getElementById('pauseJobBtn').classList.add('hidden');
          document.getElementById('resumeJobBtn').classList.remove('hidden');
          document.getElementById('metricEngineState').innerText = 'Paused';
          document.getElementById('metricEngineState').className = 'm-val info-purple';
        }
      }
    }
  });

  // Directly check if there is data in storage
  chrome.storage.local.get(['totalSavedResultsCount', 'resultsBuffer'], (data) => {
    const totalCount = (data.totalSavedResultsCount || 0) + (data.resultsBuffer || []).length;
    if (totalCount > 0) {
      document.getElementById('downloadScrapedExcelBtn').disabled = false;
    }
  });
}

// ==========================================
// EXCEL EXPORTER WITH CHUNK SPLITS
// ==========================================
function exportScrapedExcel(results) {
  try {
    const splitSizeLimit = parseInt(document.getElementById('splitExporterSelect').value, 10) || 0;
    appendLog('Compiling Excel workbook report via SheetJS offline mini compiler...', 'info');

    if (splitSizeLimit > 0 && results.length > splitSizeLimit) {
      appendLog(`Large-scale queue size detected (${results.length} rows). Splitting compile sizes in chunks of ${splitSizeLimit} to bypass Heap limit.`, 'warning');
      let part = 1;
      for (let i = 0; i < results.length; i += splitSizeLimit) {
        const slice = results.slice(i, i + splitSizeLimit);
        const name = `apex_scraped_report_part${part}_rows_${i+1}-${Math.min(results.length, i + splitSizeLimit)}`;
        generateWorkbookDownload(slice, name);
        part++;
      }
      appendLog(`Successfully exported ${part - 1} separate split Excel reports.`, 'success');
    } else {
      generateWorkbookDownload(results, `apex_scraped_report_${Date.now()}`);
      appendLog(`Successfully compiled and exported product audit workbook!`, 'success');
    }
  } catch (err) {
    console.error('Excel generation error:', err);
    appendLog(`Excel Compiler Failure: ${err.message}`, 'error');
  }
}

function generateWorkbookDownload(dataSet, baseName) {
  const okRows = dataSet.filter(r => r.status === 'ok' || r.status === 'partial' || (!r.status && r.title));
  const failedRows = dataSet.filter(r => r.status === 'failed' || r.status === 'blocked');

  // "Consolidated Data" format: 31 export columns (A–AE) + 24 auto-derived
  // columns (AF–BC), computed in-browser by ApexEnrich so the workbook is ready
  // to drop straight into the dashboard with no manual paste/recalculation.
  const productRows = okRows.map(r => {
    const e = (typeof ApexEnrich !== 'undefined') ? ApexEnrich.enrich(r) : {};
    return {
      // ---- A–AE: the original 31 export columns (unchanged) ----
      'Scrape Date': r.scrapeDate || '',
      'Platform': r.platform || '',
      'Product ID (ASIN/FSN)': r.productId || r.sku || '',
      'URL/Link': r.url,
      'Brand Name': r.brand || '',
      'Product Title': r.title || '',
      'Currency': r.currency || '',
      'Active Price': r.price !== '' && r.price != null ? parseFloat(r.price) : '',
      'MRP Value': r.mrp !== '' && r.mrp != null ? parseFloat(r.mrp) : '',
      'Discount %': r.discount !== '' && r.discount != null ? parseFloat(r.discount) : '',
      'Star Rating': r.rating !== '' && r.rating != null ? parseFloat(r.rating) : '',
      'Reviews Count': r.reviewCount !== '' && r.reviewCount != null ? parseFloat(r.reviewCount) : '',
      'Availability': r.availability || '',
      'EMI Price': r.emiPrice !== '' && r.emiPrice != null ? parseFloat(r.emiPrice) : '',
      'Coupon': r.couponName || '',
      'Bank/Card Offer': r.bankOfferType || '',
      'All Offers': Array.isArray(r.expandedCardOffers) ? r.expandedCardOffers.join(' | ') : '',
      'Warranty Duration': r.warranty || '',
      'Assured/Prime': r.assured || r.flipkartAssured || '',
      'Return Window (Days)': r.returnDays !== '' && r.returnDays != null ? parseFloat(r.returnDays) : '',
      'Estimated Delivery': r.deliveryBy || '',
      'Seller / Fulfilled By': r.fulfilledBy || '',
      'Seller Rating': r.sellerRating || '',
      'Bestseller Rank': r.bestsellerRank || '',
      'Category Breadcrumb': r.category || '',
      'Image URL': r.image || '',
      'SEO Top Keywords': r.topKeywords || '',
      'Extraction Sources': Array.isArray(r.extractionSources) ? r.extractionSources.join(', ') : '',
      'Self-Heal Corrections': Array.isArray(r.corrections_made) ? r.corrections_made.join(' | ') : '',
      'Record Status': r.status || 'ok',
      'Scraped Timestamp': r.scrapeTime || '',
      // ---- AF–BC: auto-derived enrichment columns ----
      'Scraped Date': e.scrapedDate,
      'Scraped Time': e.scrapedTime,
      'Brand (Std)': e.brandStd,
      'Product Type': e.productType,
      'Mattress Size': e.mattressSize,
      'Thickness (in)': e.thickness,
      'In-Stock Flag': e.inStockFlag,
      'Prime/Assured Flag': e.primeAssuredFlag,
      'Effective Price': e.effectivePrice,
      'Dimensions (LxBxH in)': e.dimensions,
      'Wow/Best Price (Hist)': e.wowBestPrice,
      '_DimToken': e.dimToken,
      'Length (in)': e.length,
      'Breadth (in)': e.breadth,
      'Height (in)': e.height,
      'Dimension Basis': e.dimensionBasis,
      'Type Confidence': e.typeConfidence,
      '_TypeV': e.productType,
      '_SizeV': e.mattressSize,
      '_LV': e.length,
      '_BV': e.breadth,
      '_HV': e.height,
      '_BasisV': e.dimensionBasis,
      '_TConfV': e.typeConfidence
    };
  });

  // Fixed 55-column order matching the dashboard's "Consolidated Data" worksheet.
  const CONSOLIDATED_HEADERS = [
    'Scrape Date', 'Platform', 'Product ID (ASIN/FSN)', 'URL/Link', 'Brand Name',
    'Product Title', 'Currency', 'Active Price', 'MRP Value', 'Discount %',
    'Star Rating', 'Reviews Count', 'Availability', 'EMI Price', 'Coupon',
    'Bank/Card Offer', 'All Offers', 'Warranty Duration', 'Assured/Prime',
    'Return Window (Days)', 'Estimated Delivery', 'Seller / Fulfilled By',
    'Seller Rating', 'Bestseller Rank', 'Category Breadcrumb', 'Image URL',
    'SEO Top Keywords', 'Extraction Sources', 'Self-Heal Corrections',
    'Record Status', 'Scraped Timestamp', 'Scraped Date', 'Scraped Time',
    'Brand (Std)', 'Product Type', 'Mattress Size', 'Thickness (in)',
    'In-Stock Flag', 'Prime/Assured Flag', 'Effective Price',
    'Dimensions (LxBxH in)', 'Wow/Best Price (Hist)', '_DimToken', 'Length (in)',
    'Breadth (in)', 'Height (in)', 'Dimension Basis', 'Type Confidence',
    '_TypeV', '_SizeV', '_LV', '_BV', '_HV', '_BasisV', '_TConfV'
  ];

  const failureRows = failedRows.map(r => ({
    'URL/Link': r.url,
    'Platform': r.platform || '',
    'Status': r.status,
    'Failure Reason': r.failReason || '',
    'Scraped Timestamp': r.scrapeTime || ''
  }));

  // -------- Backtest / field coverage audit (real numbers, computed from the run) --------
  const coverageFields = ['brand', 'title', 'price', 'mrp', 'discount', 'rating', 'reviewCount', 'deliveryBy', 'fulfilledBy', 'warranty', 'returnDays'];
  const coverageRows = coverageFields.map(f => {
    const filled = okRows.filter(r => r[f] !== '' && r[f] != null).length;
    return {
      'Field': f,
      'Captured Rows': filled,
      'Coverage %': okRows.length ? Math.round((filled / okRows.length) * 100) : 0
    };
  });

  let anchorCount = 0, competitorCount = 0, sumPrice = 0, priced = 0;
  okRows.forEach(r => {
    if ((r.brand || '').toLowerCase().includes(activeAnchorBrand.toLowerCase())) anchorCount++;
    else competitorCount++;
    const p = parseFloat(r.price);
    if (!isNaN(p) && p > 0) { sumPrice += p; priced++; }
  });

  const summaryRows = [
    { 'Metrics Analysis': 'Total URLs in this export', 'Value': dataSet.length },
    { 'Metrics Analysis': 'Successfully scraped (ok/partial)', 'Value': okRows.length },
    { 'Metrics Analysis': 'Failed / blocked (see Failed sheet)', 'Value': failedRows.length },
    { 'Metrics Analysis': 'Success Rate %', 'Value': dataSet.length ? Math.round((okRows.length / dataSet.length) * 100) : 0 },
    { 'Metrics Analysis': `${activeAnchorBrand} Brand Count`, 'Value': anchorCount },
    { 'Metrics Analysis': 'Competitor Listings Count', 'Value': competitorCount },
    { 'Metrics Analysis': 'Average Active Selling Price (priced rows only)', 'Value': priced ? Math.round(sumPrice / priced) : 0 }
  ];

  const wb = XLSX.utils.book_new();

  // Primary deliverable: the "Consolidated Data" sheet in the exact 55-column
  // order, with all derived columns auto-filled (header order forced so even
  // all-empty derived cells keep their column position).
  const consolidatedWs = XLSX.utils.json_to_sheet(productRows, {
    header: CONSOLIDATED_HEADERS,
    cellDates: true
  });
  XLSX.utils.sheet_add_aoa(consolidatedWs, [CONSOLIDATED_HEADERS], { origin: 'A1' });
  XLSX.utils.book_append_sheet(wb, consolidatedWs, "Consolidated Data");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary Audit");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(coverageRows), "Field Coverage Backtest");
  if (failureRows.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(failureRows), "Failed URLs");
  }
  XLSX.writeFile(wb, `${baseName}.xlsx`);
}

// ==========================================
// SQL INTERACTIVE RUNNER
// ==========================================
// Load all scraped data from storage in small chunks, calling callback for each chunk.
// This prevents high RAM spike and browser freezing.
async function processScrapedDataInChunks(chunkCallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['chunkIndex', 'resultsBuffer'], async (data) => {
      const totalChunks = data.chunkIndex || 0;
      const resultsBuffer = data.resultsBuffer || [];
      
      for (let i = 0; i < totalChunks; i++) {
        const key = `sleepwell_chunk_${i}`;
        const chunkData = await chrome.storage.local.get(key);
        const chunk = chunkData[key];
        if (Array.isArray(chunk) && chunk.length > 0) {
          chunkCallback(chunk);
        }
      }
      
      if (Array.isArray(resultsBuffer) && resultsBuffer.length > 0) {
        chunkCallback(resultsBuffer);
      }
      
      resolve();
    });
  });
}

function initSqlConsole() {
  const dropdown = document.getElementById('sqlQueryDropdown');
  const consoleArea = document.getElementById('sqlConsoleArea');
  const executeBtn = document.getElementById('executeSqlQueryBtn');
  const exportBtn = document.getElementById('exportSqlExcelBtn');

  dropdown.addEventListener('change', (e) => {
    consoleArea.value = e.target.value;
  });

  executeBtn.addEventListener('click', () => {
    const rawSql = consoleArea.value.trim();
    executeBtn.disabled = true;
    executeBtn.innerText = '⌛ Processing...';
    
    const allResults = [];
    processScrapedDataInChunks((chunk) => {
      allResults.push(...chunk);
    }).then(() => {
      scrapedData = allResults;
      executeSQL(rawSql);
      executeBtn.disabled = false;
      executeBtn.innerText = '⚡ Execute Query';
    });
  });

  exportBtn.addEventListener('click', () => {
    const rawSql = consoleArea.value.trim();
    exportBtn.disabled = true;
    exportBtn.innerText = '⌛ Exporting...';
    
    const allResults = [];
    processScrapedDataInChunks((chunk) => {
      allResults.push(...chunk);
    }).then(() => {
      scrapedData = allResults;
      exportSqlOutputToExcel(rawSql);
      exportBtn.disabled = false;
      exportBtn.innerText = '📥 Export Output to Excel';
    });
  });
}

function executeSQL(sqlString) {
  const feedback = document.getElementById('sqlQueryFeedback');
  const thHeader = document.getElementById('sqlResultsTableHeader');
  const tBody = document.getElementById('sqlResultsTableBody');
  
  const startTime = performance.now();

  if (scrapedData.length === 0) {
    feedback.innerText = 'Execution Failed: Scraped dataset is empty.';
    tBody.innerHTML = '<tr><td class="text-center muted">No scraping dataset available. Load preloaded mattresses or run a scrape job first.</td></tr>';
    return;
  }

  const queryableSet = scrapedData.map(item => {
    return {
      platform: item.platform || '',
      brand: item.brand || '',
      title: item.title || '',
      price: parseFloat(item.price) || 0,
      mrp: parseFloat(item.mrp) || 0,
      discount: parseFloat(item.discount) || 0,
      rating: parseFloat(item.rating) || 0,
      reviewCount: parseFloat(item.reviewCount) || 0,
      wowPrice: parseFloat(item.wowPrice) || 0,
      emiPrice: parseFloat(item.emiPrice) || 0,
      warranty: item.warranty || '',
      returnDays: parseFloat(item.returnDays) || 0,
      deliveryBy: item.deliveryBy || '',
      fulfilledBy: item.fulfilledBy || '',
      topKeywords: item.topKeywords || '',
      scrapeTime: item.scrapeTime || ''
    };
  });

  try {
    const output = runMiniSqlParser(sqlString, queryableSet);
    const endTime = performance.now();
    const elapsed = (endTime - startTime).toFixed(1);

    feedback.innerText = `Returned ${output.length} rows in ${elapsed}ms`;

    if (output.length === 0) {
      thHeader.innerHTML = '<tr><th>Query Output</th></tr>';
      tBody.innerHTML = '<tr><td class="text-center muted">Returned 0 rows. Check your query constraints.</td></tr>';
      return;
    }

    const keys = Object.keys(output[0]);
    let headersHtml = '<tr>';
    keys.forEach(k => {
      headersHtml += `<th>${k}</th>`;
    });
    headersHtml += '</tr>';
    thHeader.innerHTML = headersHtml;

    const renderLimit = 100;
    const renderCount = Math.min(output.length, renderLimit);

    let rowsHtml = '';
    for (let i = 0; i < renderCount; i++) {
      const row = output[i];
      rowsHtml += '<tr>';
      keys.forEach(k => {
        const val = row[k];
        let displayVal = val === null || val === undefined ? '' : val.toString();
        if (typeof val === 'number' && (k.toLowerCase().includes('price') || k.toLowerCase() === 'mrp')) {
          displayVal = `₹${val.toLocaleString()}`;
        }
        rowsHtml += `<td title="${displayVal}">${displayVal}</td>`;
      });
      rowsHtml += '</tr>';
    }
    tBody.innerHTML = rowsHtml;
    
    if (output.length > renderLimit) {
      feedback.innerText += ` (Showing first ${renderLimit} rows. Export output to see all)`;
    }
    appendLog(`SQL query executed successfully in ${elapsed}ms. Returned ${output.length} rows.`, 'success');
  } catch (err) {
    feedback.innerText = `Error: ${err.message}`;
    thHeader.innerHTML = '<tr><th style="color: #ff6b6b">Query Compile Error</th></tr>';
    tBody.innerHTML = `<tr><td class="muted"><pre style="font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all;">${err.message}</pre></td></tr>`;
    appendLog(`SQL Parse Exception: ${err.message}`, 'error');
  }
}

function runMiniSqlParser(sql, dataset) {
  let cleaned = sql.replace(/\s+/g, ' ').trim();
  if (cleaned.endsWith(';')) {
    cleaned = cleaned.slice(0, -1).trim();
  }
  const selectMatch = cleaned.match(/SELECT\s+(.+?)\s+FROM\s*\?/i);
  if (!selectMatch) throw new Error("Invalid SQL syntax. Query must start with 'SELECT [fields] FROM ?'");

  const fieldsPart = selectMatch[1].trim();
  
  let whereClause = null;
  const whereMatch = cleaned.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+GROUP\s+BY|$)/i);
  if (whereMatch) {
    whereClause = whereMatch[1].trim();
  }

  let groupByField = null;
  const groupMatch = cleaned.match(/GROUP\s+BY\s+(.+?)(?:\s+ORDER\s+BY|$)/i);
  if (groupMatch) {
    groupByField = groupMatch[1].trim();
  }

  let orderByField = null;
  let orderDirection = 'ASC';
  const orderMatch = cleaned.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
  if (orderMatch) {
    const parts = orderMatch[1].trim().split(' ');
    orderByField = parts[0].trim();
    if (parts[1] && parts[1].toUpperCase() === 'DESC') {
      orderDirection = 'DESC';
    }
  }

  let results = dataset;
  if (whereClause) {
    results = results.filter(row => evalWhereCondition(row, whereClause));
  }

  if (groupByField) {
    results = runGroupByAggregates(results, groupByField, fieldsPart);
  } else {
    results = projectFields(results, fieldsPart);
  }

  if (orderByField) {
    results.sort((a, b) => {
      let actualOrderByKey = orderByField;
      const lowerOrderKey = orderByField.toLowerCase();
      if (a) {
        Object.keys(a).forEach(k => {
          if (k.toLowerCase() === lowerOrderKey) {
            actualOrderByKey = k;
          }
        });
      }
      let valA = a[actualOrderByKey];
      let valB = b[actualOrderByKey];
      if (valA === undefined || valA === null) return 1;
      if (valB === undefined || valB === null) return -1;
      if (typeof valA === 'string') {
        return orderDirection === 'ASC' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return orderDirection === 'ASC' ? (valA - valB) : (valB - valA);
    });
  }

  return results;
}

function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const char = str[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let val = '';
      i++;
      while (i < str.length && str[i] !== quote) {
        if (str[i] === '\\') {
          i++;
        }
        val += str[i];
        i++;
      }
      i++;
      tokens.push({ type: 'STRING', value: val });
      continue;
    }
    if (/[0-9]/.test(char)) {
      let val = '';
      while (i < str.length && /[0-9\.]/.test(str[i])) {
        val += str[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: parseFloat(val) });
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'PAREN', value: char });
      i++;
      continue;
    }
    const twoChars = str.substring(i, i + 2);
    if (twoChars === '!=' || twoChars === '<>' || twoChars === '<=' || twoChars === '>=' || twoChars === '==') {
      tokens.push({ type: 'OPERATOR', value: twoChars === '<>' ? '!=' : twoChars });
      i += 2;
      continue;
    }
    if (twoChars === '&&' || twoChars === '||') {
      tokens.push({ type: 'OPERATOR', value: twoChars });
      i += 2;
      continue;
    }
    if ('+-*/=<>'.includes(char)) {
      tokens.push({ type: 'OPERATOR', value: char === '=' ? '==' : char });
      i++;
      continue;
    }
    if (/[a-zA-Z_$]/.test(char)) {
      let val = '';
      while (i < str.length && /[a-zA-Z0-9_$]/.test(str[i])) {
        val += str[i];
        i++;
      }
      const upperVal = val.toUpperCase();
      if (upperVal === 'AND') {
        tokens.push({ type: 'OPERATOR', value: '&&' });
      } else if (upperVal === 'OR') {
        tokens.push({ type: 'OPERATOR', value: '||' });
      } else if (upperVal === 'LIKE') {
        tokens.push({ type: 'OPERATOR', value: 'LIKE' });
      } else {
        tokens.push({ type: 'IDENTIFIER', value: val });
      }
      continue;
    }
    i++;
  }
  return tokens;
}

const PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, 'LIKE': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6
};

function shuntingYard(tokens) {
  const outputQueue = [];
  const operatorStack = [];
  
  tokens.forEach(token => {
    if (token.type === 'NUMBER' || token.type === 'STRING' || token.type === 'IDENTIFIER') {
      outputQueue.push(token);
    } else if (token.type === 'OPERATOR') {
      const op = token.value;
      while (operatorStack.length > 0) {
        const topOp = operatorStack[operatorStack.length - 1];
        if (topOp.type === 'OPERATOR' && PRECEDENCE[topOp.value] >= PRECEDENCE[op]) {
          outputQueue.push(operatorStack.pop());
        } else {
          break;
        }
      }
      operatorStack.push(token);
    } else if (token.type === 'PAREN' && token.value === '(') {
      operatorStack.push(token);
    } else if (token.type === 'PAREN' && token.value === ')') {
      let foundOpen = false;
      while (operatorStack.length > 0) {
        const top = operatorStack[operatorStack.length - 1];
        if (top.type === 'PAREN' && top.value === '(') {
          operatorStack.pop();
          foundOpen = true;
          break;
        } else {
          outputQueue.push(operatorStack.pop());
        }
      }
      if (!foundOpen) throw new Error("Mismatched parentheses");
    }
  });
  
  while (operatorStack.length > 0) {
    const top = operatorStack.pop();
    if (top.type === 'PAREN') throw new Error("Mismatched parentheses");
    outputQueue.push(top);
  }
  
  return outputQueue;
}

function evaluatePostfix(rpn, row) {
  const stack = [];
  const lowerRow = {};
  Object.keys(row).forEach(k => {
    lowerRow[k.toLowerCase()] = row[k];
  });
  
  rpn.forEach(token => {
    if (token.type === 'NUMBER' || token.type === 'STRING') {
      stack.push(token.value);
    } else if (token.type === 'IDENTIFIER') {
      const name = token.value.toLowerCase();
      if (lowerRow.hasOwnProperty(name)) {
        stack.push(lowerRow[name]);
      } else {
        stack.push(null);
      }
    } else if (token.type === 'OPERATOR') {
      const right = stack.pop();
      const left = stack.pop();
      const op = token.value;
      
      switch (op) {
        case '+': stack.push((left || 0) + (right || 0)); break;
        case '-': stack.push((left || 0) - (right || 0)); break;
        case '*': stack.push((left || 0) * (right || 0)); break;
        case '/': stack.push((left || 0) / (right || 1)); break;
        case '==': stack.push(String(left).toLowerCase() === String(right).toLowerCase() || left == right); break;
        case '!=': stack.push(left != right); break;
        case '<': stack.push(left < right); break;
        case '>': stack.push(left > right); break;
        case '<=': stack.push(left <= right); break;
        case '>=': stack.push(left >= right); break;
        case '&&': stack.push(left && right); break;
        case '||': stack.push(left || right); break;
        case 'LIKE': {
          const lStr = String(left || '').toLowerCase();
          const rStr = String(right || '').toLowerCase();
          if (rStr.startsWith('%') && rStr.endsWith('%')) {
            const term = rStr.slice(1, -1);
            stack.push(lStr.includes(term));
          } else if (rStr.startsWith('%')) {
            const term = rStr.slice(1);
            stack.push(lStr.endsWith(term));
          } else if (rStr.endsWith('%')) {
            const term = rStr.slice(0, -1);
            stack.push(lStr.startsWith(term));
          } else {
            stack.push(lStr === rStr);
          }
          break;
        }
        default:
          throw new Error("Unknown operator: " + op);
      }
    }
  });
  
  if (stack.length !== 1) throw new Error("Evaluation error: stack size is " + stack.length);
  return stack[0];
}

function evalWhereCondition(row, whereStr) {
  try {
    const tokens = tokenize(whereStr);
    const rpn = shuntingYard(tokens);
    return evaluatePostfix(rpn, row);
  } catch (err) {
    throw new Error(`WHERE Clause evaluator failed: ${err.message} inside [${whereStr}]`);
  }
}

function parseFieldAlias(fieldStr) {
  const asMatch = fieldStr.match(/(.+?)\s+AS\s+(.+?)$/i);
  if (asMatch) {
    return {
      expr: asMatch[1].trim(),
      alias: asMatch[2].trim()
    };
  }
  return {
    expr: fieldStr.trim(),
    alias: fieldStr.trim()
  };
}

function projectFields(list, fieldsStr) {
  if (fieldsStr === '*') return list;
  const fields = fieldsStr.split(',').map(f => f.trim());
  
  return list.map(row => {
    const proj = {};
    const lowerKeys = {};
    Object.keys(row).forEach(k => {
      lowerKeys[k.toLowerCase()] = k;
    });

    fields.forEach(f => {
      const { expr, alias } = parseFieldAlias(f);
      const lowerExpr = expr.toLowerCase();

      if (lowerKeys.hasOwnProperty(lowerExpr)) {
        const originalKey = lowerKeys[lowerExpr];
        proj[alias] = row[originalKey];
      } else {
        try {
          const tokens = tokenize(expr);
          const rpn = shuntingYard(tokens);
          proj[alias] = evaluatePostfix(rpn, row);
        } catch (e) {
          proj[alias] = null;
        }
      }
    });
    return proj;
  });
}

function runGroupByAggregates(list, groupField, fieldsStr) {
  const groups = {};
  let actualGroupFieldKey = groupField;
  if (list.length > 0) {
    const lowerGroupField = groupField.toLowerCase();
    Object.keys(list[0]).forEach(k => {
      if (k.toLowerCase() === lowerGroupField) {
        actualGroupFieldKey = k;
      }
    });
  }

  list.forEach(row => {
    const key = row[actualGroupFieldKey] || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  });

  const fields = fieldsStr.split(',').map(f => f.trim());
  const groupedOutput = [];

  Object.keys(groups).forEach(key => {
    const rows = groups[key];
    const groupProj = {};

    fields.forEach(f => {
      const { expr, alias } = parseFieldAlias(f);
      const lowerExpr = expr.toLowerCase();

      if (lowerExpr === groupField.toLowerCase()) {
        groupProj[alias] = key;
      }
      else if (lowerExpr.includes('count(*)')) {
        groupProj[alias] = rows.length;
      }
      else if (lowerExpr.match(/avg\((.+?)\)/)) {
        const col = lowerExpr.match(/avg\((.+?)\)/)[1].trim();
        let actualCol = col;
        if (rows.length > 0) {
          Object.keys(rows[0]).forEach(k => {
            if (k.toLowerCase() === col.toLowerCase()) actualCol = k;
          });
        }
        const sum = rows.reduce((s, r) => s + (parseFloat(r[actualCol]) || 0), 0);
        groupProj[alias] = Math.round((sum / rows.length) * 10) / 10;
      }
      else if (lowerExpr.match(/sum\((.+?)\)/)) {
        const col = lowerExpr.match(/sum\((.+?)\)/)[1].trim();
        let actualCol = col;
        if (rows.length > 0) {
          Object.keys(rows[0]).forEach(k => {
            if (k.toLowerCase() === col.toLowerCase()) actualCol = k;
          });
        }
        groupProj[alias] = rows.reduce((s, r) => s + (parseFloat(r[actualCol]) || 0), 0);
      }
      else if (lowerExpr.match(/max\((.+?)\)/)) {
        const col = lowerExpr.match(/max\((.+?)\)/)[1].trim();
        let actualCol = col;
        if (rows.length > 0) {
          Object.keys(rows[0]).forEach(k => {
            if (k.toLowerCase() === col.toLowerCase()) actualCol = k;
          });
        }
        groupProj[alias] = rows.length > 0 ? Math.max(...rows.map(r => parseFloat(r[actualCol]) || 0)) : 0;
      }
      else if (lowerExpr.match(/min\((.+?)\)/)) {
        const col = lowerExpr.match(/min\((.+?)\)/)[1].trim();
        let actualCol = col;
        if (rows.length > 0) {
          Object.keys(rows[0]).forEach(k => {
            if (k.toLowerCase() === col.toLowerCase()) actualCol = k;
          });
        }
        groupProj[alias] = rows.length > 0 ? Math.min(...rows.map(r => parseFloat(r[actualCol]) || 0)) : 0;
      }
      else {
        let actualCol = expr;
        if (rows.length > 0) {
          Object.keys(rows[0]).forEach(k => {
            if (k.toLowerCase() === expr.toLowerCase()) actualCol = k;
          });
        }
        groupProj[alias] = rows.length > 0 ? (rows[0][actualCol] || null) : null;
      }
    });

    groupedOutput.push(groupProj);
  });

  return groupedOutput;
}

function exportSqlOutputToExcel(sqlString) {
  try {
    const feedback = document.getElementById('sqlQueryFeedback').innerText;
    if (feedback.includes('Failed') || feedback.includes('Error')) {
      appendLog('Execute a valid query output before exporting.', 'warning');
      return;
    }

    if (scrapedData.length === 0) {
      appendLog('No data available in results to download.', 'warning');
      return;
    }

    const queryableSet = scrapedData.map(item => {
      return {
        platform: item.platform || '',
        brand: item.brand || '',
        title: item.title || '',
        price: parseFloat(item.price) || 0,
        mrp: parseFloat(item.mrp) || 0,
        discount: parseFloat(item.discount) || 0,
        rating: parseFloat(item.rating) || 0,
        reviewCount: parseFloat(item.reviewCount) || 0,
        wowPrice: parseFloat(item.wowPrice) || 0,
        emiPrice: parseFloat(item.emiPrice) || 0,
        warranty: item.warranty || '',
        returnDays: parseFloat(item.returnDays) || 0,
        deliveryBy: item.deliveryBy || '',
        fulfilledBy: item.fulfilledBy || '',
        topKeywords: item.topKeywords || '',
        scrapeTime: item.scrapeTime || ''
      };
    });

    const output = runMiniSqlParser(sqlString, queryableSet);
    if (output.length === 0) {
      appendLog('No rows returned by query to export.', 'warning');
      return;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(output);
    XLSX.utils.book_append_sheet(wb, ws, "SQL Query Output");

    const filename = `sql_query_output_${Date.now()}.xlsx`;
    XLSX.writeFile(wb, filename);

    appendLog('Query output exported to Excel successfully.', 'success');
  } catch (err) {
    appendLog(`Export failed: ${err.message}`, 'error');
  }
}
