// =============================================
// CONTENT SCRIPT - FIXED VERSION
// =============================================

// -----------------------------------------------
// SIMPAN REFERENCE ASLI SEBELUM DIOVERWRITE
// -----------------------------------------------
const _originalCreateObjectURL = URL.createObjectURL.bind(URL);
const _originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

let collectedBlobs = new Map();
let isCollecting = false;
let imageIndex = 0;

// -----------------------------------------------
// 1. INTERCEPT - Gunakan reference asli
// -----------------------------------------------
URL.createObjectURL = function(object) {
  // Panggil yang ASLI dulu
  const url = _originalCreateObjectURL(object);
  
  if (isCollecting && object instanceof Blob && object.type.startsWith('image/')) {
    console.log('[ManhwaDL] Blob intercepted:', url, object.type, object.size);
    
    imageIndex++;
    // Clone blob supaya tidak expired saat di-revoke
    const clonedBlob = object.slice(0, object.size, object.type);
    
    collectedBlobs.set(url, {
      blob: clonedBlob,
      index: imageIndex,
      type: object.type,
      size: object.size
    });
    
    chrome.runtime.sendMessage({
      type: 'BLOB_FOUND',
      url: url,
      count: collectedBlobs.size
    }).catch(() => {});
  }
  
  return url;
};

// -----------------------------------------------
// 2. Intercept fetch juga (beberapa site pakai fetch)
// -----------------------------------------------
const _originalFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
  const response = await _originalFetch(...args);
  
  if (isCollecting) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    
    // Cek apakah response adalah gambar
    const cloned = response.clone();
    cloned.blob().then(blob => {
      if (blob.type.startsWith('image/') && blob.size > 5000) {
        // Buat blob URL baru untuk tracking
        const blobUrl = _originalCreateObjectURL(blob);
        
        if (!collectedBlobs.has(url)) {
          imageIndex++;
          collectedBlobs.set(blobUrl, {
            blob: blob,
            index: imageIndex,
            type: blob.type,
            size: blob.size,
            originalUrl: url
          });
          
          chrome.runtime.sendMessage({
            type: 'BLOB_FOUND',
            url: blobUrl,
            count: collectedBlobs.size
          }).catch(() => {});
          
          console.log('[ManhwaDL] Fetch intercepted image:', url);
        }
      }
    }).catch(() => {});
  }
  
  return response;
};

// -----------------------------------------------
// 3. Observer untuk lazy loading
// -----------------------------------------------
function setupImageObserver() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          const images = node.tagName === 'IMG'
            ? [node]
            : [...node.querySelectorAll('img')];

          images.forEach(img => {
            watchImage(img);
          });
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  return observer;
}

function watchImage(img) {
  checkAndCollectImageElement(img);

  // Watch perubahan src (lazy load)
  const attrObserver = new MutationObserver(() => {
    checkAndCollectImageElement(img);
  });
  attrObserver.observe(img, {
    attributes: true,
    attributeFilter: ['src', 'data-src', 'data-lazy', 'data-original']
  });
}

// -----------------------------------------------
// 4. Collect dari img element
// -----------------------------------------------
async function checkAndCollectImageElement(img) {
  if (!isCollecting) return;

  const src = img.src
    || img.dataset.src
    || img.dataset.lazySrc
    || img.dataset.original
    || img.getAttribute('data-lazy');

  if (!src || src === window.location.href) return;

  // Skip kalau sudah ada
  if (collectedBlobs.has(src)) return;

  // Kalau blob URL
  if (src.startsWith('blob:')) {
    try {
      // Fetch blob menggunakan originalFetch
      const response = await _originalFetch(src);
      const blob = await response.blob();

      if (blob.type.startsWith('image/') && blob.size > 1000) {
        imageIndex++;
        const cloned = blob.slice(0, blob.size, blob.type);
        
        collectedBlobs.set(src, {
          blob: cloned,
          index: imageIndex,
          type: blob.type,
          size: blob.size,
          fromImg: true
        });

        chrome.runtime.sendMessage({
          type: 'BLOB_FOUND',
          url: src,
          count: collectedBlobs.size
        }).catch(() => {});
        
        console.log('[ManhwaDL] Collected from IMG blob src:', src);
      }
    } catch (e) {
      console.warn('[ManhwaDL] Failed fetch blob img:', src, e);
    }
  }
  // Kalau URL biasa (http/https) - fetch langsung
  else if (src.startsWith('http') && looksLikeImage(src)) {
    try {
      const response = await _originalFetch(src, { mode: 'cors' });
      const blob = await response.blob();

      if (blob.type.startsWith('image/') && blob.size > 1000) {
        imageIndex++;
        const blobUrl = _originalCreateObjectURL(blob);
        
        collectedBlobs.set(blobUrl, {
          blob: blob,
          index: imageIndex,
          type: blob.type,
          size: blob.size,
          originalUrl: src
        });

        chrome.runtime.sendMessage({
          type: 'BLOB_FOUND',
          url: blobUrl,
          count: collectedBlobs.size
        }).catch(() => {});
        
        console.log('[ManhwaDL] Collected from IMG http src:', src);
      }
    } catch (e) {
      // CORS error - skip, sudah ter-intercept via fetch/createObjectURL
      console.warn('[ManhwaDL] Cannot fetch img src (probably CORS):', src);
    }
  }
}

