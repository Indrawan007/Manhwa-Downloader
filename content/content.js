/**
 * Content Script - Manhwa Downloader
 * Multi-strategy scroll: deteksi container yang benar & force scroll
 */

(() => {
  'use strict';

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log('[ManhwaDL]', ...args);

  /* ══════════════════════════════════════
     Config
     ══════════════════════════════════════ */
  const CONFIG = {
    scrollPxPerFrame: 15,
    scrollSettleTime: 300,
    imageLoadTimeout: 6000,
    imageLoadCheckInterval: 100,
    discoveryScrollPxPerFrame: 40,
    scrollOffset: 100,
  };

  /* ══════════════════════════════════════
     Selectors
     ══════════════════════════════════════ */
  const SITE_SELECTORS = [
    '.reading-content img',
    '.chapter-content img',
    '#readerarea img',
    '.reader-area img',
    '.page-break img',
    '.viewer-img img',
    '.chapter-img img',
    '.manga-reader img',
    '#image-container img',
    '.container-chapter-reader img',
    '.reading-detail img',
    '.chapter_img img',
    '.vung-doc img',
    '.reader-main img',
    '.wp-manga-chapter-img',
    '.text-left img',
    'main img',
    'article img',
    '#content img',
    '.content img',
  ];

  const TITLE_SELECTORS = [
    'h1', '.chapter-title', '#chapter-heading',
    '.entry-title', '.chapter-name', '.reader-header h1', 'title',
  ];

  /* ══════════════════════════════════════
     ✅ SCROLL CONTAINER DETECTION
     Cari container yang BENAR-BENAR bisa di-scroll
     ══════════════════════════════════════ */

  const scrollContainer = {
    element: null,     // Element yang bisa di-scroll
    type: null,        // 'window' | 'element'

    /**
     * Deteksi container scrollable yang berisi gambar manhwa
     */
    detect(imageSelector) {
      // Reset
      this.element = null;
      this.type = null;

      // Strategy 1: Cek window/document scroll
      const docScrollable = document.documentElement.scrollHeight > window.innerHeight;
      const bodyScrollable = document.body.scrollHeight > window.innerHeight;

      if (docScrollable || bodyScrollable) {
        // Test: coba scroll window
        const beforeY = window.scrollY;
        window.scrollTo(0, beforeY + 100);

        // Wait sync
        const afterY = window.scrollY;
        window.scrollTo(0, beforeY); // Restore

        if (Math.abs(afterY - beforeY) > 10) {
          this.element = window;
          this.type = 'window';
          log('✅ Scroll container: WINDOW');
          return;
        }
      }

      // Strategy 2: Cari parent scrollable dari image element
      const imgs = document.querySelectorAll(imageSelector || 'img');
      if (imgs.length > 0) {
        const container = this.findScrollableParent(imgs[0]);
        if (container) {
          this.element = container;
          this.type = 'element';
          log('✅ Scroll container: ELEMENT', container);
          return;
        }
      }

      // Strategy 3: Scan semua element scrollable di halaman
      const scrollables = this.findAllScrollables();
      if (scrollables.length > 0) {
        // Pilih yang paling tinggi
        scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
        this.element = scrollables[0];
        this.type = 'element';
        log('✅ Scroll container: LARGEST SCROLLABLE', this.element);
        return;
      }

      // Fallback: pakai window
      this.element = window;
      this.type = 'window';
      log('⚠️ Fallback to window (no scrollable detected)');
    },

    /**
     * Find scrollable parent dari suatu element
     */
    findScrollableParent(el) {
      let current = el.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY;
        const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') &&
                            current.scrollHeight > current.clientHeight;
        if (isScrollable) return current;
        current = current.parentElement;
      }
      return null;
    },

    /**
     * Scan semua element di halaman yang bisa di-scroll
     */
    findAllScrollables() {
      const results = [];
      const all = document.querySelectorAll('*');

      all.forEach(el => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScroll = (overflowY === 'auto' || overflowY === 'scroll') &&
                          el.scrollHeight > el.clientHeight + 50;
        if (canScroll) results.push(el);
      });

      return results;
    },

    /**
     * Get current scroll Y
     */
    getScrollY() {
      if (this.type === 'window') {
        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
      }
      return this.element.scrollTop;
    },

    /**
     * Get max scroll Y
     */
    getMaxScrollY() {
      if (this.type === 'window') {
        return Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ) - window.innerHeight;
      }
      return this.element.scrollHeight - this.element.clientHeight;
    },

    /**
     * Get total scroll height
     */
    getScrollHeight() {
      if (this.type === 'window') {
        return Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        );
      }
      return this.element.scrollHeight;
    },

    /**
     * Get viewport height
     */
    getViewportHeight() {
      if (this.type === 'window') return window.innerHeight;
      return this.element.clientHeight;
    },

    /**
     * ✅ SCROLL - dengan multiple fallback strategy
     */
    scrollTo(y) {
      y = Math.max(0, Math.min(y, this.getMaxScrollY()));

      if (this.type === 'window') {
        // Multi-approach untuk window scroll
        try {
          window.scrollTo(0, y);
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
        } catch { /* ignore */ }
      } else {
        // Element scroll
        try {
          this.element.scrollTop = y;
        } catch { /* ignore */ }
      }
    },

    /**
     * Get Y position dari element RELATIVE ke scroll container
     */
    getElementY(el) {
      try {
        if (this.type === 'window') {
          return el.getBoundingClientRect().top + this.getScrollY();
        } else {
          // Untuk custom container: hitung offset dari container
          const containerRect = this.element.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          return elRect.top - containerRect.top + this.getScrollY();
        }
      } catch {
        return 0;
      }
    },
  };

  /* ══════════════════════════════════════
     Scan State
     ══════════════════════════════════════ */
  const scanState = {
    isRunning: false,
    stopRequested: false,
    activeSelector: null,
    highlightEl: null,

    start() { this.isRunning = true; this.stopRequested = false; },
    stop()  { this.stopRequested = true; },
    finish() { this.isRunning = false; this.stopRequested = false; this.removeHighlight(); this.hideBanner(); },

    highlight(el, index, total) {
      this.removeHighlight();
      if (!el) return;

      try {
        const rect = el.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = '__manhwa_dl_highlight__';
        overlay.style.cssText = `
          position: fixed;
          top: ${rect.top}px;
          left: ${rect.left}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          border: 4px solid #6c5ce7;
          box-shadow: 0 0 20px rgba(108, 92, 231, 0.8), inset 0 0 20px rgba(108, 92, 231, 0.3);
          background: rgba(108, 92, 231, 0.1);
          z-index: 999999;
          pointer-events: none;
          transition: all 0.2s ease;
          border-radius: 4px;
        `;

        const label = document.createElement('div');
        label.style.cssText = `
          position: absolute;
          top: 8px;
          left: 8px;
          background: #6c5ce7;
          color: white;
          padding: 4px 12px;
          border-radius: 4px;
          font-family: system-ui, sans-serif;
          font-size: 14px;
          font-weight: 700;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        label.textContent = `📸 ${index}/${total}`;

        overlay.appendChild(label);
        document.body.appendChild(overlay);
        this.highlightEl = overlay;
      } catch { /* ignore */ }
    },

    removeHighlight() {
      document.getElementById('__manhwa_dl_highlight__')?.remove();
      this.highlightEl = null;
    },

    showBanner(text) {
      let banner = document.getElementById('__manhwa_dl_banner__');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = '__manhwa_dl_banner__';
        banner.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          background: linear-gradient(135deg, #6c5ce7, #a29bfe);
          color: white;
          padding: 12px 20px;
          border-radius: 8px;
          font-family: system-ui, sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 20px rgba(108, 92, 231, 0.5);
          z-index: 999998;
          min-width: 200px;
          text-align: center;
        `;
        document.body.appendChild(banner);
      }
      banner.textContent = text;
    },

    hideBanner() {
      document.getElementById('__manhwa_dl_banner__')?.remove();
    },
  };

  /* ══════════════════════════════════════
     Utilities
     ══════════════════════════════════════ */

  function sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .trim()
      .substring(0, 100);
  }

  function detectChapterTitle() {
    for (const selector of TITLE_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) {
        const text = (el.textContent || el.innerText || '').trim();
        if (text.length > 0 && text.length < 200) {
          return sanitizeFilename(text);
        }
      }
    }
    return sanitizeFilename(document.title || 'Manhwa-Chapter');
  }

  function validateImageUrl(src) {
    if (!src) return false;
    if (src.startsWith('data:')) return false;
    if (src.startsWith('blob:')) return true;

    const lower = src.toLowerCase();
    if (!lower.startsWith('http')) return false;

    const blacklist = [
      /\/favicon\./i, /\/logo[-_./]/i, /\/avatar[-_./]/i,
      /\/emoji[-_./]/i, /\/tracking[-_./]/i, /google.*analytics/i,
      /facebook\.com\/tr/i, /doubleclick/i, /adservice/i, /disqus/i,
    ];
    return !blacklist.some(p => p.test(lower));
  }

  function getBestImageUrl(el) {
    if (!el) return null;
    const candidates = [];

    if (el.tagName === 'IMG') {
      candidates.push(
        el.src, el.currentSrc,
        el.dataset.src, el.dataset.lazySrc, el.dataset.original,
        el.getAttribute('data-src'),
        el.getAttribute('data-lazy-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-url'),
        el.getAttribute('data-image'),
        el.getAttribute('data-cfsrc'),
      );
    } else if (el.tagName === 'SOURCE') {
      candidates.push(el.srcset, el.src);
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'string') continue;
      if (candidate.startsWith('data:') || candidate.trim() === '') continue;

      try {
        let cleanUrl = candidate;
        if (candidate.includes(',') && !candidate.startsWith('blob:')) {
          cleanUrl = candidate.split(',')[0].trim().split(/\s+/)[0];
        }

        const absolute = cleanUrl.startsWith('blob:')
          ? cleanUrl
          : new URL(cleanUrl, window.location.href).href;

        if (validateImageUrl(absolute)) return absolute;
      } catch { continue; }
    }

    return null;
  }

  function forceLazyLoad(imgs) {
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image', 'data-cfsrc'];
    const targets = imgs || document.querySelectorAll('img');

    targets.forEach(img => {
      for (const attr of lazyAttrs) {
        const val = img.getAttribute(attr);
        if (val && !val.startsWith('data:')) {
          const isPlaceholder = !img.src ||
                                img.src.startsWith('data:') ||
                                img.src.includes('placeholder');
          if (isPlaceholder) {
            img.src = val.split(',')[0].trim().split(/\s+/)[0];
          }
        }
      }
      if (img.loading === 'lazy') img.loading = 'eager';
      img.classList.remove('lazy', 'lazyload');
    });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /* ══════════════════════════════════════
     ✅ VISIBLE SMOOTH SCROLL
     ══════════════════════════════════════ */

  async function smoothScrollTo(targetY, pxPerFrame = CONFIG.scrollPxPerFrame) {
    return new Promise((resolve) => {
      const startY = scrollContainer.getScrollY();
      const distance = targetY - startY;
      const direction = distance > 0 ? 1 : -1;
      const absDistance = Math.abs(distance);

      if (absDistance < 5) {
        resolve();
        return;
      }

      let traveled = 0;

      const step = () => {
        if (scanState.stopRequested) {
          resolve();
          return;
        }

        const remaining = absDistance - traveled;
        const moveThisFrame = Math.min(pxPerFrame, remaining);

        traveled += moveThisFrame;
        const newY = startY + (traveled * direction);

        scrollContainer.scrollTo(newY);

        if (traveled >= absDistance) {
          resolve();
        } else {
          requestAnimationFrame(step);
        }
      };

      requestAnimationFrame(step);
    });
  }

  /* ══════════════════════════════════════
     Wait for image loaded
     ══════════════════════════════════════ */

  async function waitForImageLoad(img, timeout = CONFIG.imageLoadTimeout) {
    if (img.complete && img.naturalWidth > 0) return true;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (scanState.stopRequested) return false;
      forceLazyLoad([img]);
      if (img.complete && img.naturalWidth > 0) return true;
      await sleep(CONFIG.imageLoadCheckInterval);
    }

    return false;
  }

  /* ══════════════════════════════════════
     Detect image selector
     ══════════════════════════════════════ */

  function detectImageSelector(customSelector = '') {
    if (customSelector) {
      try {
        const els = document.querySelectorAll(customSelector);
        if (els.length >= 1) {
          log(`Using custom selector: "${customSelector}" (${els.length} elements)`);
          return customSelector;
        }
      } catch { /* invalid */ }
    }

    let bestSelector = null;
    let bestCount = 0;

    for (const selector of SITE_SELECTORS) {
      try {
        const count = document.querySelectorAll(selector).length;
        if (count > bestCount) {
          bestCount = count;
          bestSelector = selector;
        }
      } catch { continue; }
    }

    if (bestSelector && bestCount >= 2) {
      log(`Auto-detected: "${bestSelector}" (${bestCount} elements)`);
      return bestSelector;
    }

    log('Fallback to: img');
    return 'img';
  }

  /* ══════════════════════════════════════
   PHASE 1: Discovery - FIXED FIRST IMAGE
   ══════════════════════════════════════ */

