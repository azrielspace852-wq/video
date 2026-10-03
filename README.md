# HTML → MP4 Renderer (GitHub Actions)

Render file HTML (animasi CSS/JS) menjadi **MP4 tanpa audio**, **60 fps**, **2K (2560px sisi terpanjang)**, rasio aspek mengikuti HTML.

## Cara pakai

1. Taruh file `.html` di folder `video/`.
2. Commit & push ke `main` (atau jalankan manual: **Actions → Render HTML to MP4 → Run workflow**).
3. Setelah selesai, unduh artifact `rendered-videos`:
   - **1 file HTML** → artifact berisi **1 file MP4**.
   - **>1 file HTML** → artifact berisi **ZIP** berisi semua MP4.

## Konfigurasi per file (opsional)

Tambahkan `<meta>` di `<head>` (atau atribut `data-video-*` di `<html>`/`<body>`):

| Meta              | Contoh        | Default    | Keterangan |
|-------------------|---------------|------------|------------|
| `video-aspect`    | `16:9`, `9:16`, `1:1` | `16:9` | Rasio aspek output |
| `video-width` / `video-height` | `1920` / `1080` | — | Alternatif penentuan rasio |
| `video-duration`  | `5` atau `auto` | `5`      | Detik. `auto` = tunggu `window.__videoDone = true` |
| `video-fps`       | `60`          | `60`       | Frame per detik |
| `video-background`| `#000`        | `#000000`  | Warna latar (mencegah transparan) |

### Mode `auto`

Jika `video-duration` = `auto`, animasi Anda dapat menandai selesai dengan:

```js
window.__videoDone = true; 