function looksLikeImage(url) {
  return /\.(jpg|jpeg|png|webp|gif|avif|bmp)(\?.*)?$/i.test(url)
    || url.includes('/image')
    || url.includes('/img')
    || url.includes('/chapter');
}

// -----------------------------------------------
// 5. Auto scroll
// -----------------------------------------------
async function autoScroll(progressCallback) {
  return new Promise((resolve) => {
    window.scrollTo({ top: 0, behavior: 'instant' });

    setTimeout(() => {
      const totalHeight = document.body.scrollHeight;
      let scrolled = 0;
      const step = Math.floor(window.innerHeight * 0.75);
      const delay = 1000;

      const interval = setInterval(() => {
        window.scrollBy({ top: step, behavior: 'smooth' });
        scrolled += step;

        const progress = Math.min(Math.round((scrolled / totalHeight) * 100), 99);
        progressCallback(progress);

        // Recalculate karena lazy load bisa tambah height
        const newTotal = document.body.scrollHeight;

        if (scrolled >= newTotal) {
          clearInterval(interval);
          progressCallback(100);

          setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            resolve();
          }, 2000);
        }
      }, delay);
    }, 300);
  });
}

// -----------------------------------------------
// 6. Scan existing images
// -----------------------------------------------
async function scanExistingImages() {
  const images = [...document.querySelectorAll('img')];
  console.log('[ManhwaDL] Scanning', images.length, 'existing images');
  
  for (const img of images) {
    await checkAndCollectImageElement(img);
  }
}

// -----------------------------------------------
// 7. Get title
// -----------------------------------------------
function getManhwaTitle() {
  const selectors = [
    'h1.entry-title',
    'h1.chapter-title',
    '.reading-title h3',
    '.chapter-name',
    '.title-chapter',
    'h1',
    'title'
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) {
      return sanitizeFilename(el.textContent.trim());
    }
  }

  const parts = window.location.pathname.split('/').filter(Boolean);
  return sanitizeFilename(parts[parts.length - 1] || 'manhwa');
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .substring(0, 100) || 'manhwa';
}

// -----------------------------------------------
// 8. Convert blob ke base64
// -----------------------------------------------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

function getExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif'
  };
  return map[mimeType] || 'jpg';
}

// -----------------------------------------------
// 9. Message Handler
// -----------------------------------------------
let mutationObserver = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'START_COLLECTING') {
    isCollecting = true;
    imageIndex = 0;
    collectedBlobs.clear();

    mutationObserver = setupImageObserver();
    scanExistingImages();

    sendResponse({ success: true, title: getManhwaTitle() });
  }

  else if (message.type === 'STOP_COLLECTING') {
    isCollecting = false;
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    sendResponse({ success: true, count: collectedBlobs.size });
  }

  else if (message.type === 'START_SCROLL') {
    autoScroll((progress) => {
      chrome.runtime.sendMessage({
        type: 'SCROLL_PROGRESS',
        progress
      }).catch(() => {});
    }).then(() => sendResponse({ success: true }));
    return true;
  }

  else if (message.type === 'GET_STATUS') {
    sendResponse({
      isCollecting,
      count: collectedBlobs.size,
      title: getManhwaTitle()
    });
  }

  else if (message.type === 'PREPARE_DOWNLOAD') {
    const prepare = async () => {
      const images = [];

      // Deduplicate berdasarkan size (hindari duplikat)
      const seen = new Set();
      const sorted = [...collectedBlobs.entries()]
        .sort((a, b) => a[1].index - b[1].index);

      for (const [url, data] of sorted) {
        const key = `${data.size}_${data.type}`;
        if (seen.has(key)) {
          console.log('[ManhwaDL] Skipping duplicate:', url);
          continue;
        }
        seen.add(key);

        try {
          // Pastikan blob masih valid
          if (!data.blob || data.blob.size === 0) continue;

          const base64 = await blobToBase64(data.blob);
          if (!base64 || base64 === 'data:') continue;

          const ext = getExtension(data.type);
          images.push({
            index: data.index,
            base64,
            filename: `page_${String(images.length + 1).padStart(3, '0')}.${ext}`,
            type: data.type,
            size: data.size
          });
          
          console.log('[ManhwaDL] Prepared image:', images.length, data.size, 'bytes');
        } catch (e) {
          console.warn('[ManhwaDL] Failed to prepare blob:', e);
        }
      }

      return images;
    };

    prepare()
      .then(images => sendResponse({ success: true, images, title: getManhwaTitle() }))
      .catch(err => sendResponse({ success: false, error: err.message }));

    return true;
  }

  return true;
});

console.log('[ManhwaDL] Content script loaded:', window.location.href);
