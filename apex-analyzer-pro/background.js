// Apex Analyzer Pro - background service worker.
// Opens the full-page workbench in its own tab when the toolbar action is clicked.
chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});
