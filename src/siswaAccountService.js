// src/siswaAccountService.js
//
// Layanan pembuatan akun siswa — dipakai BERSAMA oleh:
//   1. Express endpoint (dipanggil dari Android bulk import)
//   2. Bot Telegram (dipanggil langsung in-process, tanpa lewat HTTP)
//
// Pola yang sama dengan resetPasswordService.js: service mengurus logika
// + efek sampingnya, pemanggil cukup terima hasilnya.

const { admin, db } = require("./firebase");
const { DEFAULT_PASSWORD } = require("./resetPasswordService");
const {
  DAFTAR_JURUSAN,
  ANGKATAN_TERTUA,
  bakukanJurusan,
  angkatanValid,
} = require("./dataSekolah");

const EMAIL_DOMAIN = "tracerstudy.com";

/** Email dummy dihasilkan dari NISN, bukan diinput manual.
 *  Deterministik: NISN yang sama SELALU menghasilkan email yang sama. */
function buatEmailDariNisn(nisn) {
  return `${nisn}@${EMAIL_DOMAIN}`;
}

/**
 * Membuat SATU akun siswa lengkap: Firebase Auth + users + siswaProfile + nisnLookup.
 *
 * Keempat langkah ini harus berhasil semua supaya siswa bisa login pakai NISN.
 * Kalau gagal di tengah, error dilempar ke pemanggil dengan pesan yang jelas.
 *
 * @returns {{uid, nisn, email, password}}
 */
async function createSingleSiswa({ nisn, nama, jurusan, angkatan, noTelepon = "" }) {
  if (!nisn || !nama || !jurusan || !angkatan) {
    throw new Error("nisn, nama, jurusan, dan angkatan wajib diisi");
  }

  // ─── 0. Validasi ulang jurusan & angkatan ───────────────────
  // Jangan percaya begitu saja pada data dari pemanggil (Android/HTTP):
  // ADMIN_API_KEY bisa diekstrak dari APK, jadi endpoint bisa dipanggil
  // tanpa lewat CsvSiswaParser.kt. Dicek SEBELUM menyentuh Firestore/Auth.
  const jurusanBaku = bakukanJurusan(jurusan);
  if (!jurusanBaku) {
    throw new Error(
      `Jurusan "${jurusan}" tidak dikenali (pilihan: ${DAFTAR_JURUSAN.join(", ")})`,
    );
  }
  if (!angkatanValid(angkatan)) {
    throw new Error(
      `Angkatan "${angkatan}" tidak valid: harus tahun lulus 4 digit, dari ${ANGKATAN_TERTUA} sampai tahun ini`,
    );
  }
  const angkatanBaku = String(angkatan).trim();

  // ─── 1. Cek duplikat NISN di Firestore ──────────────────────
  // Dicek DULU sebelum bikin akun Auth, supaya tidak ada akun "yatim"
  // (sudah ada di Auth tapi gagal dilengkapi datanya).
  const lookupDoc = await db.collection("nisnLookup").doc(nisn).get();
  if (lookupDoc.exists) {
    throw new Error(`NISN ${nisn} sudah terdaftar`);
  }

  const email = buatEmailDariNisn(nisn);

  // ─── 2. Buat akun Firebase Auth ─────────────────────────────
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password: DEFAULT_PASSWORD,
      displayName: nama,
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      throw new Error(`Email ${email} sudah dipakai (NISN ${nisn} kemungkinan sudah pernah dibuat)`);
    }
    throw error;
  }

  const uid = userRecord.uid;

  // ─── 3. Tulis ke Firestore: users, siswaProfile, nisnLookup ──
  // Pakai batch supaya ketiganya tersimpan sekaligus (atomic):
  // kalau salah satu gagal, tidak ada yang tersimpan sama sekali.
  try {
    const batch = db.batch();

    batch.set(db.collection("users").doc(uid), {
      uid,
      nama,
      email,
      role: "SISWA",
      jurusan: jurusanBaku,
      fotoUrl: "",
      createdAt: Date.now(),
    });

    batch.set(db.collection("siswaProfile").doc(uid), {
      uid,
      nisn,
      nama,
      jurusan: jurusanBaku,
      angkatan: angkatanBaku,
      noTelepon,
      keahlian: [],
      minat: [],
      kepribadian: [],
      status: "BELUM_BEKERJA",
      instansiSaatIni: "",
      sudahIsiKuesioner: false,
    });

    batch.set(db.collection("nisnLookup").doc(nisn), { email, uid });

    await batch.commit();
  } catch (error) {
    // Firestore gagal padahal akun Auth sudah terlanjur dibuat.
    // Hapus akun Auth-nya supaya tidak meninggalkan akun yatim
    // yang bikin NISN itu "terkunci" dan tidak bisa didaftarkan ulang.
    try {
      await admin.auth().deleteUser(uid);
      console.log(`↩️ Rollback: akun Auth ${uid} dihapus karena Firestore gagal`);
    } catch (rollbackError) {
      console.error(`❌ Rollback GAGAL untuk uid ${uid} — perlu dibersihkan manual:`, rollbackError);
    }
    throw new Error(`Gagal simpan data siswa: ${error.message}`);
  }

  console.log(`✅ Akun siswa dibuat: ${nama} (NISN ${nisn}, uid ${uid})`);
  return { uid, nisn, email, password: DEFAULT_PASSWORD };
}

/**
 * Membuat BANYAK akun siswa sekaligus.
 *
 * Diproses satu per satu (bukan paralel) — lihat catatan di bawah.
 * Satu baris gagal TIDAK menghentikan sisanya; semua hasil dilaporkan di akhir.
 *
 * @param {Array} rows daftar siswa (sudah divalidasi format-nya oleh csvParser)
 * @returns {{berhasil: Array, gagal: Array}}
 */
async function bulkImportSiswa(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Tidak ada data siswa untuk diimport");
  }

  const berhasil = [];
  const gagal = [];

  for (const row of rows) {
    try {
      const hasil = await createSingleSiswa({
        nisn: row.nisn,
        nama: row.nama,
        jurusan: row.jurusan,
        angkatan: row.angkatan,
        noTelepon: row.noTelepon || "",
      });
      berhasil.push({ nisn: hasil.nisn, nama: row.nama, email: hasil.email });
    } catch (error) {
      gagal.push({
        nisn: row.nisn,
        nama: row.nama,
        alasan: error.message,
      });
      console.error(`❌ Gagal import NISN ${row.nisn}: ${error.message}`);
    }
  }

  console.log(`📊 Bulk import selesai: ${berhasil.length} berhasil, ${gagal.length} gagal`);
  return { berhasil, gagal };
}

module.exports = {
  createSingleSiswa,
  bulkImportSiswa,
  buatEmailDariNisn,
  EMAIL_DOMAIN,
};