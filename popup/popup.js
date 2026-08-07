/**
 * Popup Controller - Manhwa Downloader
 * Fixed version - No ReferenceError
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ── DOM Elements ── */
  const $appStatus      = $('appStatus');
  const $chapterName    = $('chapterName');
  const $namingFormat   = $('namingFormat');
  const $formatHint     = $('formatHint');
  const $scanSpeed      = $('scanSpeed');
  const $imageSelector  = $('imageSelector');
  const $btnScan        = $('btnScan');
  const $btnStop        = $('btnStop');
  const $btnTestScroll  = $('btnTestScroll');
  const $btnDownload    = $('btnDownload');
  const $btnToggle      = $('btnTogglePreview');
  const $toggleText     = $('toggleText');
  const $scanProgress   = $('scanProgress');
  const $scanPhase      = $('scanPhase');
  const $scanCollected  = $('scanCollected');
  const $scanProgressFill = $('scanProgressFill');
  const $scanPercent    = $('scanPercent');
  const $scanMessage    = $('scanMessage');
  const $previewArea    = $('previewArea');
  const $previewGrid    = $('previewGrid');
  const $imageCount     = $('imageCount');
  const $progressBar    = $('progressBar');
  const $progressFill   = $('progressFill');
  const $progressText   = $('progressText');
  const $statusMessage  = $('statusMessage');
  const $btnText        = document.querySelector('.btn-text');
  const $btnLoading     = document.querySelector('.btn-loading');

  /* ── State ── */
  let scannedImages = [];
  let scannedMeta = [];
  let isDownloading = false;
  let isScanning = false;
  let activeTabId = null;

  /* ══════════════════════════════════════
     Utilities
     ══════════════════════════════════════ */

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    return tab;
  }

  async function sendToContentScript(message) {
    const tab = await getActiveTab();
    activeTabId = tab.id;

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
      danger:  'var(--color-danger)',
      info:    'var(--color-info)',
    };

    $appStatus.innerHTML = `
      <span class="status-dot" style="background: ${colors[color]}"></span>
      <span>${text}</span>
    `;
  }

  function showStatus(html, type = 'info', autoHide = true) {
    $statusMessage.innerHTML = html;
    $statusMessage.className = `alert ${type}`;
    $statusMessage.classList.remove('hidden');

    if (autoHide && type !== 'error') {
      setTimeout(() => $statusMessage.classList.add('hidden'), 8000);
    }
  }

  function updateProgress(percent, text) {
    $progressFill.style.width = `${percent}%`;
    if (text) $progressText.textContent = text;
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
    const uint8Array = new Uint8Array(dataArray);
    return new Blob([uint8Array], { type: mimeType });
  }

  async function fetchImageViaContentScript(url) {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      action: 'FETCH_IMAGE',
      url,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Fetch failed');
    }

    if (response.data) {
      return {
        blob: arrayToBlob(response.data, response.mimeType),
        mimeType: response.mimeType,
      };
    }

    throw new Error('Invalid response format');
  }

  function updateFormatHint() {
    if (!$formatHint) return;

    const format = $namingFormat.value;
    const total = scannedImages.length;

    if (total === 0) {
      const hints = {
        'auto':   'Auto-detect digit count',
        '1digit': 'Example: 1.jpg, 2.jpg, 3.jpg',
        '2digit': 'Example: 01.jpg, 02.jpg, 03.jpg',
        '3digit': 'Example: 001.jpg, 002.jpg',
        '4digit': 'Example: 0001.jpg, 0002.jpg',
      };
      $formatHint.textContent = hints[format] || '';
      $formatHint.classList.remove('active');
      return;
    }

    const first = padNumber(1, format, total);
    const last = padNumber(total, format, total);

    if (format === 'auto') {
      const digits = Math.max(2, String(total).length);
      $formatHint.textContent = `✨ ${digits}-digit → ${first} to ${last}`;
      $formatHint.classList.add('active');
    } else {
      $formatHint.textContent = `Preview: ${first} → ${last}`;
      $formatHint.classList.add('active');
    }
  }

  function deduplicateUrls(urls) {
    const seen = new Set();
    const unique = [];
    let duplicates = 0;

    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url);
        unique.push(url);
      } else {
        duplicates++;
      }
    }

    if (duplicates > 0) {
      console.warn(`[ManhwaDL Popup] Removed ${duplicates} duplicate URLs`);
    }

    return unique;
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
        } catch (directError) {
          return await fetchImageViaContentScript(url);
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetry) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          console.warn(`[ManhwaDL] Retry ${attempt + 1}/${maxRetry} for:`, url);
        }
      }
    }

    throw lastError || new Error('Fetch failed after retries');
  }

  /* ══════════════════════════════════════
     Progress Listener
     ══════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SCAN_PROGRESS' && isScanning) {
      const { phase, percent, collected, current, total, message: msg } = message.data;

      const phaseText = {
        discovery: 'Discovery',
        capture:   'Capturing',
      }[phase] || phase;

      $scanPhase.textContent = phaseText;

      if (phase === 'capture' && current && total) {
        $scanCollected.textContent = `${collected} / ${total}`;
      } else {
        $scanCollected.textContent = `${collected}`;
      }

      $scanProgressFill.style.width = `${percent}%`;
      $scanPercent.textContent = `${percent}%`;
      $scanMessage.textContent = msg || '';
    }
  });

  /* ══════════════════════════════════════
     Scan + Auto Download
     ══════════════════════════════════════ */

  async function scanImages() {
    if (isScanning || isDownloading) return;

    isScanning = true;
    setAppStatus('Scanning', 'warning');

    $btnScan.disabled = true;
    $btnScan.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    if ($btnTestScroll) $btnTestScroll.style.display = 'none';
    $scanProgress.classList.remove('hidden');
    $previewArea.classList.add('hidden');
    $btnDownload.classList.add('hidden');
    $statusMessage.classList.add('hidden');
    $progressBar.classList.add('hidden');

    $scanPhase.textContent = 'Starting';
    $scanCollected.textContent = '0';
    $scanProgressFill.style.width = '0%';
    $scanPercent.textContent = '0%';
    $scanMessage.textContent = 'Preparing...';

    let scanSuccess = false;

    try {
      const response = await sendToContentScript({
        action: 'SCAN_IMAGES',
        customSelector: $imageSelector.value.trim(),
        speed: $scanSpeed.value,
      });

      if (!response) throw new Error('No response from content script');
      if (!response.success && (response.count === 0 || !response.images)) {
        throw new Error(response.error || 'Scan failed');
      }

      const rawImages = Array.isArray(response.images) ? response.images : [];
      scannedImages = deduplicateUrls(rawImages);
      scannedMeta = Array.isArray(response.meta) ? response.meta : [];

      if (!$chapterName.value.trim() && response.title) {
        $chapterName.value = response.title;
      }

      $imageCount.textContent = `${scannedImages.length} image${scannedImages.length !== 1 ? 's' : ''}`;

      if (scannedImages.length > 0) {
        scanSuccess = true;
        updateFormatHint();

        $scanProgress.classList.add('hidden');
        $previewArea.classList.remove('hidden');
        renderPreview();

        setAppStatus(`${scannedImages.length} found`, 'success');

        const blobCount = scannedImages.filter(u => u.startsWith('blob:')).length;
        const httpCount = scannedImages.length - blobCount;
        const totalDetected = response.total || scannedImages.length;
        const missed = totalDetected - scannedImages.length;
        const dupsRemoved = rawImages.length - scannedImages.length;

        let scanMsg;
        if (response.stopped) {
          scanMsg = `<b>Scan stopped.</b> Captured <b>${scannedImages.length}</b> images.`;
        } else if (missed > 0) {
          scanMsg = `⚠️ <b>Captured ${scannedImages.length}/${totalDetected}</b> unique images`;
        } else {
          scanMsg = `✅ <b>Perfect!</b> <b>${scannedImages.length}</b> unique images captured`;
        }

        if (dupsRemoved > 0) {
          scanMsg += `<br><small>🔄 ${dupsRemoved} duplicate(s) removed</small>`;
        }

        if (blobCount > 0) {
          scanMsg += `<br><small>🔒 ${blobCount} blob + ${httpCount} HTTP</small>`;
        }

        scanMsg += `<br><small>⚡ Auto-downloading...</small>`;
        showStatus(scanMsg, missed > 0 ? 'warning' : 'success', false);

        isScanning = false;
        $btnScan.classList.remove('hidden');
        $btnStop.classList.add('hidden');
        if ($btnTestScroll) $btnTestScroll.style.display = 'block';

        await new Promise(r => setTimeout(r, 300));
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
      if (isScanning) {
        isScanning = false;
        $btnScan.disabled = false;
        $btnScan.classList.remove('hidden');
        $btnStop.classList.add('hidden');
        if ($btnTestScroll) $btnTestScroll.style.display = 'block';
        $scanProgress.classList.add('hidden');
      }

      $btnScan.disabled = false;

      if (scanSuccess && scannedImages.length > 0) {
        $btnDownload.classList.remove('hidden');
        $btnDownload.disabled = false;
        const $btnDownloadText = $btnDownload.querySelector('.btn-text span:last-child');
        if ($btnDownloadText) {
          $btnDownloadText.textContent = 'Download Again';
        }
      }
    }
  }

  async function stopScan() {
    if (!isScanning) return;

    $btnStop.disabled = true;
    const $stopText = $btnStop.querySelector('span:last-child');
    if ($stopText) $stopText.textContent = 'Stopping...';

    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'STOP_SCAN' });
    } catch { /* ignore */ }

    setTimeout(() => {
      $btnStop.disabled = false;
      if ($stopText) $stopText.textContent = 'Stop';
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
     Preview
     ══════════════════════════════════════ */

/* ══════════════════════════════════════
   ⚡ OPTIMIZED Preview - Virtual Scrolling
   ══════════════════════════════════════ */

function renderPreview() {
  const format = $namingFormat.value;
  const total = scannedImages.length;
  $previewGrid.innerHTML = '';

  // ⚡ Only render first 20 thumbnails initially
  // Rest loaded on demand when user scrolls
  const initialLimit = 20;
  const limit = Math.min(scannedImages.length, initialLimit);

  // ⚡ Use IntersectionObserver untuk lazy load
  const lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const realSrc = img.dataset.realSrc;
        if (realSrc) {
          img.src = realSrc;
          img.removeAttribute('data-real-src');
          lazyObserver.unobserve(img);
        }
      }
    });
  }, {
    root: $previewGrid,
    rootMargin: '100px',
    threshold: 0.01,
  });

  // ⚡ Placeholder SVG (super lightweight)
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#2d2d4f" width="60" height="80"/>' +
    '<circle cx="30" cy="40" r="8" fill="#6c5ce7" opacity="0.3"/></svg>'
  );

  const blobPlaceholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#6c5ce7" width="60" height="80"/>' +
    '<text x="30" y="38" text-anchor="middle" fill="white" font-size="7" font-weight="bold">BLOB</text>' +
    '<text x="30" y="52" text-anchor="middle" fill="white" font-size="7" font-weight="bold">IMG</text></svg>'
  );

  const errorPlaceholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#2d2d4f" width="60" height="80"/>' +
    '<text x="30" y="44" text-anchor="middle" fill="#7a7a99" font-size="9" font-weight="bold">?</text></svg>'
  );

  // ⚡ Use DocumentFragment untuk batch DOM operations
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < limit; i++) {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';

    const img = document.createElement('img');
    const url = scannedImages[i];

    if (url.startsWith('blob:')) {
      // Blob URL: langsung tampilkan placeholder
      img.src = blobPlaceholder;
    } else {
      // HTTP: lazy load
      img.src = placeholder;
      img.dataset.realSrc = url;
      img.onerror = () => { img.src = errorPlaceholder; };
      lazyObserver.observe(img);
    }

    img.loading = 'lazy';
    img.alt = `Page ${i + 1}`;
    img.decoding = 'async';  // ⚡ Async decoding

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = padNumber(i + 1, format, total);

    thumb.append(img, idx);
    fragment.appendChild(thumb);
  }

  // ⚡ Single DOM update
  $previewGrid.appendChild(fragment);

  // Show "more" indicator
  if (scannedImages.length > limit) {
    const more = document.createElement('div');
    more.className = 'preview-thumb';
    more.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      background: var(--color-surface-3);
      font-size: var(--font-size-md);
      color: var(--color-text-2);
      font-weight: 700;
      cursor: pointer;
    `;
    more.textContent = `+${scannedImages.length - limit}`;
    more.title = 'Click to show all';

    // ⚡ Click to load rest
    more.addEventListener('click', () => {
      more.remove();
      renderRestOfPreview(limit, lazyObserver);
    });

    $previewGrid.appendChild(more);
  }
}

/**
 * ⚡ Render sisa preview on-demand
 */
function renderRestOfPreview(startIdx, lazyObserver) {
  const format = $namingFormat.value;
  const total = scannedImages.length;
  const fragment = document.createDocumentFragment();

  const blobPlaceholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#6c5ce7" width="60" height="80"/>' +
    '<text x="30" y="38" text-anchor="middle" fill="white" font-size="7" font-weight="bold">BLOB</text>' +
    '<text x="30" y="52" text-anchor="middle" fill="white" font-size="7" font-weight="bold">IMG</text></svg>'
  );

  const placeholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#2d2d4f" width="60" height="80"/></svg>'
  );

  const errorPlaceholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
    '<rect fill="#2d2d4f" width="60" height="80"/>' +
    '<text x="30" y="44" text-anchor="middle" fill="#7a7a99" font-size="9" font-weight="bold">?</text></svg>'
  );

  for (let i = startIdx; i < scannedImages.length; i++) {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';

    const img = document.createElement('img');
    const url = scannedImages[i];

    if (url.startsWith('blob:')) {
      img.src = blobPlaceholder;
    } else {
      img.src = placeholder;
      img.dataset.realSrc = url;
      img.onerror = () => { img.src = errorPlaceholder; };
      lazyObserver.observe(img);
    }

    img.loading = 'lazy';
    img.alt = `Page ${i + 1}`;
    img.decoding = 'async';

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = padNumber(i + 1, format, total);

    thumb.append(img, idx);
    fragment.appendChild(thumb);
  }

  $previewGrid.appendChild(fragment);
}

  /* ══════════════════════════════════════
     ✅ FIXED: Download & ZIP
     ══════════════════════════════════════ */

/* ══════════════════════════════════════
   ⚡ OPTIMIZED: Progressive Streaming Download
   ══════════════════════════════════════ */

async function downloadAndZip() {
  if (isDownloading || scannedImages.length === 0) return;

  isDownloading = true;
  setAppStatus('Downloading', 'info');

  const format = $namingFormat.value;
  const total = scannedImages.length;
  const chapterName = sanitizeFilename($chapterName.value || 'manhwa-chapter');

  $btnDownload.classList.remove('hidden');
  $btnDownload.disabled = true;
  $btnScan.disabled = true;
  $btnText.classList.add('hidden');
  $btnLoading.classList.remove('hidden');
  $progressBar.classList.remove('hidden');

  updateProgress(0, 'Starting...');

  const zip = new JSZip();
  const folder = zip.folder(chapterName);

  // ⚡ Track completion in real-time
  let completed = 0;
  let failed = 0;
  let addedToZip = 0;
  const failedUrls = [];

  console.log(`[ManhwaDL] ⚡ Starting optimized download of ${total} images...`);

  const startTime = performance.now();

  try {
    // ⚡ ADAPTIVE CONCURRENCY based on total count
    // Smaller batches = smoother progress, larger = faster
    const batchSize = total > 100 ? 10 : total > 50 ? 8 : 6;

    // ⚡ Priority queue: process in order but allow parallel
    let currentIndex = 0;
    const active = new Set();

    const processNext = async () => {
      while (currentIndex < total && active.size < batchSize) {
        const idx = currentIndex++;
        const url = scannedImages[idx];

        const task = (async () => {
          try {
            const { blob, mimeType } = await fetchSingleImage(url, 2);
            const ext = getFileExtension(url, mimeType);
            const pageNum = padNumber(idx + 1, format, total);
            const filename = `${pageNum}${ext}`;

            // ⚡ IMMEDIATELY add to ZIP (streaming)
            folder.file(filename, blob);
            addedToZip++;
            completed++;

            // Release memory reference (blob is now in ZIP)
            const size = blob.size;

            console.log(`[ManhwaDL] ✅ [${idx + 1}/${total}] ${filename} (${(size / 1024).toFixed(1)} KB)`);
          } catch (err) {
            failed++;
            failedUrls.push({ index: idx, url, error: err.message });
            console.error(`[ManhwaDL] ❌ [${idx + 1}/${total}]:`, err.message);
          }

          active.delete(task);
        })();

        active.add(task);
      }
    };

    // ⚡ Main loop: keep pipeline full
    while (currentIndex < total || active.size > 0) {
      await processNext();

      if (active.size > 0) {
        await Promise.race(active);

        // Update progress
        const pct = Math.round((completed / total) * 70);
        updateProgress(pct, `⚡ ${completed}/${total}`);
      }
    }

    // Wait untuk semua task selesai
    await Promise.all(active);

    // ⚡ RETRY failed (parallel juga)
    if (failedUrls.length > 0) {
      console.log(`[ManhwaDL] 🔄 Retrying ${failedUrls.length} failed...`);
      updateProgress(72, `🔄 Retrying ${failedUrls.length}...`);

      const retryPromises = failedUrls.map(async (failedItem) => {
        try {
          const { blob, mimeType } = await fetchSingleImage(failedItem.url, 3);
          const ext = getFileExtension(failedItem.url, mimeType);
          const pageNum = padNumber(failedItem.index + 1, format, total);
          const filename = `${pageNum}${ext}`;

          folder.file(filename, blob);
          addedToZip++;
          failed--;

          console.log(`[ManhwaDL] ✅ RETRY OK [${failedItem.index + 1}]`);
        } catch (err) {
          console.error(`[ManhwaDL] ❌ RETRY FAILED [${failedItem.index + 1}]`);
        }
      });

      await Promise.all(retryPromises);
    }

    const downloadTime = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`[ManhwaDL] 📊 Downloaded ${addedToZip}/${total} in ${downloadTime}s`);

    if (addedToZip === 0) {
      throw new Error('All images failed to download.');
    }

    // ⚡ Verify ZIP
    const zipFileList = Object.keys(zip.files).filter(name =>
      !zip.files[name].dir && name.startsWith(chapterName + '/')
    );

    console.log(`[ManhwaDL] 📦 ZIP files: ${zipFileList.length}`);

    updateProgress(80, '⚡ Packing ZIP...');

    // ⚡ OPTIMIZED ZIP GENERATION
    // STORE mode + streaming = fastest
    const zipStartTime = performance.now();

    const zipBlob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'STORE',
        streamFiles: true,  // ⚡ Stream mode - lower memory
      },
      (meta) => {
        const zipPct = 80 + Math.round(meta.percent * 0.2);
        updateProgress(zipPct, `⚡ Packing ${Math.round(meta.percent)}%`);
      }
    );

    const zipTime = ((performance.now() - zipStartTime) / 1000).toFixed(1);
    console.log(`[ManhwaDL] 📦 ZIP created in ${zipTime}s (${(zipBlob.size / 1024 / 1024).toFixed(1)} MB)`);
    // Di dalam downloadAndZip(), setelah success message
// Log performance summary
console.log('═══════════════════════════════════════════');
console.log('[ManhwaDL] 📊 PERFORMANCE SUMMARY:');
console.log(`  Total images: ${total}`);
console.log(`  Downloaded: ${addedToZip}`);
console.log(`  Failed: ${failed}`);
console.log(`  Download time: ${downloadTime}s`);
console.log(`  ZIP time: ${zipTime}s`);
console.log(`  Total time: ${totalTime}s`);
console.log(`  Avg per image: ${(parseFloat(totalTime) / total).toFixed(2)}s`);
console.log(`  ZIP size: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Throughput: ${(zipBlob.size / 1024 / parseFloat(totalTime)).toFixed(1)} KB/s`);
console.log('═══════════════════════════════════════════');


    updateProgress(100, 'Saving...');
    const blobUrl = URL.createObjectURL(zipBlob);
    const filename = `${chapterName}.zip`;

    await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_ZIP',
      dataUrl: blobUrl,
      filename,
    });

    // ⚡ Faster cleanup
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

    setAppStatus('Downloaded', 'success');

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);

    let msg;
    if (failed > 0) {
      const failedNumbers = failedUrls
        .slice(0, 5)
        .map(f => f.index + 1);
      msg = `⚠️ <b>Downloaded ${addedToZip}/${total}</b> images<br>`;
      msg += `<small>❌ Failed: pages ${failedNumbers.join(', ')}${failed > 5 ? '...' : ''}</small><br>`;
      msg += `<small>⚡ ${totalTime}s • 📦 <code>${filename}</code></small>`;
    } else {
      msg = `✅ <b>Perfect!</b> All ${total} images saved in <b>${totalTime}s</b><br>`;
      msg += `<small>📦 <code>${filename}</code> • 💾 ${(zipBlob.size / (1024 * 1024)).toFixed(1)} MB</small>`;
    }

    showStatus(msg, failed > 0 ? 'warning' : 'success', false);

  } catch (error) {
    setAppStatus('Error', 'danger');
    showStatus(`<b>Download failed:</b> ${error.message}`, 'error');
    console.error('[ManhwaDL] Download error:', error);
  } finally {
    isDownloading = false;
    $btnDownload.disabled = false;
    $btnScan.disabled = false;
    $btnText.classList.remove('hidden');
    $btnLoading.classList.add('hidden');
    $progressBar.classList.add('hidden');
    updateProgress(0, '');

    const $btnDownloadText = $btnDownload.querySelector('.btn-text span:last-child');
    if ($btnDownloadText) {
      $btnDownloadText.textContent = 'Download Again';
    }
  }
}

  /* ══════════════════════════════════════
     Events
     ══════════════════════════════════════ */

  $btnScan.addEventListener('click', scanImages);
  $btnStop.addEventListener('click', stopScan);
  if ($btnTestScroll) $btnTestScroll.addEventListener('click', testScroll);
  $btnDownload.addEventListener('click', downloadAndZip);

  $btnToggle.addEventListener('click', () => {
    const isHidden = $previewGrid.classList.toggle('hidden');
    $toggleText.textContent = isHidden ? 'Show' : 'Hide';
    $btnToggle.classList.toggle('active', !isHidden);
  });

  $namingFormat.addEventListener('change', () => {
    updateFormatHint();
    if (scannedImages.length > 0) renderPreview();
  });

  /* ══════════════════════════════════════
     Init
     ══════════════════════════════════════ */

  (async function init() {
    try {
      const res = await sendToContentScript({ action: 'GET_TITLE' });
      if (res?.success && res.title) {
        $chapterName.value = res.title;
      }
      setAppStatus('Ready', 'success');
    } catch {
      setAppStatus('No access', 'warning');
    }
    updateFormatHint();
  })();
})();