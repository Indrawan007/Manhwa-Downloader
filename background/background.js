/**
 * Background Service Worker - Manhwa Downloader v3.1
 * Auto-save with organized folder structure
 */

'use strict';

const LOG_PREFIX = '[ManhwaDL-BG]';
const DEFAULT_SUBFOLDER = 'Manhwa Downloader'; // ✅ Subfolder name

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_ZIP') {
    const { dataUrl, filename, saveAs, useSubfolder } = message;

    // ✅ Organize into subfolder (optional)
    const finalFilename = useSubfolder !== false
      ? `${DEFAULT_SUBFOLDER}/${filename}`
      : filename;

    chrome.downloads.download({
      url: dataUrl,
      filename: finalFilename,
      saveAs: saveAs === true,
      conflictAction: 'uniquify', // Auto-rename duplicates
    })
      .then(downloadId => {
        console.log(`${LOG_PREFIX} ✅ Download:`, finalFilename);
        sendResponse({ success: true, downloadId });
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} ❌ Failed:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Installed:`, details.reason);
});
