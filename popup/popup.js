/**
 * Popup Controller - Manhwa Downloader
 * Auto-download after scan complete
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

  /**
   * ✨ Smart pad number - auto detect digit dari total
   */
  function padNumber(num, format, total = 0) {
    if (format === 'auto') {
      const digits = Math.max(2, String(total).length);
      return String(num).padStart(digits, '0');
    }

    const digitMap = {
      '1digit': 1,
      '2digit': 2,
      '3digit': 3,
      '4digit': 4,
    };

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

/**
 * ⚡ Convert Array of bytes → Blob (lebih cepat dari base64)
 */
function arrayToBlob(dataArray, mimeType = 'image/jpeg') {
  const uint8Array = new Uint8Array(dataArray);
  return new Blob([uint8Array], { type: mimeType });
}

/**
 * ⚡ Fetch image via content script - pakai Array transfer
 */
async function fetchImageViaContentScript(url) {
  const response = await chrome.tabs.sendMessage(activeTabId, {
    action: 'FETCH_IMAGE',
    url,
  });

  if (!response?.success) {
    throw new Error(response?.error || 'Fetch failed');
  }

  // ⚡ Prefer array transfer (baru), fallback ke base64 (lama)
  if (response.data) {
    return {
      blob: arrayToBlob(response.data, response.mimeType),
      mimeType: response.mimeType,
    };
  }

  // Fallback untuk backward compat
  const [meta, data] = response.base64.split(',');
  const mimeMatch = meta.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return {
    blob: new Blob([bytes], { type: mime }),
    mimeType: response.mimeType || mime,
  };
}

  /**
   * ✨ Update format hint dinamis
   */
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

    // UI: show progress, hide others
    $btnScan.disabled = true;
    $btnScan.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    if ($btnTestScroll) $btnTestScroll.style.display = 'none';
    $scanProgress.classList.remove('hidden');
    $previewArea.classList.add('hidden');
    $btnDownload.classList.add('hidden');
    $statusMessage.classList.add('hidden');
    $progressBar.classList.add('hidden');

    // Reset progress display
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

      if (!response?.success && response?.count === 0) {
        throw new Error(response?.error || 'Scan failed');
      }

      scannedImages = response.images || [];
      scannedMeta = response.meta || [];

      if (!$chapterName.value.trim() && response.title) {
        $chapterName.value = response.title;
      }

      $imageCount.textContent = `${scannedImages.length} image${scannedImages.length !== 1 ? 's' : ''}`;

      if (scannedImages.length > 0) {
        scanSuccess = true;
        updateFormatHint();

        // Hide scan progress, show preview
        $scanProgress.classList.add('hidden');
        $previewArea.classList.remove('hidden');
        renderPreview();

        setAppStatus(`${scannedImages.length} found`, 'success');

        // ✨ AUTO DOWNLOAD - langsung mulai
        const blobCount = scannedImages.filter(u => u.startsWith('blob:')).length;
        const httpCount = scannedImages.length - blobCount;

        let scanMsg = response.stopped
          ? `<b>Scan stopped.</b> Captured <b>${scannedImages.length}</b> images.`
          : `<b>Scan complete!</b> Found <b>${scannedImages.length}</b> images.`;

        if (blobCount > 0) {
          scanMsg += `<small>🔒 ${blobCount} blob + ${httpCount} HTTP</small>`;
        }

scanMsg += `<br><small>⚡ Auto-downloading...</small>`;
showStatus(scanMsg, 'success', false);

// Reset scan state before download
isScanning = false;
$btnScan.classList.remove('hidden');
$btnStop.classList.add('hidden');
if ($btnTestScroll) $btnTestScroll.style.display = 'block';

// ⚡ Wait lebih pendek (800 → 300)
await new Promise(r => setTimeout(r, 300));

// ✨ AUTO TRIGGER DOWNLOAD
await downloadAndZip();

      } else {
        setAppStatus('No images', 'danger');
        showStatus('<b>No images found.</b> Check console (F12) for details.', 'error');
      }
    } catch (error) {
      setAppStatus('Error', 'danger');
      showStatus(`<b>Error:</b> ${error.message}`, 'error');
    } finally {
      // Reset scan UI (jika belum ter-reset)
      if (isScanning) {
        isScanning = false;
        $btnScan.disabled = false;
        $btnScan.classList.remove('hidden');
        $btnStop.classList.add('hidden');
        if ($btnTestScroll) $btnTestScroll.style.display = 'block';
        $scanProgress.classList.add('hidden');
      }

      $btnScan.disabled = false;

      // Show download button jika ada gambar (untuk re-download)
      if (scanSuccess && scannedImages.length > 0) {
        $btnDownload.classList.remove('hidden');
        $btnDownload.disabled = false;
        // Update button text
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

  /* ══════════════════════════════════════
     Test Scroll
     ══════════════════════════════════════ */

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
            : '❌ <b>Not compatible.</b> This site uses custom scroll handling.'}
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

  function renderPreview() {
    const format = $namingFormat.value;
    const total = scannedImages.length;
    $previewGrid.innerHTML = '';

    const limit = Math.min(scannedImages.length, 50);

    for (let i = 0; i < limit; i++) {
      const thumb = document.createElement('div');
      thumb.className = 'preview-thumb';

      const img = document.createElement('img');
      const url = scannedImages[i];

      if (url.startsWith('blob:')) {
        img.src = 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
          '<rect fill="#6c5ce7" width="60" height="80"/>' +
          '<text x="30" y="38" text-anchor="middle" fill="white" font-size="7" font-weight="bold">BLOB</text>' +
          '<text x="30" y="52" text-anchor="middle" fill="white" font-size="7" font-weight="bold">IMG</text></svg>'
        );
      } else {
        img.src = url;
        img.onerror = () => {
          img.src = 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
            '<rect fill="#2d2d4f" width="60" height="80"/>' +
            '<text x="30" y="44" text-anchor="middle" fill="#7a7a99" font-size="9" font-weight="bold">?</text></svg>'
          );
        };
      }

      img.loading = 'lazy';
      img.alt = `Page ${i + 1}`;

      const idx = document.createElement('span');
      idx.className = 'thumb-index';
      idx.textContent = padNumber(i + 1, format, total);

      thumb.append(img, idx);
      $previewGrid.appendChild(thumb);
    }

    if (scannedImages.length > limit) {
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
      `;
      more.textContent = `+${scannedImages.length - limit}`;
      $previewGrid.appendChild(more);
    }
  }

  /* ══════════════════════════════════════
     Download & ZIP
     ══════════════════════════════════════ */

  async function downloadAndZip() {
    if (isDownloading || scannedImages.length === 0) return;

    isDownloading = true;
    setAppStatus('Downloading', 'info');
    const format = $namingFormat.value;
    const total = scannedImages.length;
    const chapterName = sanitizeFilename($chapterName.value || 'manhwa-chapter');

    // UI: loading state
    $btnDownload.classList.remove('hidden');
    $btnDownload.disabled = true;
    $btnScan.disabled = true;
    $btnText.classList.add('hidden');
    $btnLoading.classList.remove('hidden');
    $progressBar.classList.remove('hidden');

    updateProgress(0, 'Starting...');

    const zip = new JSZip();
    const folder = zip.folder(chapterName);
    let completed = 0;
    let failed = 0;

try {
  // ⚡ TURBO: 8 concurrent downloads (dari 3)
  const batchSize = 8;

  for (let i = 0; i < total; i += batchSize) {
    const batch = scannedImages.slice(i, i + batchSize);

    await Promise.allSettled(
      batch.map(async (url, batchIdx) => {
        const globalIdx = i + batchIdx;
        const pageNum = padNumber(globalIdx + 1, format, total);

        try {
          let blob, mimeType;

          if (url.startsWith('blob:')) {
            const result = await fetchImageViaContentScript(url);
            blob = result.blob;
            mimeType = result.mimeType;
          } else {
            try {
              const response = await fetch(url, {
                mode: 'cors',
                credentials: 'include',
                headers: { 'Accept': 'image/webp,image/png,image/jpeg,image/*' },
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              blob = await response.blob();
              mimeType = blob.type;
            } catch {
              const result = await fetchImageViaContentScript(url);
              blob = result.blob;
              mimeType = result.mimeType;
            }
          }

          const ext = getFileExtension(url, mimeType);
          folder.file(`${pageNum}${ext}`, blob);
        } catch (err) {
          failed++;
          console.warn(`[ManhwaDL] Failed ${globalIdx + 1}:`, url, err.message);
        }
      })
    );

    completed += batch.length;
    const pct = Math.round((completed / total) * 80);
    updateProgress(pct, `⚡ ${Math.min(completed, total)}/${total}`);
  }

      if (completed - failed === 0) {
        throw new Error('All images failed to download.');
      }

updateProgress(85, '⚡ Packing ZIP...');

// ⚡ TURBO: STORE mode (no compression)
// Gambar JPG/PNG/WEBP sudah ter-compress, kompress lagi = buang-buang waktu
// Speed: ~5x lebih cepat, size: hanya 2-5% lebih besar
const zipBlob = await zip.generateAsync(
  { 
    type: 'blob', 
    compression: 'STORE',  // ⚡ STORE bukan DEFLATE
  },
  (meta) => {
    const zipPct = 85 + Math.round(meta.percent * 0.15);
    updateProgress(zipPct, `⚡ Packing ${Math.round(meta.percent)}%`);
  }
);

      updateProgress(100, 'Saving...');
      const blobUrl = URL.createObjectURL(zipBlob);
      const filename = `${chapterName}.zip`;

      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_ZIP',
        dataUrl: blobUrl,
        filename,
      });

      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

      setAppStatus('Downloaded', 'success');

      const msg = failed > 0
        ? `✅ <b>Downloaded ${total - failed}/${total}</b> images<br><small>${failed} failed to fetch</small><br><small>📦 <code>${filename}</code></small>`
        : `✅ <b>Success!</b> ${total} images saved<br><small>📦 <code>${filename}</code></small>`;
      showStatus(msg, failed > 0 ? 'warning' : 'success', false);

    } catch (error) {
      setAppStatus('Error', 'danger');
      showStatus(`<b>Download failed:</b> ${error.message}`, 'error');
    } finally {
      isDownloading = false;
      $btnDownload.disabled = false;
      $btnScan.disabled = false;
      $btnText.classList.remove('hidden');
      $btnLoading.classList.add('hidden');
      $progressBar.classList.add('hidden');
      updateProgress(0, '');

      // Update button text jadi "Download Again"
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
