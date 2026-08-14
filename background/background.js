/**
 * Background Service Worker - Manhwa Downloader v2.0
 * Handles download requests and message routing
 */

'use strict';

const LOG_PREFIX = '[ManhwaDL-BG]';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_ZIP') {
    chrome.downloads.download({
      url: message.dataUrl,
      filename: message.filename,
      saveAs: true,
    })
      .then(downloadId => {
        console.log(`${LOG_PREFIX} Download started:`, downloadId);
        sendResponse({ success: true, downloadId });
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} Download failed:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }
});

// Cleanup on install/update
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Installed/Updated:`, details.reason);
});
