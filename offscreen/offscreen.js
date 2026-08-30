/**
 * Offscreen Document - Manhwa Downloader v2.1.1
 * - Membangun ZIP (per-chapter & merged) dari daftar image URL
 * - Download via Blob URL (URL.createObjectURL tidak tersedia di SW MV3)
 * - Keepalive anchor: ping service worker supaya tidak idle-timeout
 */

'use strict';

const LOG_PREFIX = '[ManhwaDL-OFF]';
const DEFAULT_SUBFOLDER = 'Manhwa Downloader';
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const FETCH_TIMEOUT = 15000;
const KEEPALIVE_INTERVAL = 20000;
const MERGE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB per merged ZIP part (jaga memori)

const MIME_MAP = Object.freeze({
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
});

let megaZip = null;   // JSZip untuk merge mode (state persisten selama doc hidup)
let megaBytes = 0;    // akumulasi byte gambar di dalam megaZip
let megaParts = 0;    // jumlah part yang sudah di-flush
let megaBase = '';    // nama dasar file merge (mis. 'manhwa-batch-...')
let megaActive = false; // true = sesi merge sedang berjalan
let busy = false;

/* ══════════════════════════════════════
   Utils
   ══════════════════════════════════════ */

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function padNumber(num, format, total) {
  total = total || 0;
  let digits;
  if (format === 'auto') digits = Math.max(2, String(total).length);
  else digits = ({ '1digit': 1, '2digit': 2, '3digit': 3, '4digit': 4 })[format] || 3;
  return String(num).padStart(digits, '0');
}

function getFileExtension(url, mimeType) {
  mimeType = mimeType || '';
  if (mimeType) {
    const type = mimeType.split(';')[0].trim().toLowerCase();
    if (MIME_MAP[type]) return MIME_MAP[type];
  }
  if (url && !url.startsWith('blob:')) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (pathname.includes('.png')) return '.png';
      if (pathname.includes('.webp')) return '.webp';
      if (pathname.includes('.jpg') || pathname.includes('.jpeg')) return '.jpg';
    } catch (e) { /* ignore */ }
  }
  return '.jpg';
}

/* ══════════════════════════════════════
   Image fetch
   ══════════════════════════════════════ */

async function fetchImage(url, tabId) {
  if (url.startsWith('blob:')) {
    // blob: URL hanya bisa dibaca dari halaman yang membuatnya → content script
    const res = await chrome.tabs.sendMessage(tabId, { action: 'FETCH_IMAGE', url });
    if (!res || !res.success || !res.data) throw new Error((res && res.error) || 'Fetch failed');
    return { data: base64ToBytes(res.data), mimeType: res.mimeType };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'include' });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length > MAX_FILE_SIZE) throw new Error(`Too large: ${(bytes.length / 1048576).toFixed(1)}MB`);
    return { data: bytes, mimeType: (response.headers.get('content-type') || '').split(';')[0].trim() };
  } catch (error) {
    clearTimeout(timeoutId);
    throw new Error(error.name === 'AbortError' ? 'Timeout' : error.message);
  }
}

/* ══════════════════════════════════════
   ZIP build
   ══════════════════════════════════════ */

function progress(status, percent) {
  try { chrome.runtime.sendMessage({ action: 'ZIP_PROGRESS', data: { status, percent } }).catch(() => {}); } catch (e) { /* ignore */ }
}

async function addImagesToFolder(folder, urls, tabId, namingFormat) {
  const total = urls.length;
  let completed = 0;
  let failed = 0;
  let bytes = 0;
  const failedList = [];
  const concurrency = 6;
  let idx = 0;
  const active = new Set();

  const processNext = () => {
    while (idx < total && active.size < concurrency) {
      const i = idx++;
      const task = (async () => {
        try {
          const { data, mimeType } = await fetchImage(urls[i], tabId);
          folder.file(padNumber(i + 1, namingFormat, total) + getFileExtension(urls[i], mimeType), data);
          bytes += data.length;
          completed++;
        } catch (e) {
          failed++;
          failedList.push({ index: i, url: urls[i] });
          console.error(`${LOG_PREFIX} ❌ image ${i + 1}:`, e.message);
        }
        active.delete(task);
      })();
      active.add(task);
    }
  };

  while (idx < total || active.size > 0) {
    processNext();
    if (active.size > 0) {
      await Promise.race(active);
      progress('Downloading ' + completed + '/' + total, 40 + Math.round((completed / Math.max(total, 1)) * 40));
    }
  }
  await Promise.all(active);

  // Retry failed
  for (const item of failedList) {
    try {
      const { data, mimeType } = await fetchImage(item.url, tabId);
      folder.file(padNumber(item.index + 1, namingFormat, total) + getFileExtension(item.url, mimeType), data);
      bytes += data.length;
      completed++;
      failed--;
    } catch (e) { /* give up */ }
  }

  return { completed, failed, bytes };
}

