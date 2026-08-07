/**
 * Background Service Worker - Manhwa Downloader
 * Handle download requests dari popup
 */

'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_ZIP') {
    chrome.downloads.download({
      url: message.dataUrl,
      filename: message.filename,
      saveAs: true,
    })
      .then(downloadId => sendResponse({ success: true, downloadId }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