async function discoveryPhase(customSelector, onProgress) {
  log('╔═══════════════════════════════════╗');
  log('║ PHASE 1: DISCOVERY                ║');
  log('╚═══════════════════════════════════╝');

  scanState.showBanner('🔍 Phase 1: Discovery...');

  const selector = detectImageSelector(customSelector);
  scrollContainer.detect(selector);
  scanState.activeSelector = selector;

  log(`Scroll container: ${scrollContainer.type}`);
  log(`Scroll height: ${scrollContainer.getScrollHeight()}`);
  log(`Viewport: ${scrollContainer.getViewportHeight()}`);

  // Scroll ke atas
  await smoothScrollTo(0, 50);
  await sleep(500);

  const positionSet = new Set();
  const urlSet = new Set();

  const collectPositions = () => {
    const imgs = document.querySelectorAll(selector);
    forceLazyLoad(imgs);
    imgs.forEach(img => {
      const y = scrollContainer.getElementY(img);
      // ✅ FIX: Include gambar dengan Y >= -50 (toleransi negatif)
      if (y >= -50) {
        const normalizedY = Math.max(0, y);
        positionSet.add(Math.round(normalizedY / 10) * 10);
      }
      const url = getBestImageUrl(img);
      if (url) urlSet.add(url);
    });
  };

  // ✅ FIX: Multiple initial collections untuk gambar pertama
  collectPositions();
  await sleep(300);
  collectPositions();

  // ✅ FIX: Force add Y=0 jika ada gambar apapun
  const initialImgs = document.querySelectorAll(selector);
  if (initialImgs.length > 0) {
    positionSet.add(0);
    log(`Initial DOM images: ${initialImgs.length}, ensuring Y=0 included`);
  }

  let currentPos = 0;
  let lastHeight = scrollContainer.getScrollHeight();
  let stableCount = 0;
  const maxScroll = scrollContainer.getMaxScrollY();

  while (true) {
    if (scanState.stopRequested) break;

    currentPos = Math.min(currentPos + scrollContainer.getViewportHeight() * 0.8, maxScroll);

    scanState.showBanner(`🔍 Discovery: ${positionSet.size} halaman ditemukan`);

    await smoothScrollTo(currentPos, CONFIG.discoveryScrollPxPerFrame);
    await sleep(200);
    collectPositions();

    if (onProgress) {
      onProgress({
        phase: 'discovery',
        percent: Math.min(100, Math.round((currentPos / Math.max(maxScroll, 1)) * 100)),
        collected: positionSet.size,
        message: `Discovery: ${positionSet.size} halaman ditemukan`,
      });
    }

    const newHeight = scrollContainer.getScrollHeight();

    if (currentPos >= maxScroll - 10) {
      if (newHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = newHeight;
      }
      if (stableCount >= 3) break;
    }
  }

  await sleep(500);
  collectPositions();

  scanState.showBanner('⬆️ Kembali ke atas...');
  await smoothScrollTo(0, 60);
  await sleep(500);

  // ✅ FIX: Final collect di atas untuk pastikan gambar #1 tertangkap
  collectPositions();

  const positions = Array.from(positionSet).sort((a, b) => a - b);

  log(`Discovery complete: ${positions.length} positions`);
  log(`First 5 positions: ${positions.slice(0, 5).join(', ')}`);

  return {
    positions,
    initialUrls: urlSet,
    selector,
    pageHeight: lastHeight,
  };
}

