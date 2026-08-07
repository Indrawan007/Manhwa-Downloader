/**
 * Popup Controller - Manhwa Downloader
 * Sequential auto-capture with real-time progress
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ── DOM Elements ── */
  const $appStatus      = $('appStatus');
  const $chapterName    = $('chapterName');
  const $namingFormat   = $('namingFormat');
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

  /* ── Utils ── */

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Tidak ada tab aktif');
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
    } catch { /* injected */ }

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

  function showStatus(text, type = 'info') {
    $statusMessage.innerHTML = text;
    $statusMessage.className = `status-message ${type}`;
    $statusMessage.classList.remove('hidden');
    if (type !== 'error') {
      setTimeout(() => $statusMessage.classList.add('hidden'), 8000);
    }
  }

  function updateProgress(percent, text) {
    $progressFill.style.width = `${percent}%`;
    if (text) $progressText.textContent = text;
  }

  function padNumber(num, format) {
    return format === '3digit'
      ? String(num).padStart(3, '0')
      : String(num).padStart(2, '0');
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

  function base64ToBlob(base64Data) {
    const [meta, data] = base64Data.split(',');
    const mimeMatch = meta.match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type: mime });
  }

  async function fetchImageViaContentScript(url) {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      action: 'FETCH_IMAGE',
      url,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Fetch gagal');
    }

    return {
      blob: base64ToBlob(response.base64),
      mimeType: response.mimeType,
    };
  }

  /* ══════════════════════════════════════
     Progress Listener
     ══════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SCAN_PROGRESS' && isScanning) {
      const { phase, percent, collected, current, total, message: msg } = message.data;

      const phaseText = {
        discovery: '🔍 DISCOVERY (Cari halaman)',
        capture:   '📸 CAPTURE (Scroll & simpan)',
      }[phase] || phase.toUpperCase();

      $scanPhase.textContent = phaseText;

      if (phase === 'capture' && current && total) {
        $scanCollected.textContent = `${collected}/${total}`;
      } else {
        $scanCollected.textContent = `${collected} gambar`;
      }

      $scanProgressFill.style.width = `${percent}%`;
      $scanPercent.textContent = `${percent}%`;
      $scanMessage.textContent = msg || '';
    }
  });

  /* ══════════════════════════════════════
     Scan
     ══════════════════════════════════════ */

  async function scanImages() {
    if (isScanning) return;

    isScanning = true;
    $btnScan.disabled = true;
    $btnScan.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    $scanProgress.classList.remove('hidden');
    $previewArea.classList.add('hidden');
    $btnDownload.classList.add('hidden');
    $statusMessage.classList.add('hidden');

    $scanPhase.textContent = '🚀 Memulai...';
    $scanCollected.textContent = '0 gambar';
    $scanProgressFill.style.width = '0%';
    $scanPercent.textContent = '0%';
    $scanMessage.textContent = 'Preparing...';

    try {
      // Ganti bagian ini di scanImages():
const response = await sendToContentScript({
  action: 'SCAN_IMAGES',
  customSelector: $imageSelector.value.trim(),
  speed: $scanSpeed.value,  // ✅ TAMBAH INI
});

      if (!response?.success && response?.count === 0) {
        throw new Error(response?.error || 'Gagal scan');
      }

      scannedImages = response.images || [];
      scannedMeta = response.meta || [];

      if (!$chapterName.value.trim() && response.title) {
        $chapterName.value = response.title;
      }

      const blobCount = scannedImages.filter(u => u.startsWith('blob:')).length;
      const httpCount = scannedImages.length - blobCount;

      $imageCount.textContent = `${scannedImages.length} gambar ditemukan`;
      $previewArea.classList.remove('hidden');

      if (scannedImages.length > 0) {
        $btnDownload.classList.remove('hidden');
        $btnDownload.disabled = false;
        renderPreview();

        let msg;
        if (response.stopped) {
          msg = `⏹ Dihentikan. Berhasil capture <b>${scannedImages.length}</b> gambar`;
        } else if (response.total && response.total > scannedImages.length) {
          msg = `⚠️ Capture <b>${scannedImages.length}/${response.total}</b> gambar (${response.failed} miss)`;
        } else {
          msg = `✅ Berhasil capture <b>${scannedImages.length}</b> gambar`;
        }

        if (blobCount > 0) {
          msg += `<br><small>🔒 ${blobCount} blob + ${httpCount} HTTP</small>`;
        }

        showStatus(msg, response.stopped || response.failed > 0 ? 'info' : 'success');
      } else {
        showStatus('⚠️ Tidak ada gambar ditemukan. Cek Console (F12).', 'error');
      }
    } catch (error) {
      showStatus(`❌ Error: ${error.message}`, 'error');
    } finally {
      isScanning = false;
      $btnScan.disabled = false;
      $btnScan.classList.remove('hidden');
      $btnStop.classList.add('hidden');
      $scanProgress.classList.add('hidden');
    }
  }

  async function stopScan() {
    if (!isScanning) return;

    $btnStop.disabled = true;
    $btnStop.innerHTML = '⏹ Stopping...';

    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'STOP_SCAN' });
    } catch { /* ignore */ }

    setTimeout(() => {
      $btnStop.disabled = false;
      $btnStop.innerHTML = '⏹ Stop';
    }, 1000);
  }

  /* ══════════════════════════════════════
     Preview
     ══════════════════════════════════════ */

  function renderPreview() {
    const format = $namingFormat.value;
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
          '<text x="30" y="38" text-anchor="middle" fill="white" font-size="8">BLOB</text>' +
          '<text x="30" y="52" text-anchor="middle" fill="white" font-size="8">IMG</text></svg>'
        );
      } else {
        img.src = url;
        img.onerror = () => {
          img.src = 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80">' +
            '<rect fill="#2a2a4a" width="60" height="80"/>' +
            '<text x="30" y="44" text-anchor="middle" fill="#666" font-size="10">ERR</text></svg>'
          );
        };
      }

      img.loading = 'lazy';
      img.alt = `Page ${i + 1}`;

      const idx = document.createElement('span');
      idx.className = 'thumb-index';
      idx.textContent = padNumber(i + 1, format);

      thumb.append(img, idx);
      $previewGrid.appendChild(thumb);
    }

    if (scannedImages.length > limit) {
      const more = document.createElement('div');
      more.className = 'preview-thumb';
      more.style.cssText = 'display:flex;align-items:center;justify-content:center;background:var(--bg-input);font-size:11px;color:var(--text-muted);';
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
    const format = $namingFormat.value;
    const chapterName = sanitizeFilename($chapterName.value || 'manhwa-chapter');

    $btnDownload.disabled = true;
    $btnScan.disabled = true;
    $btnText.classList.add('hidden');
    $btnLoading.classList.remove('hidden');
    $progressBar.classList.remove('hidden');
    $statusMessage.classList.add('hidden');
    updateProgress(0, 'Memulai...');

    const zip = new JSZip();
    const folder = zip.folder(chapterName);
    const total = scannedImages.length;
    let completed = 0;
    let failed = 0;

    try {
      const batchSize = 3;

      for (let i = 0; i < total; i += batchSize) {
        const batch = scannedImages.slice(i, i + batchSize);

        await Promise.allSettled(
          batch.map(async (url, batchIdx) => {
            const globalIdx = i + batchIdx;
            const pageNum = padNumber(globalIdx + 1, format);

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
              console.warn(`[ManhwaDL] Gagal ${globalIdx + 1}:`, url, err.message);
            }
          })
        );

        completed += batch.length;
        const pct = Math.round((completed / total) * 80);
        updateProgress(pct, `Mengunduh ${Math.min(completed, total)}/${total}...`);
      }

      if (completed - failed === 0) {
        throw new Error('Semua gambar gagal diunduh.');
      }

      updateProgress(85, 'Membuat ZIP...');

      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (meta) => {
          const zipPct = 85 + Math.round(meta.percent * 0.15);
          updateProgress(zipPct, `Kompresi... ${Math.round(meta.percent)}%`);
        }
      );

      updateProgress(100, 'Menyimpan...');
      const blobUrl = URL.createObjectURL(zipBlob);
      const filename = `${chapterName}.zip`;

      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_ZIP',
        dataUrl: blobUrl,
        filename,
      });

      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

      const msg = failed > 0
        ? `✅ Selesai! ${total - failed}/${total} berhasil. ${failed} gagal.`
        : `✅ Berhasil! ${total} gambar → ${filename}`;
      showStatus(msg, failed > 0 ? 'info' : 'success');

    } catch (error) {
      showStatus(`❌ Gagal: ${error.message}`, 'error');
    } finally {
      isDownloading = false;
      $btnDownload.disabled = false;
      $btnScan.disabled = false;
      $btnText.classList.remove('hidden');
      $btnLoading.classList.add('hidden');
      $progressBar.classList.add('hidden');
      updateProgress(0, '');
    }
  }

  /* ══════════════════════════════════════
     Events
     ══════════════════════════════════════ */

