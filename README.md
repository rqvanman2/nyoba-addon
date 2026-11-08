# BitChord addon — Internet Archive FLAC

Addon BitChord yang nyajiin lagu **lossless (FLAC beneran)** dari Internet
Archive. Dibikin iseng-iseng, tapi beneran jalan.

## Yang bisa / yang nggak bisa

- **Bisa:** cari dan muterin rekaman live (etree), netlabel, public-domain /
  Creative Commons yang ada di archive.org — semuanya FLAC asli.
- **Nggak bisa:** lagu pop mainstream. Kalau lagunya nggak ada di Internet
  Archive, BitChord otomatis jatuh ke YouTube Music seperti biasa.
- File FLAC itu gede (satu lagu live bisa puluhan–ratusan MB). **Pakai Wi-Fi**,
  jangan kuota HP.

## Cara kerja

Addon ini cuma server kecil, 3 endpoint sesuai
[panduan addon resmi BitChord](https://bitchord.kushagrasingh.in/docs):

| Route | Fungsi |
|---|---|
| `GET /manifest.json` | Identitas addon |
| `GET /search?q=...` | Cari di archive.org, balas daftar track FLAC |
| `GET /stream/:id` | Balas URL file FLAC-nya (di archive.org) |
| `GET /health` | Cek server hidup |

Tanpa dependensi, Node 18.17+. Jalanin lokal:

```sh
node server.js
# Manifest: http://localhost:8787/manifest.json
```

## Deploy permanen (gratis, Render)

1. Upload 3 file ini (`server.js`, `package.json`, `render.yaml`) ke repo
   GitHub baru.
2. Buka [render.com](https://render.com) → **New → Web Service** → pilih
   repo itu → plan **Free** → **Deploy**.
3. Kalau sudah jalan, URL manifest-nya:
   `https://<nama-service>.onrender.com/manifest.json`
4. Di BitChord: **Settings → Sources → Add an addon** → paste URL itu.

Catatan: plan gratis Render "tidur" kalau lama nggak dipakai — pencarian
pertama setelah tidur bisa nunggu ~30–60 detik sampai servernya bangun.
Itu normal.

## Coba langsung (demo sementara)

Kalau ada URL `https://....trycloudflare.com/manifest.json`, itu demo yang
numpang jalan di server Muse — bisa mati kapan saja. Buat yang permanen,
deploy sendiri pakai langkah di atas.
