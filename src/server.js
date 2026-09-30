// src/server.js
//
// Server HTTP kecil yang tetap dijalankan bersama bot.
//
// Dulu server ini melayani endpoint /admin/* untuk aplikasi Android (reset password,
// tambah siswa, import CSV) dengan pengaman ADMIN_API_KEY. Sejak 30 Sep 2026 aplikasi
// mengirim permintaan itu lewat Firestore (koleksi permintaanAdmin, lihat
// permintaanAdminService.js), jadi endpoint /admin/* DIHAPUS: tidak ada lagi pintu HTTP
// yang bisa dibuka dengan API key yang pernah tertanam di APK lama.
//
// Yang tersisa hanya pemeriksaan kesehatan (GET /), berguna saat hosting nanti:
// layanan hosting dan ping berkala cukup mengecek bahwa server masih hidup.

const express = require("express");

function startServer() {
  const app = express();

  app.get("/", (req, res) => {
    res.json({ status: "ok", layanan: "tracerstudy-bot", waktu: new Date().toISOString() });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 HTTP server berjalan di port ${PORT}`);
  });
}

module.exports = { startServer };