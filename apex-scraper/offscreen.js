// Apex Scraper v6 — Offscreen fetch + parse worker.
// Tier-1 engine: fast HTTP fetch parsed with DOMParser via the shared ApexExtractor.
// Never fabricates data; returns { status: 'blocked' | 'failed' } so the
// background engine can escalate to live-tab rendering (Tier-2).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.action === 'scrape_url') {
    scrapeUrlAndParse(message.url)
      .then(data => sendResponse(data))
      .catch(err => sendResponse({
        url: message.url,
        status: 'failed',
        failReason: 'Fetch error: ' + (err && err.message ? err.message : String(err))
      }));
    return true; // async
  }
  return false;
});

async function scrapeUrlAndParse(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (response.status === 503 || response.status === 429) {
      return { url, status: 'blocked', failReason: 'HTTP ' + response.status + ' (rate limit / bot wall)' };
    }
    if (!response.ok) {
      return { url, status: 'failed', failReason: 'HTTP ' + response.status };
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return ApexExtractor.extract(doc, html, url);
  } finally {
    clearTimeout(timeoutId);
  }
}

// MV3 keep-alive pulse so the service worker stays awake during long crawls
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'heartbeat_ping' }).catch(() => {});
}, 20000);
