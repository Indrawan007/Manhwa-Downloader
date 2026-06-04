importScripts('jszip.min.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CREATE_ZIP') {
    createAndDownloadZip(message.images, message.title)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => {
        console.error('[BG Error]', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

async function createAndDownloadZip(images, title) {
  if (!images?.length) throw new Error('No images provided');

  const zip = new JSZip();
  const folder = zip.folder(title);
  let added = 0;

  for (const img of images) {
    try {
      if (!img.base64?.includes(',')) continue;
      const b64 = img.base64.split(',')[1];
      if (!b64) continue;
      
      folder.file(img.filename, b64, { base64: true });
      added++;
    } catch(e) {
      console.warn('[BG] Skip file:', img.filename, e.message);
    }
  }

  if (added === 0) throw new Error('No valid images to zip');

  // Generate sebagai uint8array (compatible dengan service worker)
  const zipData = await zip.generateAsync(
    { type: 'uint8array', compression: 'STORE' },
    ({ percent }) => {
      chrome.runtime.sendMessage({
        type: 'ZIP_PROGRESS',
        progress: Math.round(percent)
      }).catch(() => {});
    }
  );

  // uint8array → base64 → data URL
  const base64 = uint8ArrayToBase64(zipData);
  const dataUrl = `data:application/zip;base64,${base64}`;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `${title}.zip`,
    saveAs: false
  });

  console.log('[BG] Download started, id:', downloadId);

  return {
    filename: `${title}.zip`,
    imageCount: added,
    zipSize: zipData.length
  };
}

function uint8ArrayToBase64(arr) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
