const express = require("express");
const { ADMIN_API_KEY } = require("./config");
const { resetPasswordSiswa } = require("./resetPasswordService");

function startServer() {
  const app = express();
  app.use(express.json());

  app.post("/admin/reset-password", async (req, res) => {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

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

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 HTTP server berjalan di port ${PORT}`);
  });
}

module.exports = { startServer };