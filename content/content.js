/**
 * Content Script - Manhwa Downloader v2.1.1
 * Extreme optimization: pipeline, native APIs, smart discovery
 */

(() => {
  'use strict';

  // Guard: mencegah re-injection (manifest + executeScript fallback)
  if (window.__manhwaDLInjected) return;
  window.__manhwaDLInjected = true;

  const DEBUG = false;
  
  const log = (...args) => DEBUG && console.log('[ManhwaDL]', ...args);

  /* ══════════════════════════════════════
     Configuration (frozen for V8 optimization)
     ══════════════════════════════════════ */

  const CONFIG = {
    scrollPxPerFrame: 30,
    scrollSettleTime: 100,
    imageLoadTimeout: 2500,
    imageLoadCheckInterval: 40,
    discoveryScrollPxPerFrame: 70,
    scrollOffset: 100,
    maxFileSize: 20 * 1024 * 1024,
    fetchTimeout: 15000,
  };

  const SPEED_PRESETS = Object.freeze({
    slow: Object.freeze({
      scrollPxPerFrame: 15,
      scrollSettleTime: 200,
      imageLoadTimeout: 4000,
      imageLoadCheckInterval: 60,
    }),
    normal: Object.freeze({
      scrollPxPerFrame: 30,
      scrollSettleTime: 100,
      imageLoadTimeout: 2500,
      imageLoadCheckInterval: 40,
    }),
    fast: Object.freeze({
      scrollPxPerFrame: 50,
      scrollSettleTime: 60,
      imageLoadTimeout: 1800,
      imageLoadCheckInterval: 30,
    }),
    turbo: Object.freeze({
      scrollPxPerFrame: 90,
      scrollSettleTime: 40,
      imageLoadTimeout: 1200,
      imageLoadCheckInterval: 20,
    }),
  });

  const SITE_SELECTORS = Object.freeze([
    '.reading-content img', '.chapter-content img', '#readerarea img',
    '.reader-area img', '.page-break img', '.viewer-img img',
    '.chapter-img img', '.manga-reader img', '#image-container img',
    '.container-chapter-reader img', '.reading-detail img',
    '.chapter_img img', '.vung-doc img', '.reader-main img',
    '.wp-manga-chapter-img', '.text-left img',
    'main img', 'article img', '#content img', '.content img',
  ]);

  const TITLE_SELECTORS = Object.freeze([
    'h1', '.chapter-title', '#chapter-heading',
    '.entry-title', '.chapter-name', '.reader-header h1', 'title',
  ]);

  const BLACKLIST_PATTERNS = Object.freeze([
    /\/favicon\./i, /\/logo[-_./]/i, /\/avatar[-_./]/i,
    /\/emoji[-_./]/i, /\/tracking[-_./]/i, /google.*analytics/i,
    /facebook\.com\/tr/i, /doubleclick/i, /adservice/i, /disqus/i,
  ]);

  const LAZY_LOAD_ATTRS = Object.freeze([
    'data-src', 'data-lazy-src', 'data-original',
    'data-url', 'data-image', 'data-cfsrc',
  ]);

  /* ══════════════════════════════════════
     Scroll Container Manager
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
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            current.scrollHeight > current.clientHeight) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    },

    findAllScrollables() {
      const results = [];
      const all = document.querySelectorAll('*');
      const len = all.length;
      for (let i = 0; i < len; i++) {
        const el = all[i];
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 50) {
          results.push(el);
        }
      }
      return results;
    },

    getScrollY() {
      return this.type === 'window'
        ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop)
        : this.element.scrollTop;
    },

    getMaxScrollY() {
      if (this.type === 'window') {
        return Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ) - window.innerHeight;
      }
      return this.element.scrollHeight - this.element.clientHeight;
    },

    getScrollHeight() {
      return this.type === 'window'
        ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
        : this.element.scrollHeight;
    },

    getViewportHeight() {
      return this.type === 'window' ? window.innerHeight : this.element.clientHeight;
    },

    scrollTo(y) {
      y = Math.max(0, Math.min(y, this.getMaxScrollY()));
      if (this.type === 'window') {
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
      } else {
        this.element.scrollTop = y;
      }
    },

    getElementY(el) {
      try {
        if (this.type === 'window') {
          return el.getBoundingClientRect().top + this.getScrollY();
        }
        const containerRect = this.element.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        return elRect.top - containerRect.top + this.getScrollY();
      } catch { return 0; }
    },
  };

  /* ══════════════════════════════════════
     Scan State
     ══════════════════════════════════════ */

  const scanState = {
    isRunning: false,
    stopRequested: false,
    highlightEl: null,
    bannerEl: null,

    start() {
      this.isRunning = true;
      this.stopRequested = false;
    },

    stop() { this.stopRequested = true; },

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
          position:fixed;top:${rect.top}px;left:${rect.left}px;
          width:${rect.width}px;height:${rect.height}px;
          border:4px solid #6c5ce7;
          box-shadow:0 0 20px rgba(108,92,231,0.8),inset 0 0 20px rgba(108,92,231,0.3);
          background:rgba(108,92,231,0.1);z-index:999999;
          pointer-events:none;border-radius:4px;
          contain:layout style paint;
        `;

        const label = document.createElement('div');
        label.style.cssText = `
          position:absolute;top:8px;left:8px;
          background:#6c5ce7;color:white;padding:4px 12px;
          border-radius:4px;font-family:system-ui,sans-serif;
          font-size:14px;font-weight:700;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
        `;
        label.textContent = `📸 ${index}/${total}`;

        overlay.appendChild(label);
        document.body.appendChild(overlay);
        this.highlightEl = overlay;
      } catch { /* ignore */ }
    },

    removeHighlight() {
      if (this.highlightEl) {
        this.highlightEl.remove();
        this.highlightEl = null;
      }
    },

    showBanner(text) {
      if (!this.bannerEl) {
        this.bannerEl = document.createElement('div');
        this.bannerEl.id = '__manhwa_dl_banner__';
        this.bannerEl.style.cssText = `
          position:fixed;top:20px;right:20px;
          background:linear-gradient(135deg,#6c5ce7,#a29bfe);
          color:white;padding:12px 20px;border-radius:8px;
          font-family:system-ui,sans-serif;font-size:14px;
          font-weight:600;box-shadow:0 4px 20px rgba(108,92,231,0.5);
          z-index:999998;min-width:200px;text-align:center;
          contain:layout style;
        `;
        document.body.appendChild(this.bannerEl);
      }
      this.bannerEl.textContent = text;
    },

    hideBanner() {
      if (this.bannerEl) {
        this.bannerEl.remove();
        this.bannerEl = null;
      }
    },
  };

  /* ══════════════════════════════════════
     Utilities (Optimized)
     ══════════════════════════════════════ */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .trim()
      .substring(0, 100);
  }

  function detectChapterTitle() {
    const len = TITLE_SELECTORS.length;
    for (let i = 0; i < len; i++) {
      const el = document.querySelector(TITLE_SELECTORS[i]);
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
    if (!src || typeof src !== 'string') return false;
    if (src.startsWith('data:')) return false;
    if (src.startsWith('blob:')) return true;
    if (!src.toLowerCase().startsWith('http')) return false;

    const lower = src.toLowerCase();
    const len = BLACKLIST_PATTERNS.length;
    for (let i = 0; i < len; i++) {
      if (BLACKLIST_PATTERNS[i].test(lower)) return false;
    }
    return true;
  }

  function extractSrcsetCandidates(el) {
    const result = [];
    const attrs = ['srcset', 'data-srcset', 'data-lazy-srcset'];
    for (let a = 0; a < attrs.length; a++) {
      const raw = el.getAttribute && el.getAttribute(attrs[a]);
      if (!raw) continue;
      const parts = raw.split(',');
      for (let p = 0; p < parts.length; p++) {
        const url = parts[p].trim().split(/\s+/)[0];
        if (url && !url.startsWith('data:')) {
          try {
            result.push(new URL(url, window.location.href).href);
          } catch { /* skip */ }
        }
      }
    }
    return result;
  }

  function getBestImageUrl(el) {
    if (!el) return null;

    // ⚡ Hot path optimization: check src first (most common)
    const src = el.src;
    if (src && !src.startsWith('data:') && src.trim() !== '') {
      if (src.startsWith('blob:')) return src;
      try {
        const abs = new URL(src, window.location.href).href;
        if (validateImageUrl(abs)) return abs;
      } catch { /* ignore */ }
    }

    // Fallback: check other attributes
    const candidates = el.tagName === 'IMG' ? [
      el.currentSrc,
      el.dataset.src,
      el.dataset.lazySrc,
      el.dataset.original,
      el.getAttribute('data-src'),
      el.getAttribute('data-lazy-src'),
      el.getAttribute('data-original'),
      el.getAttribute('data-url'),
      el.getAttribute('data-image'),
      el.getAttribute('data-cfsrc'),
    ].concat(extractSrcsetCandidates(el)) : [el.srcset, el.src];

    const len = candidates.length;
    for (let i = 0; i < len; i++) {
      const candidate = candidates[i];
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
    const targets = imgs || document.querySelectorAll('img');
    const attrsLen = LAZY_LOAD_ATTRS.length;
    const targetsLen = targets.length;

    for (let i = 0; i < targetsLen; i++) {
      const img = targets[i];
      const src = img.src;
      const isPlaceholder = !src || src.startsWith('data:') || src.includes('placeholder');

      if (isPlaceholder) {
        for (let j = 0; j < attrsLen; j++) {
          const val = img.getAttribute(LAZY_LOAD_ATTRS[j]);
          if (val && !val.startsWith('data:')) {
            img.src = val.split(',')[0].trim().split(/\s+/)[0];
            break; // ⚡ Stop after first valid
          }
        }

        // Handle responsive srcset lazy-load
        const dataSrcset = img.getAttribute('data-srcset');
        if (dataSrcset) img.srcset = dataSrcset;
      }

      if (img.loading === 'lazy') img.loading = 'eager';
    }
  }

  async function smoothScrollTo(targetY, pxPerFrame = CONFIG.scrollPxPerFrame) {
    return new Promise((resolve) => {
      const startY = scrollContainer.getScrollY();
      const distance = targetY - startY;
      const absDistance = Math.abs(distance);

      // Watchdog: rAF di-throttle/dihentikan di tab background (batch mode),
      // jadi pastikan tidak hang selamanya.
      const watchdog = setTimeout(resolve, 30000);

      if (absDistance < 5) {
        clearTimeout(watchdog);
        resolve();
        return;
      }

      const direction = distance > 0 ? 1 : -1;
      let traveled = 0;

      const step = () => {
        if (scanState.stopRequested) {
          clearTimeout(watchdog);
          resolve();
          return;
        }

        const remaining = absDistance - traveled;
        const moveThisFrame = Math.min(pxPerFrame, remaining);

        traveled += moveThisFrame;
        scrollContainer.scrollTo(startY + (traveled * direction));

        if (traveled >= absDistance) {
          clearTimeout(watchdog);
          resolve();
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
  }

  /**
   * ⚡ NATIVE: Wait using image load events (bukan polling)
   */
  function waitForImageLoadNative(img, timeout = CONFIG.imageLoadTimeout) {
    return new Promise((resolve) => {
      if (!img) {
        resolve(false);
        return;
      }

      // Sudah loaded
      if (img.complete && img.naturalWidth > 100) {
        resolve(true);
        return;
      }

      let resolved = false;
      let timeoutId = null;
      let checkIntervalId = null;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        clearInterval(checkIntervalId);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };

      const onLoad = () => {
        // Wait one frame untuk render selesai
        requestAnimationFrame(() => {
          cleanup();
          resolve(img.naturalWidth > 100);
        });
      };

      const onError = () => {
        cleanup();
        // Gambar gagal dimuat → jangan anggap valid
        resolve(false);
      };

      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', onError, { once: true });

      // Timeout fallback
      timeoutId = setTimeout(() => {
        if (resolved) return;

        // Cek satu kali lagi sebelum give up
        if (img.complete && img.naturalWidth > 100) {
          cleanup();
          resolve(true);
        } else {
          cleanup();
          resolve(!!getBestImageUrl(img)); // Terima jika URL valid
        }
      }, timeout);

      // ⚡ Periodic check untuk lazy load trigger
      const checkIntervalMs = CONFIG.imageLoadCheckInterval || 40;
      let checks = 0;
      checkIntervalId = setInterval(() => {
        if (resolved) return;
        checks++;

        forceLazyLoad([img]);

        if (img.complete && img.naturalWidth > 100) {
          cleanup();
          resolve(true);
        }

        // Stop checking after enough tries
        if (checks * checkIntervalMs >= timeout) {
          clearInterval(checkIntervalId);
        }
      }, checkIntervalMs);
    });
  }

  function detectImageSelector(customSelector = '') {
    if (customSelector) {
      try {
        const els = document.querySelectorAll(customSelector);
        if (els.length >= 1) return customSelector;
      } catch { /* invalid */ }
    }

    let bestSelector = null;
    let bestCount = 0;
    const len = SITE_SELECTORS.length;

    for (let i = 0; i < len; i++) {
      try {
        const count = document.querySelectorAll(SITE_SELECTORS[i]).length;
        if (count > bestCount) {
          bestCount = count;
          bestSelector = SITE_SELECTORS[i];
        }
      } catch { continue; }
    }

    return (bestSelector && bestCount >= 2) ? bestSelector : 'img';
  }

  /* ══════════════════════════════════════
     Phase 1: Discovery (Smart Skip)
     ══════════════════════════════════════ */

  async function discoveryPhase(customSelector, onProgress) {
    log('PHASE 1: DISCOVERY');
    scanState.showBanner('🔍 Discovery...');

    const selector = detectImageSelector(customSelector);
    scrollContainer.detect(selector);

    await smoothScrollTo(0, 100);
    await sleep(300);

    const elementMap = new Map();
    const urlSet = new Set();

    const collectElements = () => {
      const imgs = document.querySelectorAll(selector);
      forceLazyLoad(imgs);

      const len = imgs.length;
      for (let i = 0; i < len; i++) {
        const img = imgs[i];

        // Hanya simpan element yang punya URL valid (buang logo/avatar/tracker)
        const url = getBestImageUrl(img);
        if (url) {
          urlSet.add(url);
          if (!elementMap.has(img)) {
            const y = scrollContainer.getElementY(img);
            elementMap.set(img, { element: img, y: Math.max(0, y) });
          }
        }
      }
    };

    // Initial multi-collect
    collectElements();
    await sleep(150);
    collectElements();

    const initialCount = elementMap.size;

    // Smart single-pass discovery
    const maxScroll = scrollContainer.getMaxScrollY();
    const viewportH = scrollContainer.getViewportHeight();

    let currentPos = 0;
    let lastElementCount = 0;
    let noNewCount = 0;
    let stableHeightCount = 0;
    let lastHeight = scrollContainer.getScrollHeight();

    while (!scanState.stopRequested) {
      const stepMultiplier = noNewCount > 2 ? 0.9 : 0.6;
      currentPos = Math.min(currentPos + viewportH * stepMultiplier, maxScroll);

      scanState.showBanner(`🔍 ${elementMap.size} images`);

      const scrollSpeed = noNewCount > 2 ? 80 : 40;
      await smoothScrollTo(currentPos, scrollSpeed);
      await sleep(120);
      collectElements();

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

      const newHeight = scrollContainer.getScrollHeight();
      if (currentPos >= maxScroll - 10) {
        if (newHeight === lastHeight) stableHeightCount++;
        else { stableHeightCount = 0; lastHeight = newHeight; }
        if (stableHeightCount >= 2 && noNewCount >= 3) break;
      }
    }

    await sleep(150);
    collectElements();

    // ⚡ SMART SKIP: skip back-to-top jika sudah cukup detected
    const finalCount = elementMap.size;
    const growthRatio = finalCount / Math.max(initialCount, 1);

    if (growthRatio < 3 && finalCount > 5) {
      // Element sudah banyak sejak awal, tidak perlu balik ke atas
      log(`Skip back-to-top: ${finalCount} elements already detected`);
    } else {
      scanState.showBanner('⬆️ Back to top...');
      await smoothScrollTo(0, 250); // Very fast
      await sleep(150);
      collectElements();
    }

    // Sort & dedupe
    const rawElements = Array.from(elementMap.values())
      .sort((a, b) => a.y - b.y);

    const dedupedByY = [];
    const seenElements = new Set();

    const rawLen = rawElements.length;
    for (let i = 0; i < rawLen; i++) {
      const info = rawElements[i];
      if (!seenElements.has(info.element)) {
        seenElements.add(info.element);
        info.finalIndex = dedupedByY.length;
        dedupedByY.push(info);
      }
    }

    log(`Discovery: ${dedupedByY.length} unique elements`);

    return {
      elements: dedupedByY,
      initialUrls: urlSet,
      selector,
      pageHeight: lastHeight,
    };
  }

  /* ══════════════════════════════════════
     Phase 2: Sequential Capture (Native Wait)
     ══════════════════════════════════════ */

  async function sequentialCapture(discoveryResult, onProgress) {
    log('PHASE 2: CAPTURE');

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

    const captureElement = async (info, pageNum, isRetry = false) => {
      if (!document.contains(info.element)) {
        const imgs = document.querySelectorAll(selector);
        let alternative = null;
        let minDist = Infinity;
        const len = imgs.length;

        for (let i = 0; i < len; i++) {
          const img = imgs[i];
          const y = scrollContainer.getElementY(img);
          const dist = Math.abs(y - info.y);
          if (dist < minDist && dist < 100) {
            minDist = dist;
            alternative = img;
          }
        }

        if (!alternative) return null;
        info.element = alternative;
      }

      const targetY = scrollContainer.getElementY(info.element);
      const scrollTargetY = targetY <= CONFIG.scrollOffset ? 0 : targetY - CONFIG.scrollOffset;

      await smoothScrollTo(scrollTargetY);
      await sleep(CONFIG.scrollSettleTime);

      if (isRetry || pageNum === 1) await sleep(200);

      forceLazyLoad([info.element]);

      // ⚡ NATIVE wait (event-based, no polling)
      await waitForImageLoadNative(info.element);

      return getBestImageUrl(info.element);
    };

    // MAIN LOOP
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

      // ⚡ Minimal sleep (highlight sudah GPU-accelerated)
      await sleep(20);
    }

    scanState.removeHighlight();

    // RETRY PHASE
    if (failedIndexes.length > 0 && !scanState.stopRequested) {
      scanState.showBanner(`🔄 Retrying ${failedIndexes.length}...`);
      const stillFailed = [];

      const failedLen = failedIndexes.length;
      for (let f = 0; f < failedLen; f++) {
        if (scanState.stopRequested) break;

        const idx = failedIndexes[f];
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
        } else {
          // null ATAU URL duplikat → beri kesempatan di final attempt
          stillFailed.push(idx);
        }
      }

      scanState.removeHighlight();

      // FINAL ATTEMPT
      if (stillFailed.length > 0 && !scanState.stopRequested) {
        const allImgs = document.querySelectorAll(selector);
        const stillLen = stillFailed.length;

        for (let s = 0; s < stillLen; s++) {
          if (scanState.stopRequested) break;

          const idx = stillFailed[s];
          const info = elements[idx];
          const pageNum = idx + 1;

          let alternative = null;
          let minDist = Infinity;
          const imgsLen = allImgs.length;

          for (let a = 0; a < imgsLen; a++) {
            const img = allImgs[a];
            const y = scrollContainer.getElementY(img);
            const dist = Math.abs(y - info.y);
            if (dist < minDist && dist < 500) {
              const url = getBestImageUrl(img);
              if (url && !usedUrls.has(url)) {
                minDist = dist;
                alternative = img;
              }
            }
          }

          if (alternative) {
            info.element = alternative;
            scanState.highlight(alternative, pageNum, total);

            const targetY = scrollContainer.getElementY(alternative);
            await smoothScrollTo(Math.max(0, targetY - CONFIG.scrollOffset));
            await sleep(400);
            forceLazyLoad([alternative]);
            await waitForImageLoadNative(alternative, 3000);

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

    // Final dedupe with pre-allocated arrays
    const finalUrls = [];
    const finalMeta = [];
    const finalUrlCheck = new Set();

    const capLen = capturedUrls.length;
    for (let i = 0; i < capLen; i++) {
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
     Main Flow
     ══════════════════════════════════════ */

  async function performScan(customSelector) {
    try {
      const discovery = await discoveryPhase(customSelector, reportProgress);
      const elementsCount = discovery?.elements?.length || 0;

      if (scanState.stopRequested || elementsCount === 0) {
        scanState.showBanner('⏹ Done');
        await sleep(800);
        scanState.hideBanner();

        const fallbackUrls = discovery?.initialUrls ? Array.from(discovery.initialUrls) : [];
        const uniqueFallback = [...new Set(fallbackUrls)];

        return {
          images: uniqueFallback, meta: [],
          total: elementsCount, success: uniqueFallback.length, failed: 0,
          stopped: scanState.stopRequested,
        };
      }

      const capture = await sequentialCapture(discovery, reportProgress);

      scanState.showBanner(`✅ Done! ${capture.success}/${capture.total}`);
      await sleep(1200);
      scanState.hideBanner();

      await smoothScrollTo(0, 100);

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
     Fetch (Optimized)
     ══════════════════════════════════════ */

  /**
   * Fetch & konversi ke base64 (dipakai untuk blob: URL, karena blob
   * hanya bisa dibaca dari halaman yang membuatnya). HTTP(S) URL lebih
   * baik difetch lewat background worker (lihat background.js).
   */
  async function fetchImageAsBase64(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.fetchTimeout);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();

      if (blob.size > CONFIG.maxFileSize) {
        throw new Error(`Too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);
      }

      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // ⚡ Chunked binary -> base64 (jauh lebih kecil daripada array angka)
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }

      return {
        success: true,
        data: btoa(binary),
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

  const messageHandler = (message, sender, sendResponse) => {
    switch (message.action) {
      case 'SCAN_IMAGES': {
        (async () => {
          try {
            scanState.start();

            if (message.speed && SPEED_PRESETS[message.speed]) {
              Object.assign(CONFIG, SPEED_PRESETS[message.speed]);
            }

            const result = await performScan(message.customSelector || '');
            scanState.finish();

            const title = detectChapterTitle();
            const images = result?.images || [];
            const meta = result?.meta || [];

            sendResponse({
              success: true,
              images,
              meta,
              title: title || 'Manhwa-Chapter',
              count: images.length,
              total: result?.total || images.length,
              failed: result?.failed || 0,
              url: window.location.href,
              debug: images.length === 0 ? debugScan() : null,
              stopped: result?.stopped || false,
            });
          } catch (error) {
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
        fetchImageAsBase64(message.url).then(sendResponse);
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
  };

  chrome.runtime.onMessage.addListener(messageHandler);

  // ⚡ Cleanup on unload
  window.addEventListener('beforeunload', () => {
    chrome.runtime.onMessage.removeListener(messageHandler);
    scanState.finish();
  });

  log('Content script v2.1.1 loaded');
})();