async function downloadBlob(blob, filename, saveAs, useSubfolder) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url: blobUrl,
      filename: (useSubfolder !== false ? DEFAULT_SUBFOLDER + '/' : '') + filename,
      saveAs: saveAs === true,
      conflictAction: 'uniquify',
    });
  } finally {
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
    }, 60 * 1000);
  }
}

/* ══════════════════════════════════════
   Message listener
   ══════════════════════════════════════ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'OFFSCREEN_PING') {
    sendResponse({ alive: true });
    return false;
  }

  if (message.action === 'BUILD_ZIP') {
    if (busy) { sendResponse({ success: false, error: 'ZIP builder busy' }); return false; }
    busy = true;
    (async () => {
      try {
        const folderName = message.folderName || message.title || 'chapter';
        let completed = 0;
        let failed = 0;

        if (message.merge) {
          if (!megaActive) {
            megaZip = new JSZip();
            megaBytes = 0;
            megaParts = 0;
            megaBase = message.mergeBase || ('manhwa-batch-' + Date.now());
            megaActive = true;
          }
          const folder = megaZip.folder(folderName);
          const res = await addImagesToFolder(folder, message.urls, message.tabId, message.namingFormat);
          completed = res.completed;
          failed = res.failed;
          megaBytes += res.bytes;
          if (completed === 0) throw new Error('No images downloaded successfully');

          // Auto-split: kalau akumulasi melebihi batas, flush jadi ZIP part
          // supaya memori offscreen tidak membengkak pada batch raksasa.
          if (megaBytes >= MERGE_MAX_BYTES) {
            progress('Splitting merged ZIP', 90);
            megaParts++;
            const partName = megaBase + '-part' + megaParts + '.zip';
            const blob = await megaZip.generateAsync({ type: 'blob', compression: 'STORE' });
            megaZip = new JSZip();
            megaBytes = 0;
            progress('Saving', 100);
            await downloadBlob(blob, partName, message.saveAs, message.useSubfolder);
          }
          sendResponse({ success: true, images: completed, failed });
        } else {
          const zip = new JSZip();
          const folder = zip.folder(folderName);
          progress('Downloading 0/' + message.urls.length, 40);
          const res = await addImagesToFolder(folder, message.urls, message.tabId, message.namingFormat);
          completed = res.completed;
          failed = res.failed;
          if (completed === 0) throw new Error('No images downloaded successfully');
          progress('Creating ZIP', 88);
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
          progress('Saving', 100);
          await downloadBlob(blob, message.filename || (message.title + '.zip'), message.saveAs, message.useSubfolder);
          sendResponse({ success: true, images: completed, failed });
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} ❌ BUILD_ZIP:`, e);
        sendResponse({ success: false, error: e.message });
      } finally {
        busy = false;
      }
    })();
    return true;
  }

  if (message.action === 'FINALIZE_MERGE') {
    if (busy) { sendResponse({ success: false, error: 'ZIP builder busy' }); return false; }
    busy = true;
    (async () => {
      try {
        if (!megaZip) throw new Error('No chapters to merge');

        // Part terakhir kosong (semua sudah ter-flush saat split) →
        // jangan download arsip kosong.
        if (megaBytes === 0) {
          megaZip = null;
          megaActive = false;
          sendResponse({ success: true });
          return;
        }

        progress('Merging chapters', 90);
        const blob = await megaZip.generateAsync({ type: 'blob', compression: 'STORE' });
        megaZip = null;
        megaBytes = 0;
        megaActive = false;
        progress('Saving', 100);
        const base = message.mergeBase || megaBase || ('manhwa-batch-' + Date.now());
        megaParts++;
        // Kalau cuma satu part, nama tetap polos (tanpa -partN).
        const partName = megaParts === 1 ? base + '.zip' : base + '-part' + megaParts + '.zip';
        await downloadBlob(blob, partName, message.saveAs, message.useSubfolder);
        sendResponse({ success: true });
      } catch (e) {
        console.error(`${LOG_PREFIX} ❌ FINALIZE_MERGE:`, e);
        sendResponse({ success: false, error: e.message });
      } finally {
        busy = false;
      }
    })();
    return true;
  }

  return false;
});

/* ══════════════════════════════════════
   Keepalive anchor — ping SW agar idle timer-nya terus di-reset
   ══════════════════════════════════════ */

setInterval(() => {
  try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_PING' }).catch(() => {}); } catch (e) { /* ignore */ }
}, KEEPALIVE_INTERVAL);