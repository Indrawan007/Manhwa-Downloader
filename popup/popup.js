/**
 * Popup Controller - Manhwa Downloader v2.0
 * Optimized: streaming download, lazy preview, adaptive concurrency
 */

(() => {
  'use strict';

  /* ══════════════════════════════════════
     Constants
     ══════════════════════════════════════ */

  const STORAGE_KEYS = {
    SETTINGS: 'manhwaDL_settings',
  };

  const PLACEHOLDERS = {
    blob: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
      '<rect fill="#6c5ce7" width="60" height="80"/>' +
      '<text x="30" y="38" text-anchor="middle" fill="white" font-size="7" font-weight="bold">BLOB</text>' +
      '<text x="30" y="52" text-anchor="middle" fill="white" font-size="7" font-weight="bold">IMG</text></svg>'
    ),
    loading: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
      '<rect fill="#2d2d4f" width="60" height="80"/>' +
      '<circle cx="30" cy="40" r="8" fill="#6c5ce7" opacity="0.3"/></svg>'
    ),
    error: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
      '<rect fill="#2d2d4f" width="60" height="80"/>' +
      '<text x="30" y="44" text-anchor="middle" fill="#7a7a99" font-size="9" font-weight="bold">?</text></svg>'
    ),
  };

  const PREVIEW_INITIAL_LIMIT = 20;

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
    isDownloading: false,
    isScanning: false,
    activeTabId: null,
    lazyObserver: null,
  };

  /* ══════════════════════════════════════
     Storage (Settings Persistence)
     ══════════════════════════════════════ */

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      const settings = result[STORAGE_KEYS.SETTINGS];
      if (settings) {
        if (settings.namingFormat) dom.namingFormat.value = settings.namingFormat;
        if (settings.scanSpeed) dom.scanSpeed.value = settings.scanSpeed;
        if (settings.imageSelector) dom.imageSelector.value = settings.imageSelector;
      }
    } catch (error) {
      console.warn('[ManhwaDL] Load settings failed:', error);
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: {
          namingFormat: dom.namingFormat.value,
          scanSpeed: dom.scanSpeed.value,
          imageSelector: dom.imageSelector.value,
        },
      });
    } catch (error) {
      console.warn('[ManhwaDL] Save settings failed:', error);
    }
  }

  /* ══════════════════════════════════════
     Utilities
     ══════════════════════════════════════ */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
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
    } catch { /* already injected */ }

    return chrome.tabs.sendMessage(tab.id, message);
  }

  function setAppStatus(text, color = 'success') {
    const colors = {
      success: 'var(--color-success)',
      warning: 'var(--color-warning)',
      danger: 'var(--color-danger)',
      info: 'var(--color-info)',
    };

    dom.appStatus.innerHTML = `
      <span class="status-dot" style="background: ${colors[color]}"></span>
      <span>${text}</span>
    `;
  }

  function showStatus(html, type = 'info', autoHide = true) {
    dom.statusMessage.innerHTML = html;
    dom.statusMessage.className = `alert ${type}`;
    dom.statusMessage.classList.remove('hidden');

    if (autoHide && type !== 'error') {
      setTimeout(() => dom.statusMessage.classList.add('hidden'), 8000);
    }
  }

  function updateProgress(percent, text) {
    dom.progressFill.style.width = `${percent}%`;
    if (text) dom.progressText.textContent = text;
  }

  function padNumber(num, format, total = 0) {
    if (format === 'auto') {
      const digits = Math.max(2, String(total).length);
      return String(num).padStart(digits, '0');
    }

    const digitMap = { '1digit': 1, '2digit': 2, '3digit': 3, '4digit': 4 };
    const digits = digitMap[format] || 3;
    return String(num).padStart(digits, '0');
  }

  function getFileExtension(url, mimeType = '') {
    if (mimeType) {
      const type = mimeType.split(';')[0].trim().toLowerCase();
      if (type === 'image/png') return '.png';
      if (type === 'image/webp') return '.webp';
      if (type === 'image/jpeg' || type === 'image/jpg') return '.jpg';
    }

    try {
      if (!url.startsWith('blob:')) {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.includes('.png')) return '.png';
        if (pathname.includes('.webp')) return '.webp';
        if (pathname.includes('.jpg') || pathname.includes('.jpeg')) return '.jpg';
      }
    } catch { /* ignore */ }

    return '.jpg';
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim() || 'manhwa-chapter';
  }

  function arrayToBlob(dataArray, mimeType = 'image/jpeg') {
    return new Blob([new Uint8Array(dataArray)], { type: mimeType });
  }

  async function fetchImageViaContentScript(url) {
    const response = await chrome.tabs.sendMessage(state.activeTabId, {
      action: 'FETCH_IMAGE',
      url,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Fetch failed');
    }

    if (!response.data) throw new Error('Invalid response format');

    return {
      blob: arrayToBlob(response.data, response.mimeType),
      mimeType: response.mimeType,
    };
  }

  async function fetchSingleImage(url, maxRetry = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        if (url.startsWith('blob:')) {
          return await fetchImageViaContentScript(url);
        }

        try {
          const response = await fetch(url, {
            mode: 'cors',
            credentials: 'include',
            headers: { 'Accept': 'image/webp,image/png,image/jpeg,image/*' },
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const blob = await response.blob();
          return { blob, mimeType: blob.type };
        } catch {
          return await fetchImageViaContentScript(url);
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetry) {
          await sleep(400 * (attempt + 1));
        }
      }
    }

    throw lastError || new Error('Fetch failed');
  }

  function deduplicateUrls(urls) {
    const seen = new Set();
    const unique = [];

    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url);
        unique.push(url);
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
      dom.formatHint.textContent = `✨ ${digits}-digit → ${first} to ${last}`;
    } else {
      dom.formatHint.textContent = `Preview: ${first} → ${last}`;
    }
    dom.formatHint.classList.add('active');
  }

  /* ══════════════════════════════════════
     Progress Listener
     ══════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SCAN_PROGRESS' && state.isScanning) {
      const { phase, percent, collected, current, total, message: msg } = message.data;

      const phaseText = { discovery: 'Discovery', capture: 'Capturing' }[phase] || phase;
      dom.scanPhase.textContent = phaseText;

      if (phase === 'capture' && current && total) {
        dom.scanCollected.textContent = `${collected} / ${total}`;
      } else {
        dom.scanCollected.textContent = `${collected}`;
      }

      dom.scanProgressFill.style.width = `${percent}%`;
      dom.scanPercent.textContent = `${percent}%`;
      dom.scanMessage.textContent = msg || '';
    }
  });

  /* ══════════════════════════════════════
     Scan
     ══════════════════════════════════════ */

  async function scanImages() {
    if (state.isScanning || state.isDownloading) return;

    state.isScanning = true;
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

      dom.imageCount.textContent = `${state.scannedImages.length} image${state.scannedImages.length !== 1 ? 's' : ''}`;

      if (state.scannedImages.length > 0) {
        scanSuccess = true;
        updateFormatHint();

        dom.scanProgress.classList.add('hidden');
        dom.previewArea.classList.remove('hidden');
        renderPreview();

        setAppStatus(`${state.scannedImages.length} found`, 'success');

        const blobCount = state.scannedImages.filter(u => u.startsWith('blob:')).length;
        const httpCount = state.scannedImages.length - blobCount;
        const totalDetected = response.total || state.scannedImages.length;
        const missed = totalDetected - state.scannedImages.length;
        const dupsRemoved = rawImages.length - state.scannedImages.length;

        let scanMsg;
        if (response.stopped) {
          scanMsg = `<b>Scan stopped.</b> Captured <b>${state.scannedImages.length}</b> images.`;
        } else if (missed > 0) {
          scanMsg = `⚠️ <b>Captured ${state.scannedImages.length}/${totalDetected}</b> images`;
        } else {
          scanMsg = `✅ <b>Perfect!</b> <b>${state.scannedImages.length}</b> images captured`;
        }

        if (dupsRemoved > 0) scanMsg += `<br><small>🔄 ${dupsRemoved} duplicate(s) removed</small>`;
        if (blobCount > 0) scanMsg += `<br><small>🔒 ${blobCount} blob + ${httpCount} HTTP</small>`;
        scanMsg += `<br><small>⚡ Auto-downloading...</small>`;

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
      showStatus(`<b>Error:</b> ${error.message}`, 'error');
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

  async function stopScan() {
    if (!state.isScanning) return;

    dom.btnStop.disabled = true;
    const stopText = dom.btnStop.querySelector('span:last-child');
    if (stopText) stopText.textContent = 'Stopping...';

    try {
      await chrome.tabs.sendMessage(state.activeTabId, { action: 'STOP_SCAN' });
    } catch { /* ignore */ }

    setTimeout(() => {
      dom.btnStop.disabled = false;
      if (stopText) stopText.textContent = 'Stop';
    }, 1000);
  }

  async function testScroll() {
    setAppStatus('Testing', 'info');
    try {
      const result = await sendToContentScript({ action: 'TEST_SCROLL' });

      if (result?.success) {
        const success = result.moved > 100;
        const info = `
          <b>Scroll Compatibility Test</b><br><br>
          📦 Container: <code>${result.containerType}</code><br>
          📏 Total height: <b>${result.scrollHeight}px</b><br>
          📐 Max scroll: <b>${result.maxScrollY}px</b><br>
          🎯 Test moved: <b>${result.moved}px</b><br><br>
          ${success 
            ? '✅ <b>Compatible!</b> Auto-scroll will work.' 
            : '❌ <b>Not compatible.</b>'}
        `;
        showStatus(info, success ? 'success' : 'error');
        setAppStatus(success ? 'Compatible' : 'Not compatible', success ? 'success' : 'danger');
      }
    } catch (error) {
      showStatus(`<b>Test failed:</b> ${error.message}`, 'error');
      setAppStatus('Error', 'danger');
    }
  }

  /* ══════════════════════════════════════
     Preview (Optimized with Lazy Loading)
     ══════════════════════════════════════ */

  function renderPreview() {
    const format = dom.namingFormat.value;
    const total = state.scannedImages.length;
    dom.previewGrid.innerHTML = '';

    // Cleanup previous observer
    if (state.lazyObserver) {
      state.lazyObserver.disconnect();
    }

    // Create new IntersectionObserver
    state.lazyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const realSrc = img.dataset.realSrc;
          if (realSrc) {
            img.src = realSrc;
            img.removeAttribute('data-real-src');
            state.lazyObserver.unobserve(img);
          }
        }
      });
    }, {
      root: dom.previewGrid,
      rootMargin: '100px',
      threshold: 0.01,
    });

    const limit = Math.min(state.scannedImages.length, PREVIEW_INITIAL_LIMIT);
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < limit; i++) {
      fragment.appendChild(createThumbnail(i, format, total));
    }

    dom.previewGrid.appendChild(fragment);

    if (state.scannedImages.length > limit) {
      dom.previewGrid.appendChild(createMoreButton(limit, format, total));
    }
  }

  function createThumbnail(index, format, total) {
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
    img.alt = `Page ${index + 1}`;
    img.decoding = 'async';

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = padNumber(index + 1, format, total);

    thumb.append(img, idx);
    return thumb;
  }

  function createMoreButton(startIdx, format, total) {
    const more = document.createElement('div');
    more.className = 'preview-thumb';
    more.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-surface-3);
      font-size: var(--font-size-md);
      color: var(--color-text-2);
      font-weight: 700;
      cursor: pointer;
    `;
    more.textContent = `+${state.scannedImages.length - startIdx}`;
    more.title = 'Click to load all';

    more.addEventListener('click', () => {
      more.remove();
      const fragment = document.createDocumentFragment();
      for (let i = startIdx; i < state.scannedImages.length; i++) {
        fragment.appendChild(createThumbnail(i, format, total));
      }
      dom.previewGrid.appendChild(fragment);
    });

    return more;
  }

  /* ══════════════════════════════════════
     Download (Streaming Pipeline)
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
      // Adaptive concurrency
      const batchSize = total > 100 ? 10 : total > 50 ? 8 : 6;

      let currentIndex = 0;
      const active = new Set();

      const processNext = () => {
        while (currentIndex < total && active.size < batchSize) {
          const idx = currentIndex++;
          const url = state.scannedImages[idx];

          const task = (async () => {
            try {
              const { blob, mimeType } = await fetchSingleImage(url, 2);
              const ext = getFileExtension(url, mimeType);
              const pageNum = padNumber(idx + 1, format, total);
              const filename = `${pageNum}${ext}`;

              folder.file(filename, blob);
              addedToZip++;
              completed++;
            } catch (err) {
              failed++;
              failedUrls.push({ index: idx, url, error: err.message });
              console.error(`[ManhwaDL] ❌ [${idx + 1}]:`, err.message);
            }

            active.delete(task);
          })();

          active.add(task);
        }
      };

      // Streaming pipeline
      while (currentIndex < total || active.size > 0) {
        processNext();

        if (active.size > 0) {
          await Promise.race(active);
          const pct = Math.round((completed / total) * 70);
          updateProgress(pct, `⚡ ${completed}/${total}`);
        }
      }

      await Promise.all(active);

      // Retry failed (parallel)
      if (failedUrls.length > 0) {
        console.log(`[ManhwaDL] 🔄 Retrying ${failedUrls.length}...`);
        updateProgress(72, `🔄 Retrying ${failedUrls.length}...`);

        const retryPromises = failedUrls.map(async (item) => {
          try {
            const { blob, mimeType } = await fetchSingleImage(item.url, 3);
            const ext = getFileExtension(item.url, mimeType);
            const pageNum = padNumber(item.index + 1, format, total);
            folder.file(`${pageNum}${ext}`, blob);
            addedToZip++;
            failed--;
          } catch (err) {
            console.error(`[ManhwaDL] Retry failed [${item.index + 1}]`);
          }
        });

        await Promise.all(retryPromises);
      }

      const downloadTime = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`[ManhwaDL] 📊 ${addedToZip}/${total} in ${downloadTime}s`);

      if (addedToZip === 0) throw new Error('All images failed to download.');

      // Verify ZIP
      const zipFileList = Object.keys(zip.files).filter(name =>
        !zip.files[name].dir && name.startsWith(chapterName + '/')
      );

      console.log(`[ManhwaDL] 📦 ZIP files: ${zipFileList.length}`);

      updateProgress(80, '⚡ Packing ZIP...');

      const zipStartTime = performance.now();

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE',
          streamFiles: true,
        },
        (meta) => {
          const zipPct = 80 + Math.round(meta.percent * 0.2);
          updateProgress(zipPct, `⚡ Packing ${Math.round(meta.percent)}%`);
        }
      );

      const zipTime = ((performance.now() - zipStartTime) / 1000).toFixed(1);
      console.log(`[ManhwaDL] 📦 ZIP in ${zipTime}s (${(zipBlob.size / 1024 / 1024).toFixed(1)} MB)`);

      updateProgress(100, 'Saving...');
      const blobUrl = URL.createObjectURL(zipBlob);
      const filename = `${chapterName}.zip`;

      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_ZIP',
        dataUrl: blobUrl,
        filename,
      });

      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

      setAppStatus('Downloaded', 'success');

      const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);

      let msg;
      if (failed > 0) {
        const failedNumbers = failedUrls.slice(0, 5).map(f => f.index + 1);
        msg = `⚠️ <b>Downloaded ${addedToZip}/${total}</b> images<br>`;
        msg += `<small>❌ Failed: pages ${failedNumbers.join(', ')}${failed > 5 ? '...' : ''}</small><br>`;
        msg += `<small>⚡ ${totalTime}s • 📦 <code>${filename}</code></small>`;
      } else {
        msg = `✅ <b>Perfect!</b> All ${total} images saved in <b>${totalTime}s</b><br>`;
        msg += `<small>📦 <code>${filename}</code> • 💾 ${(zipBlob.size / (1024 * 1024)).toFixed(1)} MB</small>`;
      }

      showStatus(msg, failed > 0 ? 'warning' : 'success', false);

      console.log('═══════════════════════════════════════════');
      console.log('[ManhwaDL] 📊 PERFORMANCE:');
      console.log(`  Total: ${total} images`);
      console.log(`  Downloaded: ${addedToZip}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Total time: ${totalTime}s`);
      console.log(`  Avg per image: ${(parseFloat(totalTime) / total).toFixed(2)}s`);
      console.log(`  ZIP size: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);
      console.log('═══════════════════════════════════════════');

    } catch (error) {
      setAppStatus('Error', 'danger');
      showStatus(`<b>Download failed:</b> ${error.message}`, 'error');
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
    if (state.scannedImages.length > 0) renderPreview();
    saveSettings();
  });

  dom.scanSpeed.addEventListener('change', saveSettings);
  dom.imageSelector.addEventListener('change', saveSettings);

  /* ══════════════════════════════════════
     Init
     ══════════════════════════════════════ */

  (async function init() {
    await loadSettings();

    try {
      const res = await sendToContentScript({ action: 'GET_TITLE' });
      if (res?.success && res.title) {
        dom.chapterName.value = res.title;
      }
      setAppStatus('Ready', 'success');
    } catch {
      setAppStatus('No access', 'warning');
    }

    updateFormatHint();
  })();
})();
