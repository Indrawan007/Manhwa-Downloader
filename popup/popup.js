/**
 * Popup Controller - Manhwa Downloader v2.1.1
 * Full fixed version with batch mode support
 */

(() => {
  'use strict';

  /* ══════════════════════════════════════
     Constants
     ══════════════════════════════════════ */

  const STORAGE_KEYS = Object.freeze({
    SETTINGS: 'manhwaDL_settings',
  });

  const PLACEHOLDERS = Object.freeze({
    blob: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect fill="#6c5ce7" width="60" height="80"/><text x="30" y="38" text-anchor="middle" fill="white" font-size="7" font-weight="bold">BLOB</text><text x="30" y="52" text-anchor="middle" fill="white" font-size="7" font-weight="bold">IMG</text></svg>'
    ),
    loading: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect fill="#2d2d4f" width="60" height="80"/><circle cx="30" cy="40" r="8" fill="#6c5ce7" opacity="0.3"/></svg>'
    ),
    error: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect fill="#2d2d4f" width="60" height="80"/><text x="30" y="44" text-anchor="middle" fill="#7a7a99" font-size="9" font-weight="bold">?</text></svg>'
    ),
  });

  const PREVIEW_INITIAL_LIMIT = 20;
  const MIME_MAP = Object.freeze({
    'image/png': '.png',
    'image/webp': '.webp',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
  });

  /* ══════════════════════════════════════
     DOM References
     ══════════════════════════════════════ */

  const $ = (id) => document.getElementById(id);
  const dom = {
    appStatus: $('appStatus'),
    chapterName: $('chapterName'),
    namingFormat: $('namingFormat'),
    formatHint: $('formatHint'),
    scanSpeed: $('scanSpeed'),
    imageSelector: $('imageSelector'),
    askSaveLocation: $('askSaveLocation'),
        useSubfolder: $('useSubfolder'),
    btnScan: $('btnScan'),
    btnStop: $('btnStop'),
    btnTestScroll: $('btnTestScroll'),
    btnDownload: $('btnDownload'),
    btnToggle: $('btnTogglePreview'),
    toggleText: $('toggleText'),
    scanProgress: $('scanProgress'),
    scanPhase: $('scanPhase'),
    scanCollected: $('scanCollected'),
    scanProgressFill: $('scanProgressFill'),
    scanPercent: $('scanPercent'),
    scanMessage: $('scanMessage'),
    previewArea: $('previewArea'),
    previewGrid: $('previewGrid'),
    imageCount: $('imageCount'),
    progressBar: $('progressBar'),
    progressFill: $('progressFill'),
    progressText: $('progressText'),
    statusMessage: $('statusMessage'),
    btnText: document.querySelector('.btn-text'),
    btnLoading: document.querySelector('.btn-loading'),
  };

  /* ══════════════════════════════════════
     State
     ══════════════════════════════════════ */

  const state = {
    scannedImages: [],
    blobCache: new Map(),
    isDownloading: false,
    isScanning: false,
    activeTabId: null,
    lazyObserver: null,
    filenameCache: null,
    messageListener: null,
    batchMessageListener: null,
  };

  /* ══════════════════════════════════════
     Utilities
     ══════════════════════════════════════ */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const STATUS_COLORS = Object.freeze({
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    danger: 'var(--color-danger)',
    info: 'var(--color-info)',
  });

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');
    return tab;
  }

  async function sendToContentScript(message) {
    const tab = await getActiveTab();
    state.activeTabId = tab.id;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
    } catch (e) {
      // Already injected
    }

    return chrome.tabs.sendMessage(tab.id, message);
  }

  function setAppStatus(text, color) {
    color = color || 'success';
    dom.appStatus.innerHTML = '<span class="status-dot" style="background:' + STATUS_COLORS[color] + '"></span><span>' + text + '</span>';
  }

  function showStatus(html, type, autoHide) {
    type = type || 'info';
    if (autoHide === undefined) autoHide = true;

    dom.statusMessage.innerHTML = html;
    dom.statusMessage.className = 'alert ' + type;
    dom.statusMessage.classList.remove('hidden');

    if (autoHide && type !== 'error') {
      setTimeout(() => dom.statusMessage.classList.add('hidden'), 8000);
    }
  }

  function updateProgress(percent, text) {
    dom.progressFill.style.width = percent + '%';
    if (text) dom.progressText.textContent = text;
  }

  const padCache = new Map();
  function padNumber(num, format, total) {
    total = total || 0;
    const key = num + '|' + format + '|' + total;
    if (padCache.has(key)) return padCache.get(key);

    let result;
    if (format === 'auto') {
      const digits = Math.max(2, String(total).length);
      result = String(num).padStart(digits, '0');
    } else {
      const digitMap = { '1digit': 1, '2digit': 2, '3digit': 3, '4digit': 4 };
      const digits = digitMap[format] || 3;
      result = String(num).padStart(digits, '0');
    }

    if (padCache.size > 1000) padCache.clear();
    padCache.set(key, result);
    return result;
  }

  function getFileExtension(url, mimeType) {
    mimeType = mimeType || '';

    if (mimeType) {
      const type = mimeType.split(';')[0].trim().toLowerCase();
      if (MIME_MAP[type]) return MIME_MAP[type];
    }

    if (!url.startsWith('blob:')) {
      try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.includes('.png')) return '.png';
        if (pathname.includes('.webp')) return '.webp';
        if (pathname.includes('.jpg') || pathname.includes('.jpeg')) return '.jpg';
      } catch (e) {
        // Ignore
      }
    }

    return '.jpg';
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim() || 'manhwa-chapter';
  }

  function base64ToBlob(base64, mimeType) {
    mimeType = mimeType || 'image/jpeg';
    const byteString = atob(base64);
    const len = byteString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = byteString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  async function fetchImageViaContentScript(url) {
    const response = await chrome.tabs.sendMessage(state.activeTabId, {
      action: 'FETCH_IMAGE',
      url: url,
    });

    if (!response || !response.success) {
      throw new Error((response && response.error) || 'Fetch failed');
    }

    if (!response.data) throw new Error('Invalid response');

    return {
      blob: base64ToBlob(response.data, response.mimeType),
      mimeType: response.mimeType,
    };
  }

  async function fetchImageViaBackground(url) {
    const response = await chrome.runtime.sendMessage({
      action: 'FETCH_IMAGE',
      url: url,
    });

    if (!response || !response.success) {
      throw new Error((response && response.error) || 'Fetch failed');
    }

    if (!response.data) throw new Error('Invalid response');

    return {
      blob: base64ToBlob(response.data, response.mimeType),
      mimeType: response.mimeType,
    };
  }

  async function fetchSingleImage(url, maxRetry) {
    maxRetry = maxRetry || 2;

    if (state.blobCache.has(url)) {
      const cached = state.blobCache.get(url);
      return { blob: cached.blob, mimeType: cached.mimeType };
    }

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        let result;

        if (url.startsWith('blob:')) {
          // blob: URL hanya bisa dibaca dari halaman yang membuatnya
          result = await fetchImageViaContentScript(url);
        } else {
          // HTTP(S): utamakan background worker (host_permissions → bebas CORS)
          try {
            result = await fetchImageViaBackground(url);
          } catch (bgErr) {
            // Fallback: fetch langsung dari popup
            try {
              const response = await fetch(url, {
                mode: 'cors',
                credentials: 'include',
                headers: { 'Accept': 'image/webp,image/png,image/jpeg,image/*' },
              });
              if (!response.ok) throw new Error('HTTP ' + response.status);
              const blob = await response.blob();
              result = { blob: blob, mimeType: blob.type };
            } catch (fetchErr) {
              // Fallback terakhir: lewat content script
              result = await fetchImageViaContentScript(url);
            }
          }
        }

        state.blobCache.set(url, result);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetry) await sleep(400 * (attempt + 1));
      }
    }

    throw lastError || new Error('Fetch failed');
  }

  function deduplicateUrls(urls) {
    const seen = new Set();
    const unique = [];
    const len = urls.length;
    for (let i = 0; i < len; i++) {
      if (!seen.has(urls[i])) {
        seen.add(urls[i]);
        unique.push(urls[i]);
      }
    }
    return unique;
  }

  function updateFormatHint() {
    if (!dom.formatHint) return;

    const format = dom.namingFormat.value;
    const total = state.scannedImages.length;

    if (total === 0) {
      const hints = {
        'auto': 'Auto-detect digit count',
        '1digit': 'Example: 1.jpg, 2.jpg, 3.jpg',
        '2digit': 'Example: 01.jpg, 02.jpg, 03.jpg',
        '3digit': 'Example: 001.jpg, 002.jpg',
        '4digit': 'Example: 0001.jpg, 0002.jpg',
      };
      dom.formatHint.textContent = hints[format] || '';
      dom.formatHint.classList.remove('active');
      return;
    }

    const first = padNumber(1, format, total);
    const last = padNumber(total, format, total);

    if (format === 'auto') {
      const digits = Math.max(2, String(total).length);
      dom.formatHint.textContent = '✨ ' + digits + '-digit → ' + first + ' to ' + last;
    } else {
      dom.formatHint.textContent = 'Preview: ' + first + ' → ' + last;
    }
    dom.formatHint.classList.add('active');
  }

  /* ══════════════════════════════════════
     Storage
     ══════════════════════════════════════ */

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      const settings = result[STORAGE_KEYS.SETTINGS];
      if (settings) {
        if (settings.namingFormat) dom.namingFormat.value = settings.namingFormat;
        if (settings.scanSpeed) dom.scanSpeed.value = settings.scanSpeed;
        if (settings.imageSelector) dom.imageSelector.value = settings.imageSelector;
        if (dom.askSaveLocation && typeof settings.askSaveLocation === 'boolean') {
          dom.askSaveLocation.checked = settings.askSaveLocation;
        }
                if (dom.useSubfolder && typeof settings.useSubfolder === 'boolean') {
          dom.useSubfolder.checked = settings.useSubfolder;
        }
      }
    } catch (e) {
      // Silent
    }
  }

  const saveSettings = (function () {
    let timeoutId;
    return function () {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        try {
          await chrome.storage.local.set({
            [STORAGE_KEYS.SETTINGS]: {
              namingFormat: dom.namingFormat.value,
              scanSpeed: dom.scanSpeed.value,
              imageSelector: dom.imageSelector.value,
              askSaveLocation: (dom.askSaveLocation && dom.askSaveLocation.checked) || false,
              useSubfolder: (dom.useSubfolder && dom.useSubfolder.checked) || false
            },
          });
        } catch (e) {
          // Silent
        }
      }, 500);
    };
  })();

  /* ══════════════════════════════════════
     Progress Listener
     ══════════════════════════════════════ */

  state.messageListener = function (message) {
    if (message.action === 'SCAN_PROGRESS' && state.isScanning) {
      const data = message.data;
      const phase = data.phase;
      const percent = data.percent;
      const collected = data.collected;
      const current = data.current;
      const total = data.total;
      const msg = data.message;

      const phaseText = { discovery: 'Discovery', capture: 'Capturing' }[phase] || phase;
      dom.scanPhase.textContent = phaseText;

      if (phase === 'capture' && current && total) {
        dom.scanCollected.textContent = collected + ' / ' + total;
      } else {
        dom.scanCollected.textContent = String(collected);
      }

      dom.scanProgressFill.style.width = percent + '%';
      dom.scanPercent.textContent = percent + '%';
      dom.scanMessage.textContent = msg || '';
    }
  };
  chrome.runtime.onMessage.addListener(state.messageListener);

  /* ══════════════════════════════════════
     Scan
     ══════════════════════════════════════ */

  async function scanImages() {
    if (state.isScanning || state.isDownloading) return;

    state.isScanning = true;
    state.blobCache.clear();
    padCache.clear();
    setAppStatus('Scanning', 'warning');

    dom.btnScan.disabled = true;
    dom.btnScan.classList.add('hidden');
    dom.btnStop.classList.remove('hidden');
    if (dom.btnTestScroll) dom.btnTestScroll.style.display = 'none';
    dom.scanProgress.classList.remove('hidden');
    dom.previewArea.classList.add('hidden');
    dom.btnDownload.classList.add('hidden');
    dom.statusMessage.classList.add('hidden');
    dom.progressBar.classList.add('hidden');

    dom.scanPhase.textContent = 'Starting';
    dom.scanCollected.textContent = '0';
    dom.scanProgressFill.style.width = '0%';
    dom.scanPercent.textContent = '0%';
    dom.scanMessage.textContent = 'Preparing...';

    let scanSuccess = false;

    try {
      const response = await sendToContentScript({
        action: 'SCAN_IMAGES',
        customSelector: dom.imageSelector.value.trim(),
        speed: dom.scanSpeed.value,
      });

      if (!response) throw new Error('No response from content script');

      if (!response.success && (response.count === 0 || !response.images)) {
        throw new Error(response.error || 'Scan failed');
      }

      const rawImages = Array.isArray(response.images) ? response.images : [];
      state.scannedImages = deduplicateUrls(rawImages);

      if (!dom.chapterName.value.trim() && response.title) {
        dom.chapterName.value = response.title;
      }

      dom.imageCount.textContent = state.scannedImages.length + ' image' + (state.scannedImages.length !== 1 ? 's' : '');

      if (state.scannedImages.length > 0) {
        scanSuccess = true;
        precomputeFilenames();
        updateFormatHint();

        dom.scanProgress.classList.add('hidden');
        dom.previewArea.classList.remove('hidden');
        renderPreview();

        setAppStatus(state.scannedImages.length + ' found', 'success');

        const blobCount = state.scannedImages.filter(u => u.startsWith('blob:')).length;
        const httpCount = state.scannedImages.length - blobCount;
        const totalDetected = response.total || state.scannedImages.length;
        const missed = totalDetected - state.scannedImages.length;
        const dupsRemoved = rawImages.length - state.scannedImages.length;

        let scanMsg;
        if (response.stopped) {
          scanMsg = '<b>Scan stopped.</b> Captured <b>' + state.scannedImages.length + '</b> images.';
        } else if (missed > 0) {
          scanMsg = '⚠️ <b>Captured ' + state.scannedImages.length + '/' + totalDetected + '</b> images';
        } else {
          scanMsg = '✅ <b>Perfect!</b> <b>' + state.scannedImages.length + '</b> images captured';
        }

        if (dupsRemoved > 0) scanMsg += '<br><small>🔄 ' + dupsRemoved + ' duplicate(s) removed</small>';
        if (blobCount > 0) scanMsg += '<br><small>🔒 ' + blobCount + ' blob + ' + httpCount + ' HTTP</small>';
        scanMsg += '<br><small>⚡ Auto-downloading...</small>';

        showStatus(scanMsg, missed > 0 ? 'warning' : 'success', false);

        state.isScanning = false;
        dom.btnScan.classList.remove('hidden');
        dom.btnStop.classList.add('hidden');
        if (dom.btnTestScroll) dom.btnTestScroll.style.display = 'block';

        await sleep(300);
        await downloadAndZip();

      } else {
        setAppStatus('No images', 'danger');
        showStatus('<b>No images found.</b> Check console (F12) for details.', 'error');
      }
    } catch (error) {
      setAppStatus('Error', 'danger');
      showStatus('<b>Error:</b> ' + error.message, 'error');
      console.error('[ManhwaDL] Scan error:', error);
    } finally {
      if (state.isScanning) {
        state.isScanning = false;
        dom.btnScan.disabled = false;
        dom.btnScan.classList.remove('hidden');
        dom.btnStop.classList.add('hidden');
        if (dom.btnTestScroll) dom.btnTestScroll.style.display = 'block';
        dom.scanProgress.classList.add('hidden');
      }

      dom.btnScan.disabled = false;

      if (scanSuccess && state.scannedImages.length > 0) {
        dom.btnDownload.classList.remove('hidden');
        dom.btnDownload.disabled = false;
        const btnDownloadText = dom.btnDownload.querySelector('.btn-text span:last-child');
        if (btnDownloadText) btnDownloadText.textContent = 'Download Again';
      }
    }
  }

  function precomputeFilenames() {
    const format = dom.namingFormat.value;
    const total = state.scannedImages.length;
    state.filenameCache = new Array(total);

    for (let i = 0; i < total; i++) {
      state.filenameCache[i] = padNumber(i + 1, format, total);
    }
  }

  async function stopScan() {
    if (!state.isScanning) return;

    dom.btnStop.disabled = true;
    const stopText = dom.btnStop.querySelector('span:last-child');
    if (stopText) stopText.textContent = 'Stopping...';

    try {
      await chrome.tabs.sendMessage(state.activeTabId, { action: 'STOP_SCAN' });
    } catch (e) {
      // Ignore
    }

    setTimeout(() => {
      dom.btnStop.disabled = false;
      if (stopText) stopText.textContent = 'Stop';
    }, 1000);
  }

  async function testScroll() {
    setAppStatus('Testing', 'info');
    try {
      const result = await sendToContentScript({ action: 'TEST_SCROLL' });

      if (result && result.success) {
        const success = result.moved > 100;
        const info = '<b>Scroll Compatibility Test</b><br><br>' +
          '📦 Container: <code>' + result.containerType + '</code><br>' +
          '📏 Total height: <b>' + result.scrollHeight + 'px</b><br>' +
          '📐 Max scroll: <b>' + result.maxScrollY + 'px</b><br>' +
          '🎯 Test moved: <b>' + result.moved + 'px</b><br><br>' +
          (success ? '✅ <b>Compatible!</b>' : '❌ <b>Not compatible.</b>');
        showStatus(info, success ? 'success' : 'error');
        setAppStatus(success ? 'Compatible' : 'Not compatible', success ? 'success' : 'danger');
      }
    } catch (error) {
      showStatus('<b>Test failed:</b> ' + error.message, 'error');
      setAppStatus('Error', 'danger');
    }
  }

  /* ══════════════════════════════════════
     Preview
     ══════════════════════════════════════ */

  function renderPreview() {
    dom.previewGrid.innerHTML = '';

    if (state.lazyObserver) {
      state.lazyObserver.disconnect();
      state.lazyObserver = null;
    }

    state.lazyObserver = new IntersectionObserver((entries) => {
      const len = entries.length;
      for (let i = 0; i < len; i++) {
        const entry = entries[i];
        if (entry.isIntersecting) {
          const img = entry.target;
          const realSrc = img.dataset.realSrc;
          if (realSrc) {
            img.src = realSrc;
            img.removeAttribute('data-real-src');
            state.lazyObserver.unobserve(img);
          }
        }
      }
    }, {
      root: dom.previewGrid,
      rootMargin: '100px',
      threshold: 0.01,
    });

    const limit = Math.min(state.scannedImages.length, PREVIEW_INITIAL_LIMIT);
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < limit; i++) {
      fragment.appendChild(createThumbnail(i));
    }

    dom.previewGrid.appendChild(fragment);

    if (state.scannedImages.length > limit) {
      dom.previewGrid.appendChild(createMoreButton(limit));
    }
  }

  function createThumbnail(index) {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';

    const img = document.createElement('img');
    const url = state.scannedImages[index];

    if (url.startsWith('blob:')) {
      img.src = PLACEHOLDERS.blob;
    } else {
      img.src = PLACEHOLDERS.loading;
      img.dataset.realSrc = url;
      img.onerror = () => { img.src = PLACEHOLDERS.error; };
      state.lazyObserver.observe(img);
    }

    img.loading = 'lazy';
    img.alt = 'Page ' + (index + 1);
    img.decoding = 'async';

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = (state.filenameCache && state.filenameCache[index]) || padNumber(index + 1, dom.namingFormat.value, state.scannedImages.length);

    thumb.append(img, idx);
    return thumb;
  }

  function createMoreButton(startIdx) {
    const more = document.createElement('div');
    more.className = 'preview-thumb';
    more.style.cssText = 'display:flex;align-items:center;justify-content:center;background:var(--color-surface-3);font-size:var(--font-size-md);color:var(--color-text-2);font-weight:700;cursor:pointer;';
    more.textContent = '+' + (state.scannedImages.length - startIdx);
    more.title = 'Click to load all';

    more.addEventListener('click', () => {
      more.remove();
      const loadRest = () => {
        const fragment = document.createDocumentFragment();
        const len = state.scannedImages.length;
        for (let i = startIdx; i < len; i++) {
          fragment.appendChild(createThumbnail(i));
        }
        dom.previewGrid.appendChild(fragment);
      };

      if ('requestIdleCallback' in window) {
        requestIdleCallback(loadRest);
      } else {
        setTimeout(loadRest, 0);
      }
    });

    return more;
  }

  /* ══════════════════════════════════════
     Download & ZIP
     ══════════════════════════════════════ */

  async function downloadAndZip() {
    if (state.isDownloading || state.scannedImages.length === 0) return;

    state.isDownloading = true;
    setAppStatus('Downloading', 'info');

    const format = dom.namingFormat.value;
    const total = state.scannedImages.length;
    const chapterName = sanitizeFilename(dom.chapterName.value || 'manhwa-chapter');

    dom.btnDownload.classList.remove('hidden');
    dom.btnDownload.disabled = true;
    dom.btnScan.disabled = true;
    dom.btnText.classList.add('hidden');
    dom.btnLoading.classList.remove('hidden');
    dom.progressBar.classList.remove('hidden');

    updateProgress(0, 'Starting...');

    const zip = new JSZip();
    const folder = zip.folder(chapterName);

    let completed = 0;
    let failed = 0;
    let addedToZip = 0;
    const failedUrls = [];

    const startTime = performance.now();

    try {
      const batchSize = total > 100 ? 12 : total > 50 ? 10 : 8;

      let currentIndex = 0;
      const active = new Set();
      let lastProgressUpdate = 0;

      const processNext = () => {
        while (currentIndex < total && active.size < batchSize) {
          const idx = currentIndex++;
          const url = state.scannedImages[idx];

          const task = (async () => {
            try {
              const result = await fetchSingleImage(url, 2);
              const blob = result.blob;
              const mimeType = result.mimeType;
              const ext = getFileExtension(url, mimeType);
              const pageNum = (state.filenameCache && state.filenameCache[idx]) || padNumber(idx + 1, format, total);
              const filename = pageNum + ext;

              folder.file(filename, blob);
              addedToZip++;
              completed++;
            } catch (err) {
              failed++;
              failedUrls.push({ index: idx, url: url, error: err.message });
              console.error('[ManhwaDL] ❌ [' + (idx + 1) + ']:', err.message);
            }

            active.delete(task);
          })();

          active.add(task);
        }
      };

      while (currentIndex < total || active.size > 0) {
        processNext();

        if (active.size > 0) {
          await Promise.race(active);

          const now = performance.now();
          if (now - lastProgressUpdate > 100) {
            const pct = Math.round((completed / total) * 70);
            updateProgress(pct, '⚡ ' + completed + '/' + total);
            lastProgressUpdate = now;
          }
        }
      }

      await Promise.all(active);
      updateProgress(70, '⚡ ' + completed + '/' + total);

      if (failedUrls.length > 0) {
        updateProgress(72, '🔄 Retrying ' + failedUrls.length + '...');

        const retryPromises = failedUrls.map(async (item) => {
          try {
            const result = await fetchSingleImage(item.url, 3);
            const blob = result.blob;
            const mimeType = result.mimeType;
            const ext = getFileExtension(item.url, mimeType);
            const pageNum = (state.filenameCache && state.filenameCache[item.index]) || padNumber(item.index + 1, format, total);
            folder.file(pageNum + ext, blob);
            addedToZip++;
            failed--;
          } catch (e) {
            // Silent
          }
        });

        await Promise.all(retryPromises);
      }

      if (addedToZip === 0) throw new Error('All images failed to download.');

      updateProgress(80, '⚡ Packing ZIP...');

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE',
          streamFiles: true,
        },
        (meta) => {
          const zipPct = 80 + Math.round(meta.percent * 0.2);
          updateProgress(zipPct, '⚡ Packing ' + Math.round(meta.percent) + '%');
        }
      );

      updateProgress(100, 'Saving...');
      const blobUrl = URL.createObjectURL(zipBlob);
      const filename = chapterName + '.zip';

      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_ZIP',
        dataUrl: blobUrl,
        filename: filename,
        saveAs: (dom.askSaveLocation && dom.askSaveLocation.checked) || false,
        useSubfolder: (dom.useSubfolder && dom.useSubfolder.checked) || false,
      });

      setAppStatus('Downloaded', 'success');

      const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);

      let msg;
      if (failed > 0) {
        const failedNumbers = failedUrls.slice(0, 5).map(f => f.index + 1);
        msg = '⚠️ <b>Downloaded ' + addedToZip + '/' + total + '</b> images<br>';
        msg += '<small>❌ Failed: pages ' + failedNumbers.join(', ') + (failed > 5 ? '...' : '') + '</small><br>';
        msg += '<small>⚡ ' + totalTime + 's • 📦 <code>' + filename + '</code></small>';
      } else {
        msg = '✅ <b>Perfect!</b> All ' + total + ' images saved in <b>' + totalTime + 's</b><br>';
        msg += '<small>📦 <code>' + filename + '</code> • 💾 ' + (zipBlob.size / (1024 * 1024)).toFixed(1) + ' MB</small>';
      }

      showStatus(msg, failed > 0 ? 'warning' : 'success', false);

    } catch (error) {
      setAppStatus('Error', 'danger');
      showStatus('<b>Download failed:</b> ' + error.message, 'error');
      console.error('[ManhwaDL] Download error:', error);
    } finally {
      state.isDownloading = false;
      dom.btnDownload.disabled = false;
      dom.btnScan.disabled = false;
      dom.btnText.classList.remove('hidden');
      dom.btnLoading.classList.add('hidden');
      dom.progressBar.classList.add('hidden');
      updateProgress(0, '');

      const btnDownloadText = dom.btnDownload.querySelector('.btn-text span:last-child');
      if (btnDownloadText) btnDownloadText.textContent = 'Download Again';
    }
  }

  /* ══════════════════════════════════════
     Events
     ══════════════════════════════════════ */

  dom.btnScan.addEventListener('click', scanImages);
  dom.btnStop.addEventListener('click', stopScan);
  if (dom.btnTestScroll) dom.btnTestScroll.addEventListener('click', testScroll);
  dom.btnDownload.addEventListener('click', downloadAndZip);

  dom.btnToggle.addEventListener('click', () => {
    const isHidden = dom.previewGrid.classList.toggle('hidden');
    dom.toggleText.textContent = isHidden ? 'Show' : 'Hide';
    dom.btnToggle.classList.toggle('active', !isHidden);
  });

  dom.namingFormat.addEventListener('change', () => {
    updateFormatHint();
    if (state.scannedImages.length > 0) {
      precomputeFilenames();
      renderPreview();
    }
    saveSettings();
  });

  dom.scanSpeed.addEventListener('change', saveSettings);
  dom.imageSelector.addEventListener('change', saveSettings);
  if (dom.askSaveLocation) {
    dom.askSaveLocation.addEventListener('change', saveSettings);
  }  if (dom.useSubfolder) {
    dom.useSubfolder.addEventListener('change', saveSettings);
  }


  /* ══════════════════════════════════════
     Cleanup
     ══════════════════════════════════════ */

  window.addEventListener('beforeunload', () => {
    if (state.lazyObserver) {
      state.lazyObserver.disconnect();
      state.lazyObserver = null;
    }

    if (state.messageListener) {
      chrome.runtime.onMessage.removeListener(state.messageListener);
    }

    if (state.batchMessageListener) {
      chrome.runtime.onMessage.removeListener(state.batchMessageListener);
    }

    state.blobCache.clear();
    padCache.clear();
  });

  /* ══════════════════════════════════════
     Init Single Mode
     ══════════════════════════════════════ */

  (async function init() {
    await loadSettings();

    try {
      const res = await sendToContentScript({ action: 'GET_TITLE' });
      if (res && res.success && res.title) {
        dom.chapterName.value = res.title;
      }
      setAppStatus('Ready', 'success');
    } catch (e) {
      setAppStatus('No access', 'warning');
    }

    updateFormatHint();
  })();

  /* ══════════════════════════════════════
     BATCH MODE - background-driven
     (loop jalan di service worker → tetap jalan walau popup ditutup)
     ══════════════════════════════════════ */

  function initBatchMode() {
    const batchDom = {
      tabs: document.querySelectorAll('.tab'),
      tabContents: document.querySelectorAll('.tab-content'),
      batchType: $('batchType'),
      batchNext: $('batchNext'),
      batchListSection: $('batchListSection'),
      batchPattern: $('batchPattern'),
      nextCount: $('nextCount'),
      chapterDelay: $('chapterDelay'),
      nextSelector: $('nextSelector'),
      urlList: $('urlList'),
      urlListCount: $('urlListCount'),
      urlPattern: $('urlPattern'),
      patternStart: $('patternStart'),
      patternEnd: $('patternEnd'),
      patternPreview: $('patternPreview'),
      mergeZip: $('mergeZip'),
      skipErrors: $('skipErrors'),
      btnBatchStart: $('btnBatchStart'),
      btnBatchStop: $('btnBatchStop'),
      batchProgress: $('batchProgress'),
      batchOverallText: $('batchOverallText'),
      batchOverallPercent: $('batchOverallPercent'),
      batchOverallFill: $('batchOverallFill'),
      batchCurrentTitle: $('batchCurrentTitle'),
      batchCurrentStatus: $('batchCurrentStatus'),
      batchCurrentFill: $('batchCurrentFill'),
      batchItemsList: $('batchItemsList'),
      batchStatusMessage: $('batchStatusMessage'),
    };

    if (batchDom.tabs.length === 0) {
      console.error('[Batch] ❌ No tabs found! Check HTML structure.');
      return;
    }

    const batchState = {
      isRunning: false,
      currentChapter: 0,
      totalChapters: 0,
      successCount: 0,
      failedCount: 0,
    };

    const BATCH_ICONS = { waiting: '⏸', active: '⏳', success: '✅', error: '❌' };
    const BATCH_STATUS_TEXT = { waiting: 'Waiting', active: 'Running', success: 'Done', error: 'Failed' };

    /* ----- Tab switching ----- */
    batchDom.tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetTab = tab.dataset.tab;
        if (!targetTab) return;
        batchDom.tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        batchDom.tabContents.forEach((c) => c.classList.remove('active'));
        const targetContent = document.getElementById('tab' + targetTab.charAt(0).toUpperCase() + targetTab.slice(1));
        if (targetContent) targetContent.classList.add('active');
      });
    });

    /* ----- Batch type switching ----- */
    if (batchDom.batchType) {
      batchDom.batchType.addEventListener('change', () => {
        const type = batchDom.batchType.value;
        if (batchDom.batchNext) batchDom.batchNext.classList.toggle('hidden', type !== 'next');
        if (batchDom.batchListSection) batchDom.batchListSection.classList.toggle('hidden', type !== 'list');
        if (batchDom.batchPattern) batchDom.batchPattern.classList.toggle('hidden', type !== 'pattern');
      });
    }

    /* ----- URL list counter ----- */
    if (batchDom.urlList && batchDom.urlListCount) {
      batchDom.urlList.addEventListener('input', () => {
        const urls = batchDom.urlList.value.split('\n').filter((u) => u.trim().startsWith('http'));
        batchDom.urlListCount.textContent = urls.length + ' URL' + (urls.length !== 1 ? 's' : '');
        batchDom.urlListCount.classList.toggle('active', urls.length > 0);
      });
    }

    /* ----- Pattern preview ----- */
    const updatePatternPreview = () => {
      if (!batchDom.urlPattern || !batchDom.patternPreview) return;
      const pattern = batchDom.urlPattern.value.trim();
      const start = parseInt(batchDom.patternStart.value, 10) || 1;
      const end = parseInt(batchDom.patternEnd.value, 10) || 10;
      if (!pattern || !pattern.includes('{n}')) {
        batchDom.patternPreview.textContent = 'Include {n} in the pattern';
        batchDom.patternPreview.classList.remove('active');
        return;
      }
      if (end < start) {
        batchDom.patternPreview.textContent = 'End must be >= Start';
        batchDom.patternPreview.classList.remove('active');
        return;
      }
      const count = end - start + 1;
      batchDom.patternPreview.innerHTML =
        '<b>' + count + ' URLs</b><br>First: <code>' + pattern.replace('{n}', start) + '</code><br>Last: <code>' + pattern.replace('{n}', end) + '</code>';
      batchDom.patternPreview.classList.add('active');
    };
    if (batchDom.urlPattern) batchDom.urlPattern.addEventListener('input', updatePatternPreview);
    if (batchDom.patternStart) batchDom.patternStart.addEventListener('input', updatePatternPreview);
    if (batchDom.patternEnd) batchDom.patternEnd.addEventListener('input', updatePatternPreview);

    /* ----- UI helpers ----- */
    function showBatchStatus(html, type, autoHide) {
      type = type || 'info';
      if (autoHide === undefined) autoHide = true;
      if (!batchDom.batchStatusMessage) return;
      batchDom.batchStatusMessage.innerHTML = html;
      batchDom.batchStatusMessage.className = 'alert ' + type;
      batchDom.batchStatusMessage.classList.remove('hidden');
      if (autoHide && type !== 'error') {
        setTimeout(() => batchDom.batchStatusMessage.classList.add('hidden'), 8000);
      }
    }

    function updateBatchProgress() {
      const percent = batchState.totalChapters > 0
        ? Math.round((batchState.currentChapter / batchState.totalChapters) * 100)
        : 0;
      if (batchDom.batchOverallText) batchDom.batchOverallText.textContent = batchState.currentChapter + '/' + batchState.totalChapters + ' chapters';
      if (batchDom.batchOverallPercent) batchDom.batchOverallPercent.textContent = percent + '%';
      if (batchDom.batchOverallFill) batchDom.batchOverallFill.style.width = percent + '%';
    }

    function updateBatchCurrent(title, status, percent) {
      if (batchDom.batchCurrentTitle) batchDom.batchCurrentTitle.textContent = title || 'Preparing...';
      if (batchDom.batchCurrentStatus) batchDom.batchCurrentStatus.textContent = status || '-';
      if (batchDom.batchCurrentFill) batchDom.batchCurrentFill.style.width = (percent || 0) + '%';
    }

    function renderBatchList(chapters) {
      if (!batchDom.batchItemsList) return;
      batchDom.batchItemsList.innerHTML = '';
      const frag = document.createDocumentFragment();
      chapters.forEach((chapter, i) => {
        const item = document.createElement('div');
        const status = chapter.status || 'waiting';
        item.className = 'batch-item ' + status;
        item.id = 'batch-item-' + i;
        const imgs = chapter.images ? ' (' + chapter.images + ' imgs)' : '';
        item.innerHTML =
          '<div class="batch-item-icon">' + (BATCH_ICONS[status] || '⏸') + '</div>' +
          '<div class="batch-item-title">' + (chapter.title || ('Chapter ' + (i + 1))) + imgs + '</div>' +
          '<div class="batch-item-status">' + (BATCH_STATUS_TEXT[status] || 'Waiting') + '</div>';
        frag.appendChild(item);
      });
      batchDom.batchItemsList.appendChild(frag);
    }

    function applyBatchState(s) {
      if (!s) return;
      batchState.isRunning = !!s.isRunning;
      batchState.currentChapter = s.currentChapter || 0;
      batchState.totalChapters = s.totalChapters || 0;
      batchState.successCount = s.successCount || 0;
      batchState.failedCount = s.failedCount || 0;
      updateBatchProgress();
      updateBatchCurrent(s.currentTitle, s.currentStatus, s.currentPercent);
      if (s.chapters && s.chapters.length) renderBatchList(s.chapters);
      if (s.isRunning) {
        batchDom.btnBatchStart.classList.add('hidden');
        batchDom.btnBatchStop.classList.remove('hidden');
        batchDom.batchProgress.classList.remove('hidden');
        setAppStatus('Batch running', 'warning');
      }
    }

    /* ----- Messages dari background ----- */
    function onBatchMessage(message) {
      if (message.action === 'BATCH_PROGRESS') {
        applyBatchState(message.data);
      } else if (message.action === 'BATCH_COMPLETE') {
        const s = message.data || {};
        applyBatchState(s);
        batchState.isRunning = false;
        batchDom.btnBatchStart.classList.remove('hidden');
        batchDom.btnBatchStop.classList.add('hidden');

        let msg;
        if (s.stopRequested) {
          msg = '⏹ <b>Batch stopped</b><br><small>✅ ' + s.successCount + ' success • ❌ ' + s.failedCount + ' failed</small>';
          setAppStatus('Stopped', 'warning');
        } else if (!s.failedCount) {
          msg = '✅ <b>Batch complete!</b> ' + s.successCount + '/' + s.totalChapters + ' chapters';
          if (s.mergeZip) msg += '<br><small>📦 Merged into single ZIP</small>';
          setAppStatus('Batch done', 'success');
        } else {
          msg = '⚠️ <b>Batch done with errors</b><br><small>✅ ' + s.successCount + ' success • ❌ ' + s.failedCount + ' failed</small>';
          setAppStatus('Done with errors', 'warning');
        }
        showBatchStatus(msg, !s.failedCount ? 'success' : 'warning', false);
      }
    }
    chrome.runtime.onMessage.addListener(onBatchMessage);
    state.batchMessageListener = onBatchMessage;

    /* ----- Start / Stop ----- */
    function buildBatchConfig() {
      const type = batchDom.batchType.value;
      const config = {
        type,
        scanSpeed: dom.scanSpeed.value,
        imageSelector: dom.imageSelector.value.trim(),
        namingFormat: dom.namingFormat.value,
        chapterDelay: parseInt(batchDom.chapterDelay && batchDom.chapterDelay.value, 10) || 3,
        mergeZip: batchDom.mergeZip.checked,
        skipErrors: batchDom.skipErrors.checked,
        saveAs: (dom.askSaveLocation && dom.askSaveLocation.checked) || false,
        useSubfolder: (dom.useSubfolder && dom.useSubfolder.checked) || false,
      };
      if (type === 'next') {
        config.count = parseInt(batchDom.nextCount.value, 10) || 1;
        config.nextSelector = batchDom.nextSelector.value.trim();
      } else if (type === 'list') {
        config.urls = batchDom.urlList.value.split('\n').map((u) => u.trim()).filter((u) => u.startsWith('http'));
        if (!config.urls.length) throw new Error('No valid URLs provided');
      } else if (type === 'pattern') {
        const pattern = batchDom.urlPattern.value.trim();
        const start = parseInt(batchDom.patternStart.value, 10) || 1;
        const end = parseInt(batchDom.patternEnd.value, 10) || 10;
        if (!pattern || !pattern.includes('{n}')) throw new Error('Pattern must include {n}');
        if (end < start) throw new Error('End must be >= Start');
        config.urls = [];
        for (let i = start; i <= end; i++) config.urls.push(pattern.replace('{n}', i));
      }
      return config;
    }

    async function startBatch() {
      if (batchState.isRunning) return;
      try {
        const config = buildBatchConfig();
        batchState.isRunning = true;
        batchDom.btnBatchStart.classList.add('hidden');
        batchDom.btnBatchStop.classList.remove('hidden');
        batchDom.batchProgress.classList.remove('hidden');
        batchDom.batchStatusMessage.classList.add('hidden');
        setAppStatus('Batch running', 'warning');
        const res = await chrome.runtime.sendMessage({ action: 'START_BATCH', config });
        if (res && res.success === false) {
          throw new Error(res.error || 'Failed to start batch');
        }
      } catch (e) {
        batchState.isRunning = false;
        batchDom.btnBatchStart.classList.remove('hidden');
        batchDom.btnBatchStop.classList.add('hidden');
        setAppStatus('Error', 'danger');
        showBatchStatus('❌ <b>Batch failed:</b> ' + e.message, 'error', false);
        console.error('[Batch] Error:', e);
      }
    }

    async function stopBatch() {
      try { await chrome.runtime.sendMessage({ action: 'STOP_BATCH' }); } catch (e) { /* ignore */ }
    }

    if (batchDom.btnBatchStart) batchDom.btnBatchStart.addEventListener('click', startBatch);
    if (batchDom.btnBatchStop) batchDom.btnBatchStop.addEventListener('click', stopBatch);

    /* ----- Restore UI jika batch masih jalan (popup dibuka lagi) ----- */
    chrome.runtime.sendMessage({ action: 'GET_BATCH_STATE' })
      .then((res) => { if (res && res.state && res.state.isRunning) applyBatchState(res.state); })
      .catch(() => {});

    updatePatternPreview();
    console.log('[Batch] ✅ Initialized (background-driven)');
  }

  // Initialize batch mode after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBatchMode);
  } else {
    initBatchMode();
  }

})();
