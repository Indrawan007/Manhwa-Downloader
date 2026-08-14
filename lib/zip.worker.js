/**
 * ZIP Web Worker - Offload compression to background thread
 * Prevents UI blocking during heavy ZIP operations
 */

'use strict';

// Import JSZip in worker context
importScripts('jszip.min.js');

self.addEventListener('message', async (e) => {
  const { type, payload } = e.data;

  if (type === 'CREATE_ZIP') {
    try {
      const { chapterName, files } = payload;
      const zip = new JSZip();
      const folder = zip.folder(chapterName);

      // Add all files to ZIP
      const len = files.length;
      for (let i = 0; i < len; i++) {
        const { filename, data, mimeType } = files[i];
        // Convert array back to Uint8Array for blob
        const blob = new Blob([new Uint8Array(data)], { type: mimeType });
        folder.file(filename, blob);

        // Report progress
        if (i % 5 === 0) {
          self.postMessage({
            type: 'PROGRESS',
            payload: {
              phase: 'adding',
              percent: Math.round((i / len) * 50),
              current: i + 1,
              total: len,
            },
          });
        }
      }

      // Generate ZIP with progress
      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE',
          streamFiles: true,
        },
        (meta) => {
          self.postMessage({
            type: 'PROGRESS',
            payload: {
              phase: 'compressing',
              percent: 50 + Math.round(meta.percent * 0.5),
              zipPercent: meta.percent,
            },
          });
        }
      );

      // Send ZIP blob back (transferable)
      const arrayBuffer = await zipBlob.arrayBuffer();

      self.postMessage(
        {
          type: 'ZIP_COMPLETE',
          payload: {
            buffer: arrayBuffer,
            size: zipBlob.size,
          },
        },
        [arrayBuffer] // ⚡ Transferable - zero copy!
      );

    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        payload: { message: error.message },
      });
    }
  }
});
