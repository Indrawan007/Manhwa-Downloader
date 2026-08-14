# Manhwa Downloader v1.1.0

## Fixed
- Removed unused JSZip dependency.
- Scan no longer auto-starts download; review results first, then click Download ZIP.
- ZIP creation keeps image Blobs as Blob parts instead of concatenating all image bytes into one huge Uint8Array.
- Reader scroll-container detection prefers an inner reader container before the document window.
- Removed the scan fast-path that could skip lazy-loaded pages.
- Invalid custom CSS selectors now produce a clear error.
- Retry uses the configured retry count consistently.
- Manifest simplified for MV3 and version bumped to 1.1.0.

## Install
1. Extract this folder.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select this folder.