/* ══════════════════════════════════════
   PHASE 2: Sequential Capture - FIXED
   ══════════════════════════════════════ */

async function sequentialCapture(discoveryResult, onProgress) {
  log('╔═══════════════════════════════════╗');
  log('║ PHASE 2: SEQUENTIAL CAPTURE       ║');
  log('╚═══════════════════════════════════╝');

  const { positions, selector } = discoveryResult;
  const total = positions.length;
  const capturedUrls = new Array(total).fill(null);
  const capturedMeta = new Array(total).fill(null);
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    if (scanState.stopRequested) {
      log('Stop requested at index', i);
      break;
    }

    const targetY = positions[i];
    const pageNum = i + 1;
    const isFirstImage = (i === 0);

    scanState.showBanner(`📸 Capturing ${pageNum}/${total} • Sukses: ${successCount}`);

    // ✅ FIX: Scroll ke posisi yang benar (untuk gambar pertama = 0)
    const scrollTargetY = targetY <= CONFIG.scrollOffset 
      ? 0 
      : targetY - CONFIG.scrollOffset;

    await smoothScrollTo(scrollTargetY);
    await sleep(CONFIG.scrollSettleTime);

    // ✅ FIX: Extra wait untuk gambar pertama (lazy load lebih lambat di atas)
    if (isFirstImage) {
      await sleep(400);
      forceLazyLoad(document.querySelectorAll(selector));
      await sleep(300);
    }

    const imgs = document.querySelectorAll(selector);
    let targetImg = null;
    let minDist = Infinity;

    // ✅ FIX: Tolerance lebih besar untuk gambar pertama
    const tolerance = isFirstImage ? 300 : 50;

    imgs.forEach(img => {
      const y = scrollContainer.getElementY(img);
      const effectiveY = Math.max(0, y);
      const dist = Math.abs(effectiveY - targetY);
      if (dist < minDist && dist < tolerance) {
        minDist = dist;
        targetImg = img;
      }
    });

    // Retry dengan tolerance lebih luas
    if (!targetImg) {
      await sleep(200);
      const imgs2 = document.querySelectorAll(selector);
      const wideTolerance = isFirstImage ? 500 : 150;

      imgs2.forEach(img => {
        const y = scrollContainer.getElementY(img);
        const effectiveY = Math.max(0, y);
        const dist = Math.abs(effectiveY - targetY);
        if (dist < minDist && dist < wideTolerance) {
          minDist = dist;
          targetImg = img;
        }
      });
    }

    // ✅ FIX: Ultimate fallback untuk gambar pertama
    if (!targetImg && isFirstImage) {
      const allImgs = document.querySelectorAll(selector);
      if (allImgs.length > 0) {
        let firstImg = null;
        let minY = Infinity;
        allImgs.forEach(img => {
          const y = scrollContainer.getElementY(img);
          if (y < minY) {
            minY = y;
            firstImg = img;
          }
        });
        if (firstImg) {
          targetImg = firstImg;
          log(`[${pageNum}/${total}] 🎯 Fallback: first image at Y=${minY}`);
        }
      }
    }

    if (!targetImg) {
      log(`[${pageNum}/${total}] ❌ No image at Y=${targetY}`);
      failCount++;
      if (onProgress) {
        onProgress({
          phase: 'capture',
          percent: Math.round(((i + 1) / total) * 100),
          current: pageNum,
          total,
          collected: successCount,
          message: `Miss: page ${pageNum}`,
        });
      }
      continue;
    }

    scanState.highlight(targetImg, pageNum, total);

    forceLazyLoad([targetImg]);
    const loaded = await waitForImageLoad(targetImg);

    const url = getBestImageUrl(targetImg);

    if (url) {
      capturedUrls[i] = url;
      capturedMeta[i] = {
        index: i,
        pageNum,
        y: targetY,
        loaded,
        naturalWidth: targetImg.naturalWidth,
        naturalHeight: targetImg.naturalHeight,
        isBlob: url.startsWith('blob:'),
      };
      successCount++;
      log(`[${pageNum}/${total}] ✅ ${loaded ? 'LOADED' : 'TIMEOUT'} → ${url.substring(0, 60)}...`);
    } else {
      failCount++;
      log(`[${pageNum}/${total}] ❌ No URL extracted`);
    }

    if (onProgress) {
      onProgress({
        phase: 'capture',
        percent: Math.round(((i + 1) / total) * 100),
        current: pageNum,
        total,
        collected: successCount,
        message: `Capture ${pageNum}/${total} • ${successCount} sukses`,
      });
    }

    await sleep(150);
  }

  scanState.removeHighlight();
  log(`Capture: ${successCount}/${total} success, ${failCount} failed`);

  return {
    urls: capturedUrls.filter(u => u !== null),
    meta: capturedMeta.filter(m => m !== null),
    total,
    success: successCount,
    failed: failCount,
  };
}

  /* ══════════════════════════════════════
     Progress reporter
     ══════════════════════════════════════ */

  function reportProgress(data) {
    try {
      chrome.runtime.sendMessage({
        action: 'SCAN_PROGRESS',
        data,
      }).catch(() => { /* popup closed */ });
    } catch { /* ignore */ }
  }

  /* ══════════════════════════════════════
     Fetch image
     ══════════════════════════════════════ */

  async function fetchImageAsBase64(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      return { success: true, base64, mimeType: blob.type, size: blob.size };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /* ══════════════════════════════════════
     Debug
     ══════════════════════════════════════ */

  function debugScan() {
    return {
      totalImgTags: document.querySelectorAll('img').length,
      pageHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollContainer: scrollContainer.type,
      scrollHeight: scrollContainer.getScrollHeight(),
      maxScrollY: scrollContainer.getMaxScrollY(),
    };
  }

  /* ══════════════════════════════════════
     Main scan flow
     ══════════════════════════════════════ */

  async function performScan(customSelector) {
    try {
      const discovery = await discoveryPhase(customSelector, reportProgress);

      if (scanState.stopRequested || discovery.positions.length === 0) {
        scanState.showBanner('⏹ Discovery selesai');
        await sleep(1000);
        scanState.hideBanner();
        return {
          images: Array.from(discovery.initialUrls),
          meta: [],
          stopped: scanState.stopRequested,
        };
      }

      const capture = await sequentialCapture(discovery, reportProgress);

      scanState.showBanner(`✅ Selesai! ${capture.success}/${capture.total} gambar`);
      await sleep(1500);
      scanState.hideBanner();

      await smoothScrollTo(0, 80);

      return {
        images: capture.urls,
        meta: capture.meta,
        total: capture.total,
        success: capture.success,
        failed: capture.failed,
        stopped: scanState.stopRequested,
      };
    } finally {
      scanState.removeHighlight();
      scanState.hideBanner();
    }
  }

  /* ══════════════════════════════════════
     Message Listener
     ══════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {

      case 'SCAN_IMAGES': {
        (async () => {
          try {
            scanState.start();

            if (message.speed) {
              const speedMap = {
                slow:   { scrollPxPerFrame: 8,  scrollSettleTime: 500 },
                normal: { scrollPxPerFrame: 15, scrollSettleTime: 300 },
                fast:   { scrollPxPerFrame: 25, scrollSettleTime: 200 },
                turbo:  { scrollPxPerFrame: 40, scrollSettleTime: 100 },
              };
              const preset = speedMap[message.speed];
              if (preset) {
                CONFIG.scrollPxPerFrame = preset.scrollPxPerFrame;
                CONFIG.scrollSettleTime = preset.scrollSettleTime;
              }
            }

            const result = await performScan(message.customSelector || '');

            scanState.finish();

            const title = detectChapterTitle();
            let debugInfo = null;
            if (result.images.length === 0) debugInfo = debugScan();

            sendResponse({
              success: true,
              images: result.images,
              meta: result.meta,
              title,
              count: result.images.length,
              total: result.total,
              failed: result.failed,
              url: window.location.href,
              debug: debugInfo,
              stopped: result.stopped,
            });
          } catch (error) {
            log('SCAN ERROR:', error);
            scanState.finish();
            sendResponse({
              success: false,
              error: error.message,
              images: [],
              count: 0,
            });
          }
        })();
        return true;
      }

      case 'STOP_SCAN': {
        scanState.stop();
        sendResponse({ success: true });
        return true;
      }

      case 'FETCH_IMAGE': {
        (async () => {
          const result = await fetchImageAsBase64(message.url);
          sendResponse(result);
        })();
        return true;
      }

      case 'GET_TITLE': {
        sendResponse({ success: true, title: detectChapterTitle() });
        return true;
      }

      /**
       * ✅ TEST SCROLL - Debug: test apakah scroll bekerja
       */
      case 'TEST_SCROLL': {
        (async () => {
          scrollContainer.detect('img');
          const beforeY = scrollContainer.getScrollY();
          scrollContainer.scrollTo(beforeY + 500);
          await sleep(500);
          const afterY = scrollContainer.getScrollY();

          sendResponse({
            success: true,
            containerType: scrollContainer.type,
            beforeY,
            afterY,
            moved: Math.abs(afterY - beforeY),
            scrollHeight: scrollContainer.getScrollHeight(),
            maxScrollY: scrollContainer.getMaxScrollY(),
          });

          // Restore
          scrollContainer.scrollTo(beforeY);
        })();
        return true;
      }

      default:
        sendResponse({ success: false, error: 'Unknown action' });
        return true;
    }
  });

  log('Content script loaded (multi-strategy scroll)');
})();
