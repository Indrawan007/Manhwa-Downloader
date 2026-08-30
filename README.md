# Manhwa Downloader v2.1.1

Chrome extension (Manifest V3) untuk mendownload manhwa/manga per chapter atau batch, langsung jadi ZIP.

## Fitur
- **Single mode**: scan otomatis (auto-scroll, lazy-load, blob URL support), preview, lalu download ZIP per chapter.
- **Batch mode**: download banyak chapter sekaligus (Next / URL list / URL pattern) dengan folder terstruktur dan opsi merge jadi satu ZIP.
- Batch berjalan di **background service worker** → tetap jalan walau popup ditutup atau pindah tab; progress bisa dilanjutkan saat popup dibuka lagi.
- ZIP dibangun & diunduh lewat **offscreen document** (Blob URL), sehingga tidak kena limit `data:` URL untuk file besar dan lebih hemat memori.

## Fixed (terbaru)
- Batch engine dipindah dari popup ke service worker (survive popup close / tab switching).
- Fix race condition navigasi: tab tidak akan lagi menunggu halaman lama (chapter tidak ter-scan dua kali).
- `START_BATCH` kini selalu broadcast `BATCH_COMPLETE` walau gagal start, jadi popup tidak "macet" di status running.
- Deteksi "next chapter" menunggu URL berubah, bukan `sleep(3s)` yang rawan.
- Merge ZIP memakai folder unik per chapter (anti-tabrakan judul sama).
- ZIP batch diunduh via Blob URL di offscreen document (bukan base64 data URL).
- Keepalive service worker diperkuat (interval + offscreen ping).
- Versi diseragamkan (manifest/popup/content/background = v2.1.1).

## Install
1. Extract folder ini.
2. Buka `chrome://extensions`.
3. Aktifkan Developer mode.
4. Pilih **Load unpacked**.
5. Pilih folder ini.