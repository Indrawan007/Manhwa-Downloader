/**
 * Background Service Worker - Manhwa Downloader v3.3
 * - Auto-save with organized folder structure
 * - CORS-free image fetch
 * - Batch engine: survives popup close / tab switching (runs entirely here)
 */

'use strict';

importScripts('../lib/jszip.min.js');

const LOG_PREFIX = '[ManhwaDL-BG]';
const DEFAULT_SUBFOLDER = 'Manhwa Downloader';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const FETCH_TIMEOUT = 15000;            // 15 s
const KEEPALIVE_INTERVAL = 20000;       // 20 s — keep SW alive during long batch

const MIME_MAP = Object.freeze({
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════
   Utils
   ══════════════════════════════════════ */

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000; // 32 KB per chunk
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) || 'manhwa-chapter';
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

function titleFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length) {
      return segments[segments.length - 1]
        .replace(/[-_]/g, ' ')
        .replace(/\.\w+$/, '')
        .replace(/\b\w/g, (l) => l.toUpperCase());
    }
  } catch (e) { /* ignore */ }
  return '';
}

/* ══════════════════════════════════════
   Image fetch
   ══════════════════════════════════════ */

// Base64 (dipakai popup single-mode & content-script blob path)
async function fetchImageAsBase64(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'include' });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size > MAX_FILE_SIZE) throw new Error(`Too large: ${(blob.size / 1048576).toFixed(1)}MB`);
    const buffer = await blob.arrayBuffer();
    return { success: true, data: bytesToBase64(new Uint8Array(buffer)), mimeType: blob.type, size: blob.size };
  } catch (error) {
    clearTimeout(timeoutId);
    return { success: false, error: error.name === 'AbortError' ? 'Timeout' : error.message };
  }
}

// Bytes langsung (dipakai batch engine untuk ZIP)
async function fetchImageBytes(url) {
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
   Batch state
   ══════════════════════════════════════ */

const batch = {
  isRunning: false,
  stopRequested: false,
  workerTabId: null,
  config: null,
  chapters: [],     // URL list (null = resolve later for 'next' mode)
  results: [],      // [{ title, status, images }]
  currentIndex: 0,
  totalChapters: 0,
  successCount: 0,
  failedCount: 0,
  currentTitle: '',
  currentStatus: '',
  currentPercent: 0,
  megaZip: null,    // merge mode
  keepaliveId: null,
};

function snapshot() {
  return {
    isRunning: batch.isRunning,
    stopRequested: batch.stopRequested,
    type: batch.config ? batch.config.type : null,
    currentChapter: batch.currentIndex,
    totalChapters: batch.totalChapters,
    successCount: batch.successCount,
    failedCount: batch.failedCount,
    currentTitle: batch.currentTitle,
    currentStatus: batch.currentStatus,
    currentPercent: batch.currentPercent,
    mergeZip: batch.config ? !!batch.config.mergeZip : false,
    chapters: batch.results.map((r) => ({ title: r.title, status: r.status, images: r.images })),
  };
}

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* no popup open */ }
}

function broadcastProgress() {
  broadcast({ action: 'BATCH_PROGRESS', data: snapshot() });
}

function startKeepalive() {
  if (batch.keepaliveId) return;
  batch.keepaliveId = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
  }, KEEPALIVE_INTERVAL);
}

function stopKeepalive() {
  if (batch.keepaliveId) { clearInterval(batch.keepaliveId); batch.keepaliveId = null; }
}

/* ══════════════════════════════════════
   Tab helpers
   ══════════════════════════════════════ */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('No active tab');
  return tab;
}

async function activateTab(tabId) {
  // Scan butuh tab terlihat (rAF/scroll tidak jalan di tab background)
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { /* ignore */ }
}

async function waitForTabLoad(tabId, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (batch.stopRequested) throw new Error('Stopped');
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch (e) { /* tab may be closed */ }
    await sleep(300);
  }
  throw new Error('Tab load timeout');
}

async function ensureContentScriptReady(tabId, maxRetry = 5) {
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (batch.stopRequested) throw new Error('Stopped');
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    } catch (e) { /* already injected */ }
    await sleep(400);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' });
      if (res && res.success) return;
    } catch (e) { /* not ready yet */ }
    await sleep(700);
  }
  throw new Error('Content script failed to initialize');
}

async function scanChapter(tabId, config) {
  await activateTab(tabId);
  const res = await chrome.tabs.sendMessage(tabId, {
    action: 'SCAN_IMAGES',
    customSelector: config.imageSelector || '',
    speed: config.scanSpeed || 'normal',
  });
  if (!res || !res.success || !res.images || !res.images.length) {
    throw new Error((res && res.error) || 'No images found on page');
  }
  const seen = new Set();
  const images = [];
  for (const u of res.images) {
    if (u && !seen.has(u)) { seen.add(u); images.push(u); }
  }
  return { images, title: res.title || '' };
}

async function fetchImage(url, tabId) {
  if (url.startsWith('blob:')) {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'FETCH_IMAGE', url });
    if (!res || !res.success || !res.data) throw new Error((res && res.error) || 'Fetch failed');
    return { data: base64ToBytes(res.data), mimeType: res.mimeType };
  }
  return fetchImageBytes(url);
}

/* ══════════════════════════════════════
   Chapter processing
   ══════════════════════════════════════ */

async function processChapter(url, index, config) {
  const tabId = batch.workerTabId;
  batch.currentStatus = 'Loading page';
  batch.currentPercent = 5;
  broadcastProgress();

  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId);
  await sleep(1200);
  await ensureContentScriptReady(tabId);

  let title = '';
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' });
    if (r && r.title && r.title.length > 3) title = r.title;
  } catch (e) { /* ignore */ }
  if (!title) title = titleFromUrl(url) || ('Chapter-' + (index + 1));
  title = sanitizeFilename(title);
  batch.currentTitle = title;
  batch.results[index] = { title, status: 'active', images: 0 };

  batch.currentStatus = 'Scanning images';
  batch.currentPercent = 20;
  broadcastProgress();

  const { images } = await scanChapter(tabId, config);
  const total = images.length;
  batch.results[index] = { title, status: 'active', images: total };
  batch.currentStatus = total + ' images found';
  batch.currentPercent = 40;
  broadcastProgress();

  const zip = config.mergeZip ? null : new JSZip();
  const folder = config.mergeZip ? batch.megaZip.folder(title) : zip.folder(title);

  let completed = 0;
  let failed = 0;
  const failedList = [];
  const concurrency = 6;
  let idx = 0;
  const active = new Set();

  const processNext = () => {
    while (idx < total && active.size < concurrency) {
      const i = idx++;
      const task = (async () => {
        try {
          const { data, mimeType } = await fetchImage(images[i], tabId);
          const ext = getFileExtension(images[i], mimeType);
          folder.file(padNumber(i + 1, config.namingFormat, total) + ext, data);
          completed++;
        } catch (e) {
          failed++;
          failedList.push({ index: i, url: images[i] });
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
      batch.currentStatus = 'Downloading ' + completed + '/' + total;
      batch.currentPercent = 40 + Math.round((completed / Math.max(total, 1)) * 40);
      broadcastProgress();
    }
  }
  await Promise.all(active);

  if (failedList.length && !batch.stopRequested) {
    batch.currentStatus = 'Retrying ' + failedList.length;
    broadcastProgress();
    for (const item of failedList) {
      if (batch.stopRequested) break;
      try {
        const { data, mimeType } = await fetchImage(item.url, tabId);
        const ext = getFileExtension(item.url, mimeType);
        folder.file(padNumber(item.index + 1, config.namingFormat, total) + ext, data);
        completed++;
        failed--;
      } catch (e) { /* give up */ }
    }
  }

  if (completed === 0) throw new Error('No images downloaded successfully');

  if (zip) {
    batch.currentStatus = 'Creating ZIP';
    batch.currentPercent = 88;
    broadcastProgress();
    const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
    await chrome.downloads.download({
      url: 'data:application/zip;base64,' + base64,
      filename: (config.useSubfolder !== false ? DEFAULT_SUBFOLDER + '/' : '') + title + '.zip',
      saveAs: config.saveAs === true,
      conflictAction: 'uniquify',
    });
  }

  batch.results[index] = { title, status: 'success', images: completed };
  return { success: true, images: completed, failed };
}

/* ══════════════════════════════════════
   Next chapter detection
   ══════════════════════════════════════ */

async function findNextChapter(selector) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: batch.workerTabId },
      func: (sel) => {
        const selectors = sel ? [sel] : [
          'a.next-chapter', 'a.btn-next-chapter', '.next-chapter', '.btn-next',
          'a[rel="next"]', '.chapter-next', '#next-chapter', '.next', 'a.next',
          '[class*="next"][class*="chapter"] a', '[class*="next"][class*="chapter"]',
          'a[href*="next"]', 'a[title*="Next"]', 'a[aria-label*="Next"]',
          '.reader-nav .next', '.chapter-nav .next', '#nextch', '.nextch',
        ];
        for (const s of selectors) {
          let els = [];
          try { els = document.querySelectorAll(s); } catch (e) { continue; }
          for (const el of els) {
            const href = el.href || el.getAttribute('href');
            if (href && href !== '#' && href !== 'javascript:void(0)') {
              try {
                return { success: true, url: new URL(href, location.href).href, selector: s };
              } catch (e) { continue; }
            }
          }
          try {
            const el = document.querySelector(s);
            if (el) { el.click(); return { success: true, clicked: true, selector: s }; }
          } catch (e) { continue; }
        }
        return { success: false, error: 'No next chapter button found' };
      },
      args: [selector || ''],
    });
    return result && result[0] && result[0].result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* ══════════════════════════════════════
   Batch driver
   ══════════════════════════════════════ */

async function startBatch(config) {
  if (batch.isRunning) return { success: false, error: 'Batch already running' };
  if (!config || !config.type) return { success: false, error: 'Invalid config' };

  const tab = await getActiveTab();
  batch.workerTabId = tab.id;
  batch.isRunning = true;
  batch.stopRequested = false;
  batch.config = config;
  batch.successCount = 0;
  batch.failedCount = 0;
  batch.currentIndex = 0;
  batch.currentTitle = '';
  batch.currentStatus = 'Starting';
  batch.currentPercent = 0;
  batch.megaZip = config.mergeZip ? new JSZip() : null;
  startKeepalive();

  let urls = [];
  if (config.type === 'list' || config.type === 'pattern') {
    urls = (config.urls || []).slice();
  } else {
    urls = [config.startUrl || tab.url];
    for (let i = 1; i < (config.count || 1); i++) urls.push(null);
  }
  batch.chapters = urls;
  batch.totalChapters = urls.length;
  batch.results = urls.map((u, i) => ({ title: u || ('Chapter ' + (i + 1)), status: 'waiting', images: 0 }));
  broadcastProgress();

  try {
    for (let i = 0; i < urls.length; i++) {
      if (batch.stopRequested) break;
      batch.currentIndex = i + 1;
      batch.currentTitle = urls[i] || ('Chapter ' + (i + 1));
      batch.currentStatus = 'Preparing';
      batch.currentPercent = 2;
      broadcastProgress();

      let currentUrl = urls[i];

      if (config.type === 'next' && i > 0) {
        batch.currentStatus = 'Finding next chapter';
        broadcastProgress();
        const next = await findNextChapter(config.nextSelector);
        if (!next || !next.success) {
          batch.results[i] = { title: batch.currentTitle, status: 'error', images: 0 };
          batch.failedCount++;
          if (!config.skipErrors) break;
          continue;
        }
        currentUrl = next.url;
        if (!currentUrl && next.clicked) {
          await sleep(3000);
          try { const t = await chrome.tabs.get(batch.workerTabId); currentUrl = t.url; } catch (e) { /* ignore */ }
        }
        if (!currentUrl) {
          batch.results[i] = { title: batch.currentTitle, status: 'error', images: 0 };
          batch.failedCount++;
          if (!config.skipErrors) break;
          continue;
        }
        urls[i] = currentUrl;
        batch.currentTitle = currentUrl;
        batch.results[i].title = currentUrl;
      }

      if (!currentUrl) {
        batch.results[i] = { title: batch.currentTitle, status: 'error', images: 0 };
        batch.failedCount++;
        if (!config.skipErrors) break;
        continue;
      }

      batch.results[i].status = 'active';
      try {
        const r = await processChapter(currentUrl, i, config);
        if (r.success) batch.successCount++;
        else { batch.failedCount++; batch.results[i].status = 'error'; if (!config.skipErrors) break; }
      } catch (e) {
        console.error(`${LOG_PREFIX} ❌ Chapter failed:`, e);
        batch.failedCount++;
        batch.results[i] = { title: batch.results[i].title || currentUrl, status: 'error', images: 0 };
        if (!config.skipErrors) break;
      }

      const delaySec = config.chapterDelay || 0;
      if (i < urls.length - 1 && delaySec > 0) {
        for (let s = delaySec; s > 0; s--) {
          if (batch.stopRequested) break;
          batch.currentStatus = 'Waiting for next chapter (' + s + 's)';
          batch.currentPercent = 100;
          broadcastProgress();
          await sleep(1000);
        }
      }
    }

    if (config.mergeZip && batch.successCount > 0 && !batch.stopRequested) {
      batch.currentStatus = 'Merging chapters';
      batch.currentPercent = 90;
      broadcastProgress();
      const base64 = await batch.megaZip.generateAsync({ type: 'base64', compression: 'STORE' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await chrome.downloads.download({
        url: 'data:application/zip;base64,' + base64,
        filename: (config.useSubfolder !== false ? DEFAULT_SUBFOLDER + '/' : '') + 'manhwa-batch-' + ts + '.zip',
        saveAs: config.saveAs === true,
        conflictAction: 'uniquify',
      });
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Batch error:`, e);
  } finally {
    const stopped = batch.stopRequested;
    batch.isRunning = false;
    batch.megaZip = null;
    stopKeepalive();
    batch.currentStatus = stopped ? 'Stopped' : 'Complete';
    broadcast({ action: 'BATCH_COMPLETE', data: snapshot() });
  }

  return { success: true, stopped: batch.stopRequested };
}

/* ══════════════════════════════════════
   Message listener
   ══════════════════════════════════════ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_ZIP') {
    const { dataUrl, filename, saveAs, useSubfolder } = message;
    const finalFilename = useSubfolder !== false ? `${DEFAULT_SUBFOLDER}/${filename}` : filename;
    chrome.downloads.download({
      url: dataUrl,
      filename: finalFilename,
      saveAs: saveAs === true,
      conflictAction: 'uniquify',
    })
      .then((downloadId) => {
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
            chrome.downloads.onChanged.removeListener(onChanged);
            try { URL.revokeObjectURL(dataUrl); } catch (e) { /* ignore */ }
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          try { URL.revokeObjectURL(dataUrl); } catch (e) { /* ignore */ }
        }, 10 * 60 * 1000);
        sendResponse({ success: true, downloadId });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'FETCH_IMAGE') {
    fetchImageAsBase64(message.url).then(sendResponse);
    return true;
  }

  if (message.action === 'START_BATCH') {
    if (batch.isRunning) {
      sendResponse({ success: false, error: 'Batch already running' });
      return false;
    }
    startBatch(message.config)
      .catch((e) => console.error(`${LOG_PREFIX} Batch error:`, e));
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'STOP_BATCH') {
    batch.stopRequested = true;
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'GET_BATCH_STATE') {
    sendResponse({ success: true, state: snapshot() });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Installed:`, details.reason);
});