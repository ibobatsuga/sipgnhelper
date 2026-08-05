# SIPGN Helper

Aplikasi pencatatan dan pembukuan untuk SPPG: transaksi, pembacaan struk, persetujuan, buku otomatis, dan laporan dalam satu alur kerja.

Alamat produksi: <https://sipgnhelper.vercel.app>

> SIPGN Helper menyiapkan dan mengendalikan data. Pengiriman ke portal SIPGN resmi dan transfer melalui bank tetap dilakukan manual oleh petugas berwenang.

## Susunan berkas

| Berkas | Isi |
|---|---|
| `index.html` | Seluruh aplikasi — antarmuka, logika pembukuan, dan penyimpanan. Satu berkas, tanpa proses build. |
| `api/receipt/extract.js` | Fungsi Vercel: membaca foto struk lewat Gemini dan mengembalikan JSON yang sudah divalidasi. |
| `api/report/generate-workbook.js` | Fungsi Vercel: menyusun workbook Buku Otomatis dari template MASTER_4. |
| `api/report/templates/MASTER_4.xlsx` | Template resmi. Dibaca sebagai sumber tata letak, tidak pernah ditulis ulang. |
| `tests/` | Suite pengujian (`npm test`). |

Data disimpan per akun di Supabase (tabel `app_state`, satu baris per jenis data).

## Menjalankan secara lokal

Tidak ada langkah build. Sajikan berkasnya lewat server statis apa pun:

```bash
npx serve .
```

Fungsi `api/` hanya berjalan di Vercel. Untuk menjalankannya lokal, pakai `vercel dev`.

## Pengujian

```bash
npm test
```

Menjalankan suite lengkap: kontrak kedua fungsi API, logika pembukuan yang dijalankan langsung dari `index.html`, penguatan (injeksi formula, batas baris, imutabilitas template), dan pemeriksaan keamanan antarmuka.

Sebagian tes menjalankan Chromium sungguhan — memuat aplikasi, menekan tombolnya, dan memeriksa berkas yang terunduh. Tes itu dilewati bila Playwright tidak terpasang:

```bash
npm i --no-save playwright
```

Playwright sengaja bukan dependensi tetap: postinstall-nya mengunduh browser dan akan memperlambat atau menggagalkan build Vercel.

## Variabel lingkungan

| Nama | Keperluan |
|---|---|
| `GEMINI_API_KEY` | Wajib untuk pembacaan struk. Tanpa ini endpoint menjawab 503. |
| `GEMINI_MODEL` | Opsional, mengganti model bawaan. |

Kunci dikelola di pengaturan proyek Vercel, tidak pernah di sisi aplikasi.

## Penerapan

Vercel membangun `api/**/*.js` sebagai fungsi Node dan menyajikan `index.html` sebagai statis (lihat `vercel.json`). Setiap push ke `main` ter-deploy otomatis.
