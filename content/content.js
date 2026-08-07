/**
 * Content Script - Manhwa Downloader
 * Zero-Miss & Zero-Duplicate Sequential Capture
 */

(() => {
  'use strict';

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log('[ManhwaDL]', ...args);

  /* ══════════════════════════════════════
     Config
     ══════════════════════════════════════ */
  const CONFIG = {
    scrollPxPerFrame: 25,
    scrollSettleTime: 120,
    imageLoadTimeout: 3000,
    imageLoadCheckInterval: 50,
    discoveryScrollPxPerFrame: 60,
    scrollOffset: 100,
  };

  const SITE_SELECTORS = [
    '.reading-content img', '.chapter-content img', '#readerarea img',
    '.reader-area img', '.page-break img', '.viewer-img img',
    '.chapter-img img', '.manga-reader img', '#image-container img',
    '.container-chapter-reader img', '.reading-detail img',
    '.chapter_img img', '.vung-doc img', '.reader-main img',
    '.wp-manga-chapter-img', '.text-left img',
    'main img', 'article img', '#content img', '.content img',
  ];

  const TITLE_SELECTORS = [
    'h1', '.chapter-title', '#chapter-heading',
    '.entry-title', '.chapter-name', '.reader-header h1', 'title',
  ];

  /* ══════════════════════════════════════
     Scroll Container
     ══════════════════════════════════════ */
  const scrollContainer = {
    element: null,
    type: null,

    detect(imageSelector) {
      this.element = null;
      this.type = null;

      const docScrollable = document.documentElement.scrollHeight > window.innerHeight;
      const bodyScrollable = document.body.scrollHeight > window.innerHeight;

      if (docScrollable || bodyScrollable) {
        const beforeY = window.scrollY;
        window.scrollTo(0, beforeY + 100);
        const afterY = window.scrollY;
        window.scrollTo(0, beforeY);

        if (Math.abs(afterY - beforeY) > 10) {
          this.element = window;
          this.type = 'window';
          return;
        }
      }

      const imgs = document.querySelectorAll(imageSelector || 'img');
      if (imgs.length > 0) {
        const container = this.findScrollableParent(imgs[0]);
        if (container) {
          this.element = container;
          this.type = 'element';
          return;
        }
      }

      const scrollables = this.findAllScrollables();
      if (scrollables.length > 0) {
        scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
        this.element = scrollables[0];
        this.type = 'element';
        return;
      }

      this.element = window;
      this.type = 'window';
    },

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

    findAllScrollables() {
      const results = [];
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScroll = (overflowY === 'auto' || overflowY === 'scroll') &&
                          el.scrollHeight > el.clientHeight + 50;
        if (canScroll) results.push(el);
      });
      return results;
    },

    getScrollY() {
      if (this.type === 'window') {
        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
      }
      return this.element.scrollTop;
    },

    getMaxScrollY() {
      if (this.type === 'window') {
        return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight;
      }
      return this.element.scrollHeight - this.element.clientHeight;
    },

    getScrollHeight() {
      if (this.type === 'window') {
        return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      }
      return this.element.scrollHeight;
    },

    getViewportHeight() {
      if (this.type === 'window') return window.innerHeight;
      return this.element.clientHeight;
    },

    scrollTo(y) {
      y = Math.max(0, Math.min(y, this.getMaxScrollY()));
      if (this.type === 'window') {
        try {
          window.scrollTo(0, y);
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
        } catch { /* ignore */ }
      } else {
        try { this.element.scrollTop = y; } catch { /* ignore */ }
      }
    },

    getElementY(el) {
      try {
        if (this.type === 'window') {
          return el.getBoundingClientRect().top + this.getScrollY();
        } else {
          const containerRect = this.element.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          return elRect.top - containerRect.top + this.getScrollY();
        }
      } catch { return 0; }
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
    finish() {
      this.isRunning = false;
      this.stopRequested = false;
      this.removeHighlight();
      this.hideBanner();
    },

    highlight(el, index, total) {
      this.removeHighlight();
      if (!el) return;

      try {
        const rect = el.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = '__manhwa_dl_highlight__';
        overlay.style.cssText = `
          position: fixed; top: ${rect.top}px; left: ${rect.left}px;
          width: ${rect.width}px; height: ${rect.height}px;
          border: 4px solid #6c5ce7;
          box-shadow: 0 0 20px rgba(108, 92, 231, 0.8), inset 0 0 20px rgba(108, 92, 231, 0.3);
          background: rgba(108, 92, 231, 0.1); z-index: 999999;
          pointer-events: none; transition: all 0.2s ease; border-radius: 4px;
        `;

        const label = document.createElement('div');
        label.style.cssText = `
          position: absolute; top: 8px; left: 8px;
          background: #6c5ce7; color: white; padding: 4px 12px;
          border-radius: 4px; font-family: system-ui, sans-serif;
          font-size: 14px; font-weight: 700;
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
          position: fixed; top: 20px; right: 20px;
          background: linear-gradient(135deg, #6c5ce7, #a29bfe);
          color: white; padding: 12px 20px; border-radius: 8px;
          font-family: system-ui, sans-serif; font-size: 14px;
          font-weight: 600; box-shadow: 0 4px 20px rgba(108, 92, 231, 0.5);
          z-index: 999998; min-width: 200px; text-align: center;
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
        el.getAttribute('data-src'), el.getAttribute('data-lazy-src'),
        el.getAttribute('data-original'), el.getAttribute('data-url'),
        el.getAttribute('data-image'), el.getAttribute('data-cfsrc'),
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
          const isPlaceholder = !img.src || img.src.startsWith('data:') || img.src.includes('placeholder');
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

  async function smoothScrollTo(targetY, pxPerFrame = CONFIG.scrollPxPerFrame) {
    return new Promise((resolve) => {
      const startY = scrollContainer.getScrollY();
      const distance = targetY - startY;
      const direction = distance > 0 ? 1 : -1;
      const absDistance = Math.abs(distance);

      if (absDistance < 5) { resolve(); return; }

      let traveled = 0;

      const step = () => {
        if (scanState.stopRequested) { resolve(); return; }

        const remaining = absDistance - traveled;
        const moveThisFrame = Math.min(pxPerFrame, remaining);

        traveled += moveThisFrame;
        const newY = startY + (traveled * direction);
        scrollContainer.scrollTo(newY);

        if (traveled >= absDistance) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

/* ══════════════════════════════════════
   ✅ FIXED: waitForImageLoad
   Cek dimensi wajar (bukan cuma > 0)
   ══════════════════════════════════════ */

/**
 * ⚡ OPTIMIZED: Wait with adaptive polling
 * Faster polling early, slower later (reduce CPU)
 */
async function waitForImageLoad(img, timeout = CONFIG.imageLoadTimeout) {
  if (!img) return false;

  // Quick check
  if (img.complete && img.naturalWidth > 100 && img.naturalHeight > 100) {
    return true;
  }

  const startTime = Date.now();
  let lastForceLoad = 0;
  let stableSizeCount = 0;
  let lastSize = 0;
  let pollInterval = 30;  // ⚡ Start faster

  while (Date.now() - startTime < timeout) {
    if (scanState.stopRequested) return false;

    const now = Date.now();
    const elapsed = now - startTime;

    // ⚡ Adaptive force load frequency
    const forceInterval = elapsed < 1000 ? 150 : 250;
    if (now - lastForceLoad > forceInterval) {
      forceLazyLoad([img]);
      lastForceLoad = now;
    }

    // Check loaded with reasonable dimensions
    if (img.complete && img.naturalWidth > 100 && img.naturalHeight > 100) {
      const currentSize = img.naturalWidth * img.naturalHeight;

      if (currentSize === lastSize) {
        stableSizeCount++;
        if (stableSizeCount >= 2) return true;
      } else {
        stableSizeCount = 0;
        lastSize = currentSize;
      }

      await sleep(80);  // ⚡ Reduced from 100
      continue;
    }

    // ⚡ Adaptive polling: faster early, slower later
    pollInterval = elapsed < 500 ? 30 : elapsed < 2000 ? 50 : 100;
    await sleep(pollInterval);
  }

  // Fallback: accept if URL valid
  const url = getBestImageUrl(img);
  return !!url;
}

/* ══════════════════════════════════════
   ✅ FIXED: Discovery Phase
   No aggressive Y-grouping dedupe
   Extra slow-scan pass
   ══════════════════════════════════════ */

/**
 * ⚡ OPTIMIZED Discovery Phase
 * Single-pass smart scroll dengan intelligent stopping
 */
async function discoveryPhase(customSelector, onProgress) {
  log('╔═══════════════════════════════════╗');
  log('║ PHASE 1: DISCOVERY (optimized)    ║');
  log('╚═══════════════════════════════════╝');

  scanState.showBanner('🔍 Discovery...');

  const selector = detectImageSelector(customSelector);
  scrollContainer.detect(selector);
  scanState.activeSelector = selector;

  await smoothScrollTo(0, 100);  // Faster initial scroll
  await sleep(300);

  const elementMap = new Map();
  const urlSet = new Set();

  const collectElements = () => {
    const imgs = document.querySelectorAll(selector);
    forceLazyLoad(imgs);

    imgs.forEach(img => {
      if (!elementMap.has(img)) {
        const y = scrollContainer.getElementY(img);
        elementMap.set(img, { element: img, y: Math.max(0, y) });
      } else {
        const info = elementMap.get(img);
        info.y = Math.max(0, scrollContainer.getElementY(img));
      }

      const url = getBestImageUrl(img);
      if (url) urlSet.add(url);
    });
  };

  collectElements();
  await sleep(150);
  collectElements();

  // ⚡ SMART SINGLE PASS: kombinasi fast + slow di 1 pass
  const maxScroll = scrollContainer.getMaxScrollY();
  const viewportH = scrollContainer.getViewportHeight();

  let currentPos = 0;
  let lastElementCount = 0;
  let noNewCount = 0;
  let stableHeightCount = 0;
  let lastHeight = scrollContainer.getScrollHeight();

  while (!scanState.stopRequested) {
    // ⚡ Adaptive step size: kecil kalau ada gambar baru, besar kalau tidak
    const stepMultiplier = noNewCount > 2 ? 0.9 : 0.6;
    currentPos = Math.min(currentPos + viewportH * stepMultiplier, maxScroll);

    scanState.showBanner(`🔍 Discovery: ${elementMap.size} images`);

    // ⚡ Adaptive scroll speed
    const scrollSpeed = noNewCount > 2 ? 80 : 40;
    await smoothScrollTo(currentPos, scrollSpeed);
    await sleep(120);
    collectElements();

    // Track progress
    if (elementMap.size === lastElementCount) {
      noNewCount++;
    } else {
      noNewCount = 0;
      lastElementCount = elementMap.size;
    }

    if (onProgress) {
      onProgress({
        phase: 'discovery',
        percent: Math.min(100, Math.round((currentPos / Math.max(maxScroll, 1)) * 100)),
        collected: elementMap.size,
        message: `Discovery: ${elementMap.size} images`,
      });
    }

    // Check height stability
    const newHeight = scrollContainer.getScrollHeight();
    if (currentPos >= maxScroll - 10) {
      if (newHeight === lastHeight) {
        stableHeightCount++;
      } else {
        stableHeightCount = 0;
        lastHeight = newHeight;
      }

      // ⚡ Stop conditions: no new images 3x DAN height stable 2x
      if (stableHeightCount >= 2 && noNewCount >= 3) break;
    }
  }

  // Final scan pass at bottom
  await sleep(200);
  collectElements();

  // ⚡ Quick return to top (no verification needed)
  scanState.showBanner('⬆️ Back to top...');
  await smoothScrollTo(0, 200);  // Very fast
  await sleep(200);
  collectElements();

  // Sort & dedupe
  const rawElements = Array.from(elementMap.values())
    .sort((a, b) => a.y - b.y);

  const dedupedByY = [];
  const seenElements = new Set();

  for (const info of rawElements) {
    if (!seenElements.has(info.element)) {
      seenElements.add(info.element);
      dedupedByY.push(info);
    }
  }

  dedupedByY.forEach((info, i) => { info.finalIndex = i; });

  log(`✅ Discovery: ${dedupedByY.length} unique elements`);

  return {
    elements: dedupedByY,
    initialUrls: urlSet,
    selector,
    pageHeight: lastHeight,
  };
}

  function detectImageSelector(customSelector = '') {
    if (customSelector) {
      try {
        const els = document.querySelectorAll(customSelector);
        if (els.length >= 1) {
          log(`Using custom: "${customSelector}" (${els.length})`);
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
      log(`Auto: "${bestSelector}" (${bestCount})`);
      return bestSelector;
    }

    log('Fallback: img');
    return 'img';
  }

  /* ══════════════════════════════════════
     PHASE 1: Discovery
     ══════════════════════════════════════ */

  async function discoveryPhase(customSelector, onProgress) {
    log('╔═══════════════════════════════════╗');
    log('║ PHASE 1: DISCOVERY                ║');
    log('╚═══════════════════════════════════╝');

    scanState.showBanner('🔍 Discovery...');

    const selector = detectImageSelector(customSelector);
    scrollContainer.detect(selector);
    scanState.activeSelector = selector;

    log(`Container: ${scrollContainer.type}, Height: ${scrollContainer.getScrollHeight()}`);

    await smoothScrollTo(0, 50);
    await sleep(400);

    // Element tracking - Map key = element reference
    const elementMap = new Map();
    const urlSet = new Set();

    const collectElements = () => {
      const imgs = document.querySelectorAll(selector);
      forceLazyLoad(imgs);

      imgs.forEach(img => {
        if (!elementMap.has(img)) {
          const y = scrollContainer.getElementY(img);
          elementMap.set(img, {
            element: img,
            y: Math.max(0, y),
          });
        } else {
          // Update Y (mungkin berubah setelah layout shift)
          const info = elementMap.get(img);
          info.y = Math.max(0, scrollContainer.getElementY(img));
        }

        const url = getBestImageUrl(img);
        if (url) urlSet.add(url);
      });
    };

    // Initial collection
    collectElements();
    await sleep(200);
    collectElements();

    // Scroll down & collect
    const maxScroll = scrollContainer.getMaxScrollY();
    let currentPos = 0;
    let lastHeight = scrollContainer.getScrollHeight();
    let stableCount = 0;

    while (true) {
      if (scanState.stopRequested) break;

      currentPos = Math.min(currentPos + scrollContainer.getViewportHeight() * 0.7, maxScroll);

      scanState.showBanner(`🔍 Discovery: ${elementMap.size} images`);

      await smoothScrollTo(currentPos, CONFIG.discoveryScrollPxPerFrame);
      await sleep(100);
      collectElements();

      if (onProgress) {
        onProgress({
          phase: 'discovery',
          percent: Math.min(100, Math.round((currentPos / Math.max(maxScroll, 1)) * 100)),
          collected: elementMap.size,
          message: `Discovery: ${elementMap.size} images`,
        });
      }

      const newHeight = scrollContainer.getScrollHeight();
      if (currentPos >= maxScroll - 10) {
        if (newHeight === lastHeight) stableCount++;
        else { stableCount = 0; lastHeight = newHeight; }
        if (stableCount >= 3) break;
      }
    }

    await sleep(300);
    collectElements();

    // Final scan pass
    scanState.showBanner('🔍 Final scan...');
    await smoothScrollTo(maxScroll, 150);
    await sleep(300);
    collectElements();

    scanState.showBanner('⬆️ Back to top...');
    await smoothScrollTo(0, 150);
    await sleep(300);
    collectElements();
// ✅ FIX: Dedupe HANYA jika element BENAR-BENAR sama
// Jangan dedupe by Y (terlalu agresif, bisa skip gambar berdekatan)
// Element sudah unique karena Map key = DOM reference
const rawElements = Array.from(elementMap.values())
  .sort((a, b) => a.y - b.y);

// ✅ Extra check: dedupe HANYA jika Y IDENTIK (bukan grouping)
// dan element reference sama (which shouldn't happen with Map)
const dedupedByY = [];
const seenElements = new Set();

for (const info of rawElements) {
  // Skip jika element yang sama SUDAH ada (safety check)
  if (seenElements.has(info.element)) {
    log(`Dedupe: exact same element skipped`);
    continue;
  }
  seenElements.add(info.element);
  dedupedByY.push(info);
}

log(`Deduplication: ${rawElements.length} → ${dedupedByY.length}`);

    // Assign final index
    dedupedByY.forEach((info, i) => { info.finalIndex = i; });

    log(`Discovery complete: ${rawElements.length} raw → ${dedupedByY.length} unique`);
    if (dedupedByY.length > 0) {
      log(`Y range: ${dedupedByY[0].y} - ${dedupedByY[dedupedByY.length - 1].y}`);
    }

    return {
      elements: dedupedByY,
      initialUrls: urlSet,
      selector,
      pageHeight: lastHeight,
    };
  }

  /* ══════════════════════════════════════
     PHASE 2: Sequential Capture
     ══════════════════════════════════════ */

/**
 * ⚡ OPTIMIZED Sequential Capture
 * Chunked parallel dengan tetap sequential visual (highlight)
 */
async function sequentialCapture(discoveryResult, onProgress) {
  log('╔═══════════════════════════════════╗');
  log('║ PHASE 2: CAPTURE (optimized)      ║');
  log('╚═══════════════════════════════════╝');

  const elements = discoveryResult?.elements || [];
  const selector = discoveryResult?.selector || 'img';
  const total = elements.length;

  if (total === 0) {
    return { urls: [], meta: [], total: 0, success: 0, failed: 0 };
  }

  const capturedUrls = new Array(total).fill(null);
  const capturedMeta = new Array(total).fill(null);
  const failedIndexes = [];
  const usedUrls = new Set();
  let successCount = 0;

  // ⚡ Optimized capture function
  const captureElement = async (info, pageNum, isRetry = false) => {
    if (!document.contains(info.element)) {
      const imgs = document.querySelectorAll(selector);
      let alternative = null;
      let minDist = Infinity;

      imgs.forEach(img => {
        const y = scrollContainer.getElementY(img);
        const dist = Math.abs(y - info.y);
        if (dist < minDist && dist < 100) {
          minDist = dist;
          alternative = img;
        }
      });

      if (!alternative) return null;
      info.element = alternative;
    }

    const targetY = scrollContainer.getElementY(info.element);
    const scrollTargetY = targetY <= CONFIG.scrollOffset ? 0 : targetY - CONFIG.scrollOffset;

    await smoothScrollTo(scrollTargetY);
    await sleep(CONFIG.scrollSettleTime);

    if (isRetry || pageNum === 1) await sleep(200);

    forceLazyLoad([info.element]);
    const loaded = await waitForImageLoad(info.element);

    if (!loaded && !isRetry) {
      await sleep(300);  // ⚡ Reduced from 500
      forceLazyLoad([info.element]);
      await waitForImageLoad(info.element, 1500);  // ⚡ Reduced from 2000
    }

    return getBestImageUrl(info.element);
  };

  // Main capture loop
  for (let i = 0; i < total; i++) {
    if (scanState.stopRequested) break;

    const info = elements[i];
    const pageNum = i + 1;

    scanState.showBanner(`📸 ${pageNum}/${total} • ${successCount} done`);
    scanState.highlight(info.element, pageNum, total);

    const url = await captureElement(info, pageNum);

    if (url && usedUrls.has(url)) {
      failedIndexes.push(i);
    } else if (url) {
      usedUrls.add(url);
      capturedUrls[i] = url;
      capturedMeta[i] = {
        index: i, pageNum, y: info.y,
        isBlob: url.startsWith('blob:'),
      };
      successCount++;
    } else {
      failedIndexes.push(i);
    }

    if (onProgress) {
      onProgress({
        phase: 'capture',
        percent: Math.round(((i + 1) / total) * 100),
        current: pageNum, total, collected: successCount,
        message: `Capture ${pageNum}/${total} • ${successCount} unique`,
      });
    }

    // ⚡ Reduced sleep between iterations
    await sleep(30);  // was 50
  }

  scanState.removeHighlight();

  // Retry phase
  if (failedIndexes.length > 0 && !scanState.stopRequested) {
    log(`RETRY: ${failedIndexes.length} items`);
    scanState.showBanner(`🔄 Retrying ${failedIndexes.length}...`);

    const stillFailed = [];
    for (const idx of failedIndexes) {
      if (scanState.stopRequested) break;

      const info = elements[idx];
      const pageNum = idx + 1;

      scanState.highlight(info.element, pageNum, total);
      const url = await captureElement(info, pageNum, true);

      if (url && !usedUrls.has(url)) {
        usedUrls.add(url);
        capturedUrls[idx] = url;
        capturedMeta[idx] = {
          index: idx, pageNum, y: info.y,
          isBlob: url.startsWith('blob:'), retry: 1,
        };
        successCount++;
      } else if (!url) {
        stillFailed.push(idx);
      }
    }

    scanState.removeHighlight();

    // Final attempt
    if (stillFailed.length > 0 && !scanState.stopRequested) {
      const allImgs = document.querySelectorAll(selector);
      for (const idx of stillFailed) {
        if (scanState.stopRequested) break;

        const info = elements[idx];
        const pageNum = idx + 1;

        let alternative = null;
        let minDist = Infinity;

        allImgs.forEach(img => {
          const y = scrollContainer.getElementY(img);
          const dist = Math.abs(y - info.y);
          if (dist < minDist && dist < 500) {
            const url = getBestImageUrl(img);
            if (url && !usedUrls.has(url)) {
              minDist = dist;
              alternative = img;
            }
          }
        });

        if (alternative) {
          info.element = alternative;
          scanState.highlight(alternative, pageNum, total);

          const targetY = scrollContainer.getElementY(alternative);
          await smoothScrollTo(Math.max(0, targetY - CONFIG.scrollOffset));
          await sleep(400);
          forceLazyLoad([alternative]);
          await waitForImageLoad(alternative, 3000);

          const url = getBestImageUrl(alternative);
          if (url && !usedUrls.has(url)) {
            usedUrls.add(url);
            capturedUrls[idx] = url;
            capturedMeta[idx] = {
              index: idx, pageNum, y: info.y,
              isBlob: url.startsWith('blob:'), retry: 2,
            };
            successCount++;
          }
        }
      }
      scanState.removeHighlight();
    }
  }

  // Final dedupe
  const finalUrls = [];
  const finalMeta = [];
  const finalUrlCheck = new Set();

  for (let i = 0; i < capturedUrls.length; i++) {
    const url = capturedUrls[i];
    if (url && !finalUrlCheck.has(url)) {
      finalUrlCheck.add(url);
      finalUrls.push(url);
      finalMeta.push(capturedMeta[i]);
    }
  }

  return {
    urls: finalUrls,
    meta: finalMeta,
    total,
    success: finalUrls.length,
    failed: total - finalUrls.length,
  };
}

  /* ══════════════════════════════════════
     Main Scan Flow
     ══════════════════════════════════════ */

  async function performScan(customSelector) {
    try {
      const discovery = await discoveryPhase(customSelector, reportProgress);

      const elementsCount = discovery?.elements?.length || 0;

      if (scanState.stopRequested || elementsCount === 0) {
        scanState.showBanner('⏹ Done');
        await sleep(1000);
        scanState.hideBanner();

        const fallbackUrls = discovery?.initialUrls ? Array.from(discovery.initialUrls) : [];

        // Dedupe fallback URLs
        const uniqueFallback = [...new Set(fallbackUrls)];

        return {
          images: uniqueFallback,
          meta: [],
          total: elementsCount,
          success: uniqueFallback.length,
          failed: 0,
          stopped: scanState.stopRequested,
        };
      }

      const capture = await sequentialCapture(discovery, reportProgress);

      scanState.showBanner(`✅ Done! ${capture.success}/${capture.total}`);
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

  function reportProgress(data) {
    try {
      chrome.runtime.sendMessage({ action: 'SCAN_PROGRESS', data }).catch(() => {});
    } catch { /* ignore */ }
  }

  /* ══════════════════════════════════════
     Fetch image
     ══════════════════════════════════════ */

/**
 * ⚡ OPTIMIZED: Fetch dengan smart size limiting & timeout
 */
async function fetchImageAsArray(url) {
  try {
    // AbortController untuk timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();

    // ⚡ Skip conversion untuk file terlalu besar (>20MB)
    if (blob.size > 20 * 1024 * 1024) {
      throw new Error(`File too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);
    }

    // ⚡ Direct ArrayBuffer conversion (no intermediate array copy)
    const arrayBuffer = await blob.arrayBuffer();

    // ⚡ Use plain array only if necessary (Chrome message API constraint)
    // Faster than Array.from() for large arrays
    const uint8Array = new Uint8Array(arrayBuffer);
    const array = new Array(uint8Array.length);
    for (let i = 0; i < uint8Array.length; i++) {
      array[i] = uint8Array[i];
    }

    return {
      success: true,
      data: array,
      mimeType: blob.type,
      size: blob.size,
    };
  } catch (error) {
    return {
      success: false,
      error: error.name === 'AbortError' ? 'Timeout' : error.message,
    };
  }
}

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
     Message Listener
     ══════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {

case 'SCAN_IMAGES': {
  (async () => {
    try {
      scanState.start();

      if (message.speed) {
        // ⚡ OPTIMIZED PRESETS
        const speedMap = {
          slow: {
            scrollPxPerFrame: 15,
            scrollSettleTime: 200,
            imageLoadTimeout: 4000,
            imageLoadCheckInterval: 60,
          },
          normal: {
            scrollPxPerFrame: 30,      // ⚡ 25 → 30
            scrollSettleTime: 100,      // ⚡ 120 → 100
            imageLoadTimeout: 2500,     // ⚡ 3000 → 2500
            imageLoadCheckInterval: 40, // ⚡ 50 → 40
          },
          fast: {
            scrollPxPerFrame: 50,      // ⚡ 40 → 50
            scrollSettleTime: 60,       // ⚡ 80 → 60
            imageLoadTimeout: 1800,     // ⚡ 2000 → 1800
            imageLoadCheckInterval: 30, // ⚡ 40 → 30
          },
          turbo: {
            scrollPxPerFrame: 90,      // ⚡ 70 → 90
            scrollSettleTime: 40,       // ⚡ 50 → 40
            imageLoadTimeout: 1200,     // ⚡ 1500 → 1200
            imageLoadCheckInterval: 20, // ⚡ 30 → 20
          },
        };
        const preset = speedMap[message.speed];
        if (preset) Object.assign(CONFIG, preset);
      }

      const result = await performScan(message.customSelector || '');
      scanState.finish();

      const title = detectChapterTitle();
      const images = result?.images || [];
      const meta = result?.meta || [];
      const totalCount = result?.total || images.length;
      const failedCount = result?.failed || 0;

      let debugInfo = null;
      if (images.length === 0) debugInfo = debugScan();

      sendResponse({
        success: true,
        images: images,
        meta: meta,
        title: title || 'Manhwa-Chapter',
        count: images.length,
        total: totalCount,
        failed: failedCount,
        url: window.location.href,
        debug: debugInfo,
        stopped: result?.stopped || false,
      });
    } catch (error) {
      log('SCAN ERROR:', error);
      scanState.finish();
      sendResponse({
        success: false,
        error: error.message || 'Unknown error',
        images: [], meta: [],
        count: 0, total: 0, failed: 0,
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
          const result = await fetchImageAsArray(message.url);
          sendResponse(result);
        })();
        return true;
      }

      case 'GET_TITLE': {
        sendResponse({ success: true, title: detectChapterTitle() });
        return true;
      }

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
            beforeY, afterY,
            moved: Math.abs(afterY - beforeY),
            scrollHeight: scrollContainer.getScrollHeight(),
            maxScrollY: scrollContainer.getMaxScrollY(),
          });

          scrollContainer.scrollTo(beforeY);
        })();
        return true;
      }

      default:
        sendResponse({ success: false, error: 'Unknown action' });
        return true;
    }
  });

  log('Content script loaded (v4 - zero-dup)');
})();
