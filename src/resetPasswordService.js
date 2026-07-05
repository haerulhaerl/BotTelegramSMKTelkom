const { admin, db } = require("./firebase");

const DEFAULT_PASSWORD = "smktelkom123";

async function resetPasswordSiswa(uid, nama = "") {
  if (!uid) {
    throw new Error("UID wajib diisi");
  }

  await admin.auth().updateUser(uid, { password: DEFAULT_PASSWORD });

  // ─── SIMPAN NOTIFIKASI KE FIRESTORE (khusus siswa ybs) ─────
  try {
    await db.collection("notifikasi_siswa").add({
      tipe: "PASSWORD_DIRESET",
      judul: "🔑 Password Anda Direset",
      pesan: `Password akun Anda telah direset oleh admin menjadi: ${DEFAULT_PASSWORD}. Segera login dan ganti password Anda.`,
      refId: "",
      targetUid: uid, // penting: hanya tampil untuk siswa ini
      createdAt: Date.now(),
      sudahDibaca: false,
    });
    console.log(`✅ Notifikasi reset password terkirim untuk uid: ${uid}`);
  } catch (error) {
    console.error("❌ Gagal simpan notifikasi reset password:", error);
    // tidak perlu throw, karena reset password auth-nya sudah berhasil
  }

  return { uid, passwordBaru: DEFAULT_PASSWORD };
}

module.exports = { resetPasswordSiswa, DEFAULT_PASSWORD };