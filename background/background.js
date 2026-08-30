/**
 * Background Service Worker - Manhwa Downloader v2.1.1
 * - Auto-save with organized folder structure
 * - CORS-free image fetch
 * - Batch engine: survives popup close / tab switching (runs entirely here)
 * - ZIP dibangun & diunduh lewat offscreen document (Blob URL) supaya
 *   tidak kena limit data:-URL dan lebih hemat memori.
 */

'use strict';

const LOG_PREFIX = '[ManhwaDL-BG]';
const DEFAULT_SUBFOLDER = 'Manhwa Downloader';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const FETCH_TIMEOUT = 15000;            // 15 s
const KEEPALIVE_INTERVAL = 15000;       // 15 s — keep SW alive during long batch

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

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) || 'manhwa-chapter';
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
   Image fetch (base64 — dipakai popup single-mode & blob path)
   ══════════════════════════════════════ */

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
  usedFolders: null, // Set — anti-tabrakan nama folder di merge mode
  mergeBase: '', 
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
    // Reset idle timer SW agar tidak dimatikan di tengah batch.
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

/**
 * Tunggu sampai tab benar-benar selesai load (status 'complete') setelah
 * navigasi. Pakai onUpdated + register listener SEBELUM navigasi dimulai,
 * supaya tidak melewatkan event 'complete' (fix race condition yang bisa
 * membuat halaman lama ter-scan dua kali).
 */
function waitForTabComplete(tabId, timeout = 45000) {
  const start = Date.now();
  let timer = null;
  let settled = false;
  let resolve, reject;

  const cleanup = () => {
    if (timer) clearInterval(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };

  const onUpdated = (tId, changeInfo) => {
    if (tId !== tabId) return;
    if (changeInfo.status === 'complete') {
      if (!settled) { settled = true; cleanup(); resolve(); }
    }
  };

  chrome.tabs.onUpdated.addListener(onUpdated);

  timer = setInterval(() => {
    if (batch.stopRequested) {
      settled = true; cleanup(); reject(new Error('Stopped'));
    } else if (Date.now() - start > timeout) {
      settled = true; cleanup(); reject(new Error('Tab load timeout'));
    }
  }, 250);

  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.cancel = () => { if (!settled) { settled = true; cleanup(); } };
  return promise;
}

async function navigateTab(tabId, url) {
  let currentUrl = '';
  try { const t = await chrome.tabs.get(tabId); currentUrl = t.url || ''; } catch (e) { /* ignore */ }

  // Navigasi ke URL yang sama tidak memicu onUpdated → skip langsung.
  if (currentUrl === url) { await sleep(400); return; }

  const loadPromise = waitForTabComplete(tabId);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    loadPromise.cancel();
    throw e;
  }
  await loadPromise;
}

/**
 * Tunggu sampai URL tab berubah + status 'complete' (dipakai setelah klik
 * tombol "next" yang tidak punya href, menggantikan sleep(3000) yang rawan).
 */
async function waitForUrlChange(tabId, timeout = 15000) {
  let oldUrl = '';
  try { const t = await chrome.tabs.get(tabId); oldUrl = t.url || ''; } catch (e) { /* ignore */ }
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (batch.stopRequested) return null;
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.url && t.url !== oldUrl && t.status === 'complete') return t.url;
    } catch (e) { /* tab closed */ }
    await sleep(250);
  }
  return null;
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

/* ══════════════════════════════════════
   Offscreen document (ZIP builder + Blob URL downloader)
   ══════════════════════════════════════ */

async function ensureOffscreenDoc() {
  if (chrome.offscreen.hasDocument) {
    try { if (await chrome.offscreen.hasDocument()) return; } catch (e) { /* ignore */ }
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'ZIP files must be built and downloaded as Blob URLs; URL.createObjectURL is unavailable in MV3 service workers.',
    });
  } catch (e) {
    // Chrome 116+ punya hasDocument; kalau doc ternyata sudah ada → sukses.
    if (chrome.offscreen.hasDocument) {
      try { if (await chrome.offscreen.hasDocument()) return; } catch (e2) { /* ignore */ }
    }
    // Chrome <116 tidak punya hasDocument → fallback: error "already exists"
    // berarti doc sudah terbuka. Anggap sukses supaya megaZip (merge mode)
    // tidak hilang karena doc di-recreate tiap chapter.
    const msg = String((e && e.message) || '');
    if (!/single offscreen document|already exists|already created/i.test(msg)) throw e;
  }
  // Handshake: pastikan listener offscreen sudah siap.
  for (let i = 0; i < 5; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_PING' });
      if (res && res.alive) return;
    } catch (e) { /* not ready yet */ }
    await sleep(200);
  }
}

async function closeOffscreenDoc() {
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* ignore */ }
}

async function sendToOffscreen(action, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureOffscreenDoc();
    try {
      return await chrome.runtime.sendMessage(Object.assign({ action }, payload || {}));
    } catch (e) {
      if (attempt === 0) { try { await closeOffscreenDoc(); } catch (e2) { /* ignore */ } continue; }
      throw e;
    }
  }
}

/* ══════════════════════════════════════
   Chapter processing
   ══════════════════════════════════════ */

async function processChapter(url, index, config) {
  const tabId = batch.workerTabId;
  batch.currentStatus = 'Loading page';
  batch.currentPercent = 5;
  broadcastProgress();

  await navigateTab(tabId, url);
  await sleep(1200);
  await ensureContentScriptReady(tabId);

  let title = '';
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' });
    if (r && r.title && r.title.length > 3) title = r.title;
  } catch (e) { /* ignore */ }
  if (!title) title = titleFromUrl(url) || ('Chapter-' + (index + 1));
  title = sanitizeFilename(title);

  // Anti-tabrakan nama folder di merge mode (2 chapter berjudul sama → folder beda).
  let folderName = title;
  if (config.mergeZip) {
    if (batch.usedFolders.has(folderName.toLowerCase())) {
      let n = 2;
      while (batch.usedFolders.has(folderName.toLowerCase())) folderName = title + ' (' + (n++) + ')';
    }
    batch.usedFolders.add(folderName.toLowerCase());
  }

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

  const zipRes = await sendToOffscreen('BUILD_ZIP', {
    tabId,
    folderName,
    title,
    urls: images,
    namingFormat: config.namingFormat,
    merge: !!config.mergeZip,
    mergeBase: batch.mergeBase,
    filename: title + '.zip',
    saveAs: config.saveAs === true,
    useSubfolder: config.useSubfolder !== false,
  });

  if (!zipRes || !zipRes.success) {
    throw new Error((zipRes && zipRes.error) || 'ZIP build failed');
  }

  batch.results[index] = { title, status: 'success', images: zipRes.images || total };
  return { success: true, images: zipRes.images || total, failed: zipRes.failed || 0 };
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

  batch.isRunning = true;
  batch.stopRequested = false;
  batch.config = config;
  batch.successCount = 0;
  batch.failedCount = 0;
  batch.currentIndex = 0;
  batch.currentTitle = '';
  batch.currentStatus = 'Starting';
  batch.currentPercent = 0;
  batch.usedFolders = new Set();
  batch.mergeBase = 'manhwa-batch-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  startKeepalive();

  let failedEarly = null;

  try {
    const tab = await getActiveTab();
    batch.workerTabId = tab.id;

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

    for (let i = 0; i < urls.length; i++) {
      if (batch.stopRequested) break;
      batch.currentIndex = i + 1;
      batch.currentTitle = urls[i] || ('Chapter ' + (i + 1));
      batch.currentStatus = 'Preparing';
      batch.currentPercent = 2;
      broadcastProgress();

      let currentUrl = urls[i];

      // Resolve next chapter untuk mode 'next'
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
          currentUrl = await waitForUrlChange(batch.workerTabId);
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

      // Delay dengan countdown
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

    // Merge mode
    if (config.mergeZip && batch.successCount > 0 && !batch.stopRequested) {
      batch.currentStatus = 'Merging chapters';
      batch.currentPercent = 90;
      broadcastProgress();
      const merged = await sendToOffscreen('FINALIZE_MERGE', {
        mergeBase: batch.mergeBase,
        saveAs: config.saveAs === true,
        useSubfolder: config.useSubfolder !== false,
      });
      if (!merged || !merged.success) throw new Error((merged && merged.error) || 'Merge failed');
    }
  } catch (e) {
    failedEarly = e;
    console.error(`${LOG_PREFIX} Batch error:`, e);
  } finally {
    const stopped = batch.stopRequested;
    batch.isRunning = false;
    stopKeepalive();
    closeOffscreenDoc();
    batch.currentStatus = stopped ? 'Stopped' : (failedEarly ? 'Failed' : 'Complete');
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
    // Fire-and-forget: loop jalan di background, respons segera.
    // Semua error ditangani di dalam startBatch → selalu broadcast BATCH_COMPLETE.
    startBatch(message.config)
      .catch((e) => console.error(`${LOG_PREFIX} Batch error:`, e));
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'STOP_BATCH') {
    batch.stopRequested = true;
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'GET_BATCH_STATE') {
    sendResponse({ success: true, state: snapshot() });
    return false;
  }

  // Progress ZIP dari offscreen document → teruskan ke popup via BATCH_PROGRESS.
  if (message.action === 'ZIP_PROGRESS') {
    const d = message.data || {};
    if (d.status) batch.currentStatus = d.status;
    if (typeof d.percent === 'number') batch.currentPercent = d.percent;
    broadcastProgress();
    return false;
  }

  // Heartbeat offscreen (me-reset idle timer SW) & handshake siap-tidaknya.
  if (message.action === 'OFFSCREEN_PING') {
    sendResponse({ alive: true });
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} Installed:`, details.reason);
});