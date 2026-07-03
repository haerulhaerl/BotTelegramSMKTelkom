# 🤖 Bot Telegram Tracer Study SMK Telkom

## Struktur File
```
tracerstudy-bot/
├── src/
│   ├── index.js          ← Kode utama bot
│   └── firebase.js       ← Koneksi Firebase
├── serviceAccountKey.json ← File dari Firebase (JANGAN di-share!)
├── .env                  ← Konfigurasi token & ID (JANGAN di-share!)
├── package.json
└── README.md
```

---

## Langkah 1: Siapkan File

1. Taruh file `serviceAccountKey.json` (yang sudah kamu download dari Firebase)
   di dalam folder `tracerstudy-bot/`

2. Buat file `.env` (copy dari `.env.example`):
   ```
   TELEGRAM_BOT_TOKEN=token_bot_barumu_di_sini
   ADMIN_CHAT_ID=chat_id_kamu (lihat cara dapat di bawah)
   ADMIN_UID=6UCC5Xho5MU2R37u9oZE45YYbsV2
   ```

---

## Langkah 2: Cara Dapat ADMIN_CHAT_ID

1. Buka Telegram, cari **@userinfobot**
2. Ketik `/start`
3. Bot akan balas dengan info akunmu, termasuk **Id** — itulah Chat ID kamu
4. Salin angka itu ke `.env` di bagian `ADMIN_CHAT_ID`

---

## Langkah 3: Install & Jalankan Lokal (untuk test)

Pastikan sudah install Node.js (https://nodejs.org), lalu:

```bash
cd tracerstudy-bot
npm install
node src/index.js
```

Kalau muncul `🤖 Bot Tracer Study berjalan...` berarti berhasil!
Coba buka Telegram dan ketik /start ke bot kamu.

---

## Langkah 4: Deploy ke Railway (agar berjalan 24 jam)

1. Buat akun di https://railway.app (gratis, login pakai GitHub)
2. Buat repository GitHub baru (private), upload semua file kecuali:
   - `serviceAccountKey.json`
   - `.env`
   - `node_modules/`
3. Di Railway: klik **New Project** → **Deploy from GitHub**
4. Pilih repo yang sudah diupload
5. Setelah deploy, masuk ke tab **Variables** di Railway, tambahkan:
   - `TELEGRAM_BOT_TOKEN` = token bot kamu
   - `ADMIN_CHAT_ID` = chat ID kamu
   - `ADMIN_UID` = 6UCC5Xho5MU2R37u9oZE45YYbsV2
6. Untuk `serviceAccountKey.json`: di Railway masuk ke **Variables**, tambahkan variable baru:
   - Key: `GOOGLE_CREDENTIALS`
   - Value: isi seluruh konten file JSON-nya (copy-paste)

   Lalu ubah `src/firebase.js` menjadi:
   ```js
   const admin = require("firebase-admin");
   
   const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
   
   admin.initializeApp({
     credential: admin.credential.cert(serviceAccount),
   });
   
   const db = admin.firestore();
   module.exports = { db };
   ```

7. Railway akan otomatis restart bot, dan bot kamu berjalan 24 jam!

---

## Fitur Bot

| Perintah | Fungsi |
|----------|--------|
| /start | Buka menu utama |
| ➕ Tambah Rekomendasi | Form tambah rekomendasi baru |
| 📋 Lihat Rekomendasi | Lihat 10 rekomendasi terbaru |
| 🗑️ Hapus Rekomendasi | Hapus rekomendasi yang ada |

---

## ⚠️ PENTING - Keamanan
- Jangan pernah upload `serviceAccountKey.json` ke GitHub
- Jangan share token bot ke siapapun
- Jangan share file `.env` ke siapapun
