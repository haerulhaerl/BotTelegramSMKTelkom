const express = require("express");
const { ADMIN_API_KEY } = require("./config");
const { resetPasswordSiswa } = require("./resetPasswordService");
const { createSingleSiswa, bulkImportSiswa } = require("./siswaAccountService");

function startServer() {
  const app = express();

  // Limit dinaikkan dari default (100kb) karena bulk import bisa mengirim
  // ratusan baris siswa sekaligus dalam satu request.
  app.use(express.json({ limit: "5mb" }));

  /** Middleware cek API key — dipakai semua endpoint admin,
   *  supaya pengecekannya tidak ditulis ulang di tiap endpoint. */
  function cekApiKey(req, res, next) {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
  }

  app.post("/admin/reset-password", cekApiKey, async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
      return res.status(400).json({ success: false, message: "uid wajib diisi" });
    }

    try {
      const result = await resetPasswordSiswa(uid);
      console.log(`✅ Password direset via HTTP untuk uid: ${uid}`);
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Gagal reset password via HTTP:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  // ─── Tambah 1 siswa (dipakai bot Telegram lewat HTTP kalau perlu) ───
  app.post("/admin/create-siswa", cekApiKey, async (req, res) => {
    const { nisn, nama, jurusan, angkatan, noTelepon } = req.body;

    if (!nisn || !nama || !jurusan || !angkatan) {
      return res.status(400).json({
        success: false,
        message: "nisn, nama, jurusan, dan angkatan wajib diisi",
      });
    }

    try {
      const result = await createSingleSiswa({ nisn, nama, jurusan, angkatan, noTelepon });
      console.log(`✅ Akun siswa dibuat via HTTP: NISN ${nisn}`);
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error("❌ Gagal buat akun siswa via HTTP:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  // ─── Bulk import (dipakai Android setelah admin konfirmasi preview) ───
  app.post("/admin/bulk-import-siswa", cekApiKey, async (req, res) => {
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "rows wajib berupa array dan tidak boleh kosong",
      });
    }

    try {
      const result = await bulkImportSiswa(rows);
      return res.json({
        success: true,
        totalBerhasil: result.berhasil.length,
        totalGagal: result.gagal.length,
        berhasil: result.berhasil,
        gagal: result.gagal,
      });
    } catch (error) {
      console.error("❌ Gagal bulk import via HTTP:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 HTTP server berjalan di port ${PORT}`);
  });
}

module.exports = { startServer };