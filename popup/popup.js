/**
 * Popup Controller - Manhwa Downloader v3.1
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
    scannedMeta: [],
    blobCache: new Map(),
    isDownloading: false,
    isScanning: false,
    activeTabId: null,
    lazyObserver: null,
    filenameCache: null,
    messageListener: null,
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

  function arrayToBlob(dataArray, mimeType) {
    mimeType = mimeType || 'image/jpeg';
    return new Blob([new Uint8Array(dataArray)], { type: mimeType });
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
      blob: arrayToBlob(response.data, response.mimeType),
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
          result = await fetchImageViaContentScript(url);
        } else {
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
            result = await fetchImageViaContentScript(url);
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
      state.scannedMeta = Array.isArray(response.meta) ? response.meta : [];

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

      const downloadTime = ((performance.now() - startTime) / 1000).toFixed(1);

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
      });

      setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);

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
     BATCH MODE - FIXED
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

    console.log('[Batch] Tabs found:', batchDom.tabs.length);
    console.log('[Batch] Tab contents found:', batchDom.tabContents.length);

    if (batchDom.tabs.length === 0) {
      console.error('[Batch] ❌ No tabs found! Check HTML structure.');
      return;
    }

    const batchState = {
      isRunning: false,
      stopRequested: false,
      currentChapter: 0,
      totalChapters: 0,
      successCount: 0,
      failedCount: 0,
      allChapters: [],
    };

    /* ══════════════════════════════════════
       Tab Switching
       ══════════════════════════════════════ */

    batchDom.tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetTab = tab.dataset.tab;
        console.log('[Tab] Switching to:', targetTab);

        if (!targetTab) return;

        batchDom.tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        batchDom.tabContents.forEach(c => c.classList.remove('active'));

        const targetId = 'tab' + targetTab.charAt(0).toUpperCase() + targetTab.slice(1);
        const targetContent = document.getElementById(targetId);

        if (targetContent) {
          targetContent.classList.add('active');
          console.log('[Tab] ✅ Activated:', targetId);
        }
      });
    });

    /* ══════════════════════════════════════
       Batch Type Switching
       ══════════════════════════════════════ */

    if (batchDom.batchType) {
      batchDom.batchType.addEventListener('change', () => {
        const type = batchDom.batchType.value;
        if (batchDom.batchNext) batchDom.batchNext.classList.toggle('hidden', type !== 'next');
        if (batchDom.batchListSection) batchDom.batchListSection.classList.toggle('hidden', type !== 'list');
        if (batchDom.batchPattern) batchDom.batchPattern.classList.toggle('hidden', type !== 'pattern');
      });
    }

    /* ══════════════════════════════════════
       URL List Counter
       ══════════════════════════════════════ */

    if (batchDom.urlList && batchDom.urlListCount) {
      batchDom.urlList.addEventListener('input', () => {
        const urls = batchDom.urlList.value.split('\n').filter(u => u.trim().startsWith('http'));
        batchDom.urlListCount.textContent = urls.length + ' URL' + (urls.length !== 1 ? 's' : '');
        batchDom.urlListCount.classList.toggle('active', urls.length > 0);
      });
    }

    /* ══════════════════════════════════════
       Pattern Preview
       ══════════════════════════════════════ */

    const updatePatternPreview = () => {
      if (!batchDom.urlPattern || !batchDom.patternPreview) return;

      const pattern = batchDom.urlPattern.value.trim();
      const start = parseInt(batchDom.patternStart.value) || 1;
      const end = parseInt(batchDom.patternEnd.value) || 10;

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
      const firstUrl = pattern.replace('{n}', start);
      const lastUrl = pattern.replace('{n}', end);

      batchDom.patternPreview.innerHTML = '<b>' + count + ' URLs</b><br>First: <code>' + firstUrl + '</code><br>Last: <code>' + lastUrl + '</code>';
      batchDom.patternPreview.classList.add('active');
    };

    if (batchDom.urlPattern) batchDom.urlPattern.addEventListener('input', updatePatternPreview);
    if (batchDom.patternStart) batchDom.patternStart.addEventListener('input', updatePatternPreview);
    if (batchDom.patternEnd) batchDom.patternEnd.addEventListener('input', updatePatternPreview);

    /* ══════════════════════════════════════
       Batch Helpers
       ══════════════════════════════════════ */

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
      const percent = Math.round((batchState.currentChapter / batchState.totalChapters) * 100);
      if (batchDom.batchOverallText) batchDom.batchOverallText.textContent = batchState.currentChapter + '/' + batchState.totalChapters + ' chapters';
      if (batchDom.batchOverallPercent) batchDom.batchOverallPercent.textContent = percent + '%';
      if (batchDom.batchOverallFill) batchDom.batchOverallFill.style.width = percent + '%';
    }

    function updateBatchCurrent(title, status, percent) {
      percent = percent || 0;
      if (batchDom.batchCurrentTitle) batchDom.batchCurrentTitle.textContent = title;
      if (batchDom.batchCurrentStatus) batchDom.batchCurrentStatus.textContent = status;
      if (batchDom.batchCurrentFill) batchDom.batchCurrentFill.style.width = percent + '%';
    }

    function renderBatchList(chapters) {
      if (!batchDom.batchItemsList) return;
      batchDom.batchItemsList.innerHTML = '';
      const fragment = document.createDocumentFragment();

      chapters.forEach((chapter, i) => {
        const item = document.createElement('div');
        item.className = 'batch-item waiting';
        item.id = 'batch-item-' + i;
        item.innerHTML =
          '<div class="batch-item-icon">⏸</div>' +
          '<div class="batch-item-title">' + (chapter.title || 'Chapter ' + (i + 1)) + '</div>' +
          '<div class="batch-item-status">Waiting</div>';
        fragment.appendChild(item);
      });

      batchDom.batchItemsList.appendChild(fragment);
    }

    function updateBatchItem(index, status, statusText, images) {
      images = images || 0;
      const item = document.getElementById('batch-item-' + index);
      if (!item) return;

      const icons = {
        waiting: '⏸',
        active: '⏳',
        success: '✅',
        error: '❌',
      };

      item.className = 'batch-item ' + status;
      item.querySelector('.batch-item-icon').textContent = icons[status] || '?';
      item.querySelector('.batch-item-status').textContent = statusText;

      if (images > 0) {
        const titleEl = item.querySelector('.batch-item-title');
        if (!titleEl.textContent.includes('imgs)')) {
          titleEl.textContent += ' (' + images + ' imgs)';
        }
      }
    }

    /* ══════════════════════════════════════
       Get Batch URLs
       ══════════════════════════════════════ */

    async function getBatchUrls() {
      const type = batchDom.batchType.value;

      if (type === 'next') {
        const tab = await getActiveTab();
        const count = parseInt(batchDom.nextCount.value) || 1;
        return {
          type: 'next',
          startUrl: tab.url,
          count: count,
          selector: batchDom.nextSelector.value.trim(),
        };
      }

      if (type === 'list') {
        const urls = batchDom.urlList.value
          .split('\n')
          .map(u => u.trim())
          .filter(u => u.startsWith('http'));

        if (urls.length === 0) throw new Error('No valid URLs provided');
        return { type: 'list', urls: urls };
      }

      if (type === 'pattern') {
        const pattern = batchDom.urlPattern.value.trim();
        const start = parseInt(batchDom.patternStart.value) || 1;
        const end = parseInt(batchDom.patternEnd.value) || 10;

        if (!pattern || !pattern.includes('{n}')) {
          throw new Error('Pattern must include {n}');
        }

        if (end < start) throw new Error('End must be >= Start');

        const urls = [];
        for (let i = start; i <= end; i++) {
          urls.push(pattern.replace('{n}', i));
        }

        return { type: 'pattern', urls: urls };
      }

      throw new Error('Unknown batch type');
    }

    /* ══════════════════════════════════════
       ✅ FIXED: Wait for tab to fully load
       ══════════════════════════════════════ */

    async function waitForTabLoad(tabId, timeout) {
      timeout = timeout || 45000;
      const startTime = Date.now();

      // Wait for tab status = complete
      while (Date.now() - startTime < timeout) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') {
            break;
          }
        } catch (e) {
          // Tab might be updating
        }
        await sleep(300);
      }

      if (Date.now() - startTime >= timeout) {
        throw new Error('Tab load timeout');
      }

      // Extra wait for JavaScript execution
      await sleep(2000);

      return true;
    }

    /* ══════════════════════════════════════
       ✅ NEW: Ensure content script ready
       ══════════════════════════════════════ */

    async function ensureContentScriptReady(tabId, maxRetry) {
      maxRetry = maxRetry || 5;

      for (let attempt = 0; attempt < maxRetry; attempt++) {
        try {
          // Try to inject
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content/content.js'],
          });

          // Wait for it to initialize
          await sleep(500);

          // Test communication
          const testResponse = await Promise.race([
            chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
          ]);

          if (testResponse && testResponse.success) {
            console.log('[Batch] ✅ Content script ready (attempt ' + (attempt + 1) + ')');
            return true;
          }
        } catch (e) {
          console.warn('[Batch] Content script not ready, retry ' + (attempt + 1) + '/' + maxRetry + ':', e.message);
          await sleep(1000);
        }
      }

      throw new Error('Content script failed to initialize after ' + maxRetry + ' attempts');
    }

    /* ══════════════════════════════════════
       ✅ FIXED: Process single chapter
       ══════════════════════════════════════ */

    async function processSingleChapter(url, index, mergeZip) {
      updateBatchItem(index, 'active', 'Loading...');
      updateBatchCurrent(url, 'Loading page', 0);

      // Clear cache untuk chapter baru
      state.blobCache.clear();
      padCache.clear();

      try {
        // Get current tab
        const tab = await getActiveTab();
        const tabId = tab.id;

        // Update activeTabId
        state.activeTabId = tabId;

        console.log('[Batch] Chapter ' + (index + 1) + ' - Navigating to:', url);

        // Navigate to new URL
        await chrome.tabs.update(tabId, { url: url });

        // Wait for page to load
        updateBatchCurrent(url, 'Waiting for page load...', 10);
        await waitForTabLoad(tabId);

        // Ensure content script is READY
        updateBatchCurrent(url, 'Preparing content script...', 15);
        await ensureContentScriptReady(tabId);

        // Update activeTabId AGAIN
        state.activeTabId = tabId;

        // Get chapter title
        let chapterTitle = 'Chapter-' + (index + 1);
        try {
          const titleRes = await chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' });
          if (titleRes && titleRes.title) {
            chapterTitle = titleRes.title;
          }
        } catch (e) {
          console.warn('[Batch] Could not get title, using default');
        }

        // Ensure unique title with index prefix
        const uniqueTitle = String(index + 1).padStart(3, '0') + '-' + chapterTitle;

        updateBatchCurrent(uniqueTitle, 'Scanning images...', 20);
        updateBatchItem(index, 'active', 'Scanning');

        // Scan images
        const scanRes = await chrome.tabs.sendMessage(tabId, {
          action: 'SCAN_IMAGES',
          customSelector: dom.imageSelector.value.trim(),
          speed: dom.scanSpeed.value,
        });

        if (!scanRes || !scanRes.success || !scanRes.images || !scanRes.images.length) {
          throw new Error((scanRes && scanRes.error) || 'No images found on page');
        }

        const images = deduplicateUrls(scanRes.images);

        updateBatchCurrent(uniqueTitle, images.length + ' images found', 40);
        updateBatchItem(index, 'active', images.length + ' imgs');

        const format = dom.namingFormat.value;
        const total = images.length;

        const zip = new JSZip();
        const folderName = sanitizeFilename(uniqueTitle);
        const folder = zip.folder(folderName);

        let completed = 0;
        let failed = 0;
        const batchSize = 6;
        let currentIdx = 0;
        const active = new Set();
        const failedList = [];

        const processNext = () => {
          while (currentIdx < total && active.size < batchSize) {
            const idx = currentIdx++;
            const imgUrl = images[idx];

            const task = (async () => {
              try {
                const result = await fetchSingleImage(imgUrl, 2);
                const blob = result.blob;
                const mimeType = result.mimeType;
                const ext = getFileExtension(imgUrl, mimeType);
                const pageNum = padNumber(idx + 1, format, total);
                folder.file(pageNum + ext, blob);
                completed++;
              } catch (e) {
                failed++;
                failedList.push({ index: idx, url: imgUrl });
                console.error('[Batch] Failed image ' + (idx + 1) + ':', e.message);
              }
              active.delete(task);
            })();

            active.add(task);
          }
        };

        while (currentIdx < total || active.size > 0) {
          processNext();
          if (active.size > 0) {
            await Promise.race(active);
            const pct = 40 + Math.round((completed / total) * 40);
            updateBatchCurrent(uniqueTitle, 'Downloading ' + completed + '/' + total, pct);
          }
        }

        await Promise.all(active);

        // Retry failed
        if (failedList.length > 0) {
          updateBatchCurrent(uniqueTitle, 'Retrying ' + failedList.length + '...', 80);

          const retryPromises = failedList.map(async (item) => {
            try {
              const result = await fetchSingleImage(item.url, 3);
              const blob = result.blob;
              const mimeType = result.mimeType;
              const ext = getFileExtension(item.url, mimeType);
              const pageNum = padNumber(item.index + 1, format, total);
              folder.file(pageNum + ext, blob);
              completed++;
              failed--;
            } catch (e) {
              console.error('[Batch] Retry failed:', item.index + 1);
            }
          });

          await Promise.all(retryPromises);
        }

        updateBatchCurrent(uniqueTitle, 'Creating ZIP...', 90);

        // Validate ZIP has files
        const zipFileCount = Object.keys(zip.files).filter(name => !zip.files[name].dir).length;
        if (zipFileCount === 0) {
          throw new Error('No images downloaded successfully');
        }

        if (mergeZip) {
          batchState.allChapters.push({
            title: folderName,
            zip: zip,
          });

          updateBatchItem(index, 'success', completed + '✓', completed);
          return { success: true, images: completed, failed: failed };
        }

        // Generate ZIP for individual chapter
        const zipBlob = await zip.generateAsync(
          { type: 'blob', compression: 'STORE', streamFiles: true }
        );

        const blobUrl = URL.createObjectURL(zipBlob);
        const filename = folderName + '.zip';

        console.log('[Batch] Downloading:', filename);

        await chrome.runtime.sendMessage({
          action: 'DOWNLOAD_ZIP',
          dataUrl: blobUrl,
          filename: filename,
          saveAs: (dom.askSaveLocation && dom.askSaveLocation.checked) || false,
        });

        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

        updateBatchItem(index, 'success', completed + '✓', completed);
        console.log('[Batch] ✅ Chapter ' + (index + 1) + ' complete: ' + completed + ' images');

        return { success: true, images: completed, failed: failed };

      } catch (error) {
        console.error('[Batch] ❌ Chapter ' + (index + 1) + ' failed:', error);
        updateBatchItem(index, 'error', error.message.substring(0, 30));
        throw error;
      }
    }

    /* ══════════════════════════════════════
       ✅ FIXED: Find and click next chapter
       ══════════════════════════════════════ */

    async function findAndClickNext(tabId, customSelector) {
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (selector) => {
            const selectors = selector
              ? [selector]
              : [
                  'a.next-chapter',
                  'a.btn-next-chapter',
                  '.next-chapter',
                  '.btn-next',
                  'a[rel="next"]',
                  '.chapter-next',
                  '#next-chapter',
                  '.next',
                  'a.next',
                  '[class*="next"][class*="chapter"] a',
                  '[class*="next"][class*="chapter"]',
                  'a[href*="next"]',
                  'a[title*="Next"]',
                  'a[aria-label*="Next"]',
                  '.reader-nav .next',
                  '.chapter-nav .next',
                  '#nextch',
                  '.nextch',
                ];

            for (const sel of selectors) {
              try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                  const href = el.href || el.getAttribute('href');
                  if (href && href !== '#' && href !== 'javascript:void(0)') {
                    try {
                      const absoluteUrl = new URL(href, window.location.href).href;
                      return {
                        success: true,
                        url: absoluteUrl,
                        selector: sel,
                      };
                    } catch (e) {
                      continue;
                    }
                  }
                }

                const el = document.querySelector(sel);
                if (el) {
                  el.click();
                  return {
                    success: true,
                    clicked: true,
                    selector: sel,
                  };
                }
              } catch (e) {
                continue;
              }
            }

            return {
              success: false,
              error: 'No next chapter button found',
            };
          },
          args: [customSelector],
        });

        return result[0] && result[0].result;
      } catch (e) {
        console.error('[Batch] findAndClickNext error:', e);
        return { success: false, error: e.message };
      }
    }

    /* ══════════════════════════════════════
       ✅ FIXED: Start batch download
       ══════════════════════════════════════ */

    async function startBatch() {
      if (batchState.isRunning) return;

      console.log('═══════════════════════════════════════════');
      console.log('[Batch] 🚀 STARTING BATCH DOWNLOAD');
      console.log('═══════════════════════════════════════════');

      try {
        const config = await getBatchUrls();
        console.log('[Batch] Config:', config);

        const mergeZip = batchDom.mergeZip.checked;
        const skipErrors = batchDom.skipErrors.checked;
        const delay = (parseInt(batchDom.chapterDelay && batchDom.chapterDelay.value) || 3) * 1000;

        let urlsList = [];

        if (config.type === 'next') {
          urlsList = [config.startUrl];
          for (let i = 1; i < config.count; i++) {
            urlsList.push(null);
          }
        } else {
          urlsList = config.urls;
        }

        batchState.isRunning = true;
        batchState.stopRequested = false;
        batchState.currentChapter = 0;
        batchState.totalChapters = urlsList.length;
        batchState.successCount = 0;
        batchState.failedCount = 0;
        batchState.allChapters = [];

        batchDom.btnBatchStart.classList.add('hidden');
        batchDom.btnBatchStop.classList.remove('hidden');
        batchDom.batchProgress.classList.remove('hidden');
        batchDom.batchStatusMessage.classList.add('hidden');

        setAppStatus('Batch running', 'warning');

        const chapters = urlsList.map((url, i) => ({
          title: url || 'Chapter ' + (i + 1),
          url: url,
        }));
        renderBatchList(chapters);
        updateBatchProgress();

        for (let i = 0; i < urlsList.length; i++) {
          if (batchState.stopRequested) {
            showBatchStatus('⏹ <b>Batch stopped by user</b>', 'info', false);
            break;
          }

          batchState.currentChapter = i + 1;
          updateBatchProgress();

          let currentUrl = urlsList[i];

          // Next chapter detection
          if (config.type === 'next' && i > 0 && !currentUrl) {
            updateBatchCurrent('Finding next chapter...', 'Detecting URL', 5);

            try {
              const tab = await getActiveTab();
              state.activeTabId = tab.id;

              // Ensure content script ready before finding next
              await ensureContentScriptReady(tab.id);

              const nextResult = await findAndClickNext(tab.id, config.selector);

              if (!nextResult || !nextResult.success) {
                updateBatchItem(i, 'error', 'No next chapter');
                batchState.failedCount++;
                if (!skipErrors) break;
                continue;
              }

              currentUrl = nextResult.url;

              // If clicked, wait for navigation
              if (!currentUrl && nextResult.clicked) {
                updateBatchCurrent('Waiting for navigation...', 'Loading', 8);
                await sleep(3000);
                const tab2 = await getActiveTab();
                currentUrl = tab2.url;
              }

              if (!currentUrl) {
                throw new Error('Could not determine next chapter URL');
              }

              urlsList[i] = currentUrl;
              console.log('[Batch] Next chapter URL:', currentUrl);
            } catch (e) {
              console.error('[Batch] Next detection failed:', e);
              updateBatchItem(i, 'error', 'Detection failed');
              batchState.failedCount++;
              if (!skipErrors) break;
              continue;
            }
          }

          if (!currentUrl) {
            updateBatchItem(i, 'error', 'No URL');
            batchState.failedCount++;
            if (!skipErrors) break;
            continue;
          }

          console.log('[Batch] ═══ Processing chapter ' + (i + 1) + '/' + urlsList.length + ' ═══');
          console.log('[Batch] URL:', currentUrl);

          try {
            const result = await processSingleChapter(currentUrl, i, mergeZip);
            console.log('[Batch] Chapter ' + (i + 1) + ' result:', result);

            if (result.success) {
              batchState.successCount++;
            } else {
              batchState.failedCount++;
              if (!skipErrors) break;
            }

            // Delay with countdown
            if (i < urlsList.length - 1 && delay > 0) {
              const delaySeconds = Math.round(delay / 1000);

              for (let s = delaySeconds; s > 0; s--) {
                if (batchState.stopRequested) break;
                updateBatchCurrent('Waiting for next chapter...', s + 's remaining', 100);
                await sleep(1000);
              }
            }

          } catch (error) {
            batchState.failedCount++;
            if (!skipErrors) {
              showBatchStatus('❌ <b>Batch stopped:</b> ' + error.message, 'error', false);
              break;
            }
          }
        }

        // Handle merge mode
        if (mergeZip && batchState.allChapters.length > 0 && !batchState.stopRequested) {
          updateBatchCurrent('Merging chapters...', 'Creating combined ZIP', 90);

          const megaZip = new JSZip();

          for (const chapter of batchState.allChapters) {
            const files = Object.keys(chapter.zip.files);
            for (const filename of files) {
              const file = chapter.zip.files[filename];
              if (!file.dir) {
                const data = await file.async('blob');
                megaZip.file(filename, data);
              }
            }
          }

          const mergedBlob = await megaZip.generateAsync(
            { type: 'blob', compression: 'STORE', streamFiles: true }
          );

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const mergedFilename = 'manhwa-batch-' + timestamp + '.zip';

          const blobUrl = URL.createObjectURL(mergedBlob);
          await chrome.runtime.sendMessage({
            action: 'DOWNLOAD_ZIP',
            dataUrl: blobUrl,
            filename: mergedFilename,
            saveAs: (dom.askSaveLocation && dom.askSaveLocation.checked) || false,
          });

          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

          updateBatchCurrent('Complete!', 'Merged ZIP saved', 100);
        }

        // Final status
        let msg;
        if (batchState.stopRequested) {
          msg = '⏹ <b>Batch stopped</b><br>';
          msg += '<small>✅ ' + batchState.successCount + ' success • ❌ ' + batchState.failedCount + ' failed</small>';
          setAppStatus('Stopped', 'warning');
        } else if (batchState.failedCount === 0) {
          msg = '✅ <b>Batch complete!</b> ' + batchState.successCount + '/' + batchState.totalChapters + ' chapters<br>';
          if (mergeZip) msg += '<small>📦 Merged into single ZIP</small>';
          setAppStatus('Batch done', 'success');
        } else {
          msg = '⚠️ <b>Batch done with errors</b><br>';
          msg += '<small>✅ ' + batchState.successCount + ' success • ❌ ' + batchState.failedCount + ' failed</small>';
          setAppStatus('Done with errors', 'warning');
        }

        showBatchStatus(msg, batchState.failedCount === 0 ? 'success' : 'warning', false);

        console.log('═══════════════════════════════════════════');
        console.log('[Batch] 🏁 BATCH COMPLETE');
        console.log('  ✅ Success: ' + batchState.successCount);
        console.log('  ❌ Failed: ' + batchState.failedCount);
        console.log('═══════════════════════════════════════════');

      } catch (error) {
        showBatchStatus('❌ <b>Batch failed:</b> ' + error.message, 'error', false);
        setAppStatus('Error', 'danger');
        console.error('[Batch] Error:', error);
      } finally {
        batchState.isRunning = false;
        batchDom.btnBatchStart.classList.remove('hidden');
        batchDom.btnBatchStop.classList.add('hidden');
      }
    }

    async function stopBatch() {
      if (!batchState.isRunning) return;

      batchState.stopRequested = true;
      batchDom.btnBatchStop.disabled = true;
      const stopText = batchDom.btnBatchStop.querySelector('span:last-child');
      if (stopText) stopText.textContent = 'Stopping...';

      try {
        await chrome.tabs.sendMessage(state.activeTabId, { action: 'STOP_SCAN' });
      } catch (e) {
        // Ignore
      }

      setTimeout(() => {
        batchDom.btnBatchStop.disabled = false;
        if (stopText) stopText.textContent = 'Stop';
      }, 1000);
    }

    // Bind Events
    if (batchDom.btnBatchStart) {
      batchDom.btnBatchStart.addEventListener('click', startBatch);
    }
    if (batchDom.btnBatchStop) {
      batchDom.btnBatchStop.addEventListener('click', stopBatch);
    }

    // Trigger initial preview
    updatePatternPreview();

    console.log('[Batch] ✅ Initialized successfully');
  }

  // Initialize batch mode after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBatchMode);
  } else {
    initBatchMode();
  }

})();
