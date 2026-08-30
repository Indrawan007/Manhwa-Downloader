/**
 * Background Service Worker - Manhwa Downloader v3.2
 * Auto-save with organized folder structure + CORS-free image fetch
 */

'use strict';

const LOG_PREFIX = '[ManhwaDL-BG]';
const DEFAULT_SUBFOLDER = 'Manhwa Downloader'; // ✅ Subfolder name
const MAX_FILE_SIZE = 20 * 1024 * 1024;        // 20 MB
const FETCH_TIMEOUT = 15000;                   // 15 s

/**
 * Konversi Uint8Array -> base64 string (chunked, aman untuk file besar).
 * Base64 jauh lebih kecil daripada array angka saat dikirim lewat message JSON.
 */
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000; // 32 KB per chunk
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetch gambar dari background worker.
 * Dengan host_permissions ["<all_urls>"], fetch di sini TIDAK dibatasi CORS,
 * tidak seperti fetch dari popup/content script.
 */
async function fetchImageAsBase64(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'include',
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    if (blob.size > MAX_FILE_SIZE) {
      throw new Error(`Too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);
    }

    const buffer = await blob.arrayBuffer();
    return {
      success: true,
      data: bytesToBase64(new Uint8Array(buffer)),
      mimeType: blob.type,
      size: blob.size,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      success: false,
      error: error.name === 'AbortError' ? 'Timeout' : error.message,
    };
  }
}

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

        // Jangan revoke blob/data URL sebelum download benar-benar selesai.
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
            chrome.downloads.onChanged.removeListener(onChanged);
            try { URL.revokeObjectURL(dataUrl); } catch { /* ignore */ }
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);

        // Fallback pengaman jika event onChanged tidak pernah terpanggil
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          try { URL.revokeObjectURL(dataUrl); } catch { /* ignore */ }
        }, 10 * 60 * 1000);

        sendResponse({ success: true, downloadId });
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} ❌ Failed:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'FETCH_IMAGE') {
    fetchImageAsBase64(message.url).then(sendResponse);
    return true;
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Installed:`, details.reason);
});