$btnTestScroll.addEventListener('click', async () => {
  try {
    const result = await sendToContentScript({ action: 'TEST_SCROLL' });
    
    if (result?.success) {
      const info = `
        🧪 <b>Scroll Test Result:</b><br><br>
        📦 Container type: <b>${result.containerType}</b><br>
        📏 Scroll height: <b>${result.scrollHeight}px</b><br>
        📐 Max scroll Y: <b>${result.maxScrollY}px</b><br>
        🎯 Test scroll:<br>
        &nbsp;&nbsp;• Before: ${result.beforeY}px<br>
        &nbsp;&nbsp;• After: ${result.afterY}px<br>
        &nbsp;&nbsp;• Moved: <b>${result.moved}px</b><br><br>
        ${result.moved > 100 
          ? '✅ Scroll <b>BERFUNGSI!</b>' 
          : '❌ Scroll <b>TIDAK BEKERJA!</b><br>Halaman menggunakan custom scroll yang perlu approach berbeda.'}
      `;
      showStatus(info, result.moved > 100 ? 'success' : 'error');
    }
  } catch (error) {
    showStatus(`❌ Test error: ${error.message}`, 'error');
  }
});

  $btnScan.addEventListener('click', scanImages);
  $btnStop.addEventListener('click', stopScan);
  $btnDownload.addEventListener('click', downloadAndZip);

  $btnToggle.addEventListener('click', () => {
    const hidden = $previewGrid.classList.toggle('hidden');
    $btnToggle.textContent = hidden ? 'Lihat Preview' : 'Sembunyikan';
  });

  $namingFormat.addEventListener('change', () => {
    if (scannedImages.length > 0) renderPreview();
  });

  /* ══════════════════════════════════════
     Init
     ══════════════════════════════════════ */

  (async function init() {
    try {
      const res = await sendToContentScript({ action: 'GET_TITLE' });
      if (res?.success && res.title) $chapterName.value = res.title;
    } catch { /* silent */ }
  })();
})();
