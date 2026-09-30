// src/permintaanAdminService.js
//
// Menjalankan permintaan admin dari aplikasi Android LEWAT FIRESTORE, bukan HTTP.
// Android menulis satu dokumen ke koleksi `permintaanAdmin`, bot mengambil dan
// mengerjakannya, lalu menulis hasilnya kembali ke dokumen yang sama.
//
// Kenapa lewat Firestore: HP tidak perlu tahu IP laptop, tidak perlu satu WiFi
// dengan laptop, dan tidak perlu ADMIN_API_KEY di dalam APK.
// Polanya sama dengan koleksi `notifikasi` (Android -> Firestore -> bot).
//
// Alur status:
//   MENUNGGU -> DIPROSES -> SELESAI / GAGAL
//   MENUNGGU -> DIBATALKAN   (Android berhenti menunggu, atau permintaan kedaluwarsa)
//
// Isi dokumen yang ditulis Android:
//   { tipe, data, dimintaOleh (uid admin), status: "MENUNGGU", dibuatPada (serverTimestamp) }

const { admin, db } = require("./firebase");
const { createSingleSiswa, bulkImportSiswa } = require("./siswaAccountService");
const { resetPasswordSiswa } = require("./resetPasswordService");

const KOLEKSI = "permintaanAdmin";

// Android menunggu bot mengambil permintaan selama 15 detik, lalu membatalkannya.
// Permintaan yang lebih tua dari batas ini dianggap basi (mis. dibuat saat bot mati)
// dan TIDAK dikerjakan, supaya akun tidak tiba-tiba dibuat belakangan tanpa admin tahu.
const BATAS_UMUR_MS = 2 * 60 * 1000;

const waktuServer = () => admin.firestore.FieldValue.serverTimestamp();

/** Kerjakan satu permintaan sesuai tipenya. Nilai kembaliannya disimpan di field `hasil`. */
async function kerjakan(tipe, data) {
  switch (tipe) {
    case "BUAT_SISWA":
      return createSingleSiswa(data); // { uid, nisn, email, password }

    case "IMPORT_SISWA": {
      const hasil = await bulkImportSiswa(data.rows);
      return {
        totalBerhasil: hasil.berhasil.length,
        totalGagal: hasil.gagal.length,
        gagal: hasil.gagal, // [{ nisn, nama, alasan }]
      };
    }

    case "RESET_PASSWORD":
      return resetPasswordSiswa(data.uid); // { passwordBaru, ... }

    default:
      throw new Error(`Jenis permintaan tidak dikenal: ${tipe}`);
  }
}

/** Apakah uid ini milik akun ber-role ADMIN. */
async function pengirimAdalahAdmin(uid) {
  if (!uid) return false;
  const doc = await db.collection("users").doc(uid).get();
  return doc.exists && doc.data().role === "ADMIN";
}

/**
 * Ambil alih permintaan: MENUNGGU -> DIPROSES, di dalam transaksi.
 * Transaksi memastikan permintaan tidak dikerjakan dua kali, misalnya kalau di saat
 * yang sama Android sedang membatalkannya. Mengembalikan data permintaan, atau null
 * kalau permintaan tidak perlu dikerjakan.
 */
async function ambilAlih(ref) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const permintaan = snap.data();
    if (permintaan.status !== "MENUNGGU") return null;

    const dibuat =
      permintaan.dibuatPada && typeof permintaan.dibuatPada.toMillis === "function"
        ? permintaan.dibuatPada.toMillis()
        : 0;
    if (Date.now() - dibuat > BATAS_UMUR_MS) {
      tx.update(ref, {
        status: "DIBATALKAN",
        pesan: "Permintaan kedaluwarsa (dibuat saat server tidak aktif).",
        selesaiPada: waktuServer(),
      });
      return null;
    }

    tx.update(ref, { status: "DIPROSES", diprosesPada: waktuServer() });
    return permintaan;
  });
}

/** Proses satu dokumen permintaan dari awal sampai status akhir. Tidak pernah melempar error. */
async function proses(ref) {
  let permintaan;
  try {
    permintaan = await ambilAlih(ref);
  } catch (error) {
    console.error(`❌ Gagal mengambil permintaan ${ref.id}:`, error.message);
    return;
  }
  if (!permintaan) return;

  const { tipe, data = {}, dimintaOleh } = permintaan;
  console.log(`📨 Permintaan ${tipe} (${ref.id}) diproses`);

  try {
    if (!(await pengirimAdalahAdmin(dimintaOleh))) {
      throw new Error("Permintaan ditolak: akun pengirim bukan admin.");
    }

    const hasil = await kerjakan(tipe, data);
    await ref.update({
      status: "SELESAI",
      // JSON.parse(JSON.stringify(...)) membuang nilai undefined, yang ditolak Firestore
      hasil: JSON.parse(JSON.stringify(hasil ?? {})),
      selesaiPada: waktuServer(),
    });
    console.log(`✅ Permintaan ${tipe} (${ref.id}) selesai`);
  } catch (error) {
    console.error(`❌ Permintaan ${tipe} (${ref.id}) gagal: ${error.message}`);
    await ref
      .update({
        status: "GAGAL",
        pesan: error.message || "Terjadi kesalahan di server.",
        selesaiPada: waktuServer(),
      })
      .catch((e) => console.error(`❌ Gagal menulis status GAGAL (${ref.id}):`, e.message));
  }
}

/** Mulai memantau koleksi permintaanAdmin. Dipanggil sekali saat bot start. */
function mulaiPantauPermintaanAdmin() {
  // Permintaan dikerjakan satu per satu (berantai), supaya tidak saling tumpang tindih
  let antrean = Promise.resolve();

  db.collection(KOLEKSI)
    .where("status", "==", "MENUNGGU")
    .onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type !== "added") return;
          antrean = antrean.then(() => proses(change.doc.ref));
        });
      },
      (error) => console.error("❌ Pemantauan permintaanAdmin berhenti:", error.message),
    );

  console.log("📨 Memantau permintaan admin dari aplikasi...");
}

module.exports = { mulaiPantauPermintaanAdmin, proses, BATAS_UMUR_MS };