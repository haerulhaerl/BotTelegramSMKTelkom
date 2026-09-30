/**
 * Uji jalur permintaanAdmin di Firestore ASLI, tanpa aplikasi Android dan TANPA membuat akun.
 *
 * Menulis 4 permintaan uji ke koleksi `permintaanAdmin`, memprosesnya dengan
 * permintaanAdminService, menampilkan hasilnya, lalu menghapus dokumen ujinya lagi.
 * Semua kasus sengaja berakhir GAGAL/DIBATALKAN, jadi tidak ada akun siswa yang dibuat.
 *
 * Cara pakai (dari folder tracerstudy-bot; bot boleh jalan atau tidak):
 *   node -r dotenv/config src/scripts/ujiPermintaanAdmin.js
 */
const { admin, db } = require("../firebase");
const { ADMIN_UID } = require("../config");
const { proses } = require("../permintaanAdminService");

const dataSiswa = (nisn) => ({ nisn, nama: "Uji Permintaan", jurusan: "RPL", angkatan: "2023", noTelepon: "" });

async function main() {
  const sekarang = admin.firestore.FieldValue.serverTimestamp();
  const sepuluhMenitLalu = admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);

  const kasus = [
    {
      label: "NISN salah format",
      harapan: "GAGAL (NISN tidak valid)",
      isi: { tipe: "BUAT_SISWA", dimintaOleh: ADMIN_UID, dibuatPada: sekarang, data: dataSiswa("abc") },
    },
    {
      label: "NISN sudah terdaftar",
      harapan: "GAGAL (sudah terdaftar)",
      isi: { tipe: "BUAT_SISWA", dimintaOleh: ADMIN_UID, dibuatPada: sekarang, data: dataSiswa("1234567890") },
    },
    {
      label: "Pengirim bukan admin",
      harapan: "GAGAL (bukan admin)",
      isi: { tipe: "BUAT_SISWA", dimintaOleh: "uid-bukan-admin", dibuatPada: sekarang, data: dataSiswa("5555555555") },
    },
    {
      label: "Permintaan kedaluwarsa",
      harapan: "DIBATALKAN",
      isi: { tipe: "BUAT_SISWA", dimintaOleh: ADMIN_UID, dibuatPada: sepuluhMenitLalu, data: dataSiswa("5555555555") },
    },
  ];

  const refs = [];
  for (const k of kasus) {
    const ref = db.collection("permintaanAdmin").doc();
    await ref.set({ status: "MENUNGGU", ...k.isi });
    refs.push(ref);
  }

  // Diproses langsung (tidak menunggu listener), supaya uji ini tidak butuh bot berjalan.
  // Kalau bot kebetulan berjalan, transaksi memastikan tiap permintaan hanya dikerjakan sekali.
  for (const ref of refs) await proses(ref);

  console.log("\n=== HASIL UJI permintaanAdmin ===");
  for (let i = 0; i < refs.length; i++) {
    const d = (await refs[i].get()).data();
    console.log(`${kasus[i].label.padEnd(24)} -> ${d.status.padEnd(10)} ${d.pesan || ""}`);
    console.log(`${"".padEnd(24)}    (diharapkan: ${kasus[i].harapan})`);
  }

  for (const ref of refs) await ref.delete();
  console.log("\nDokumen uji sudah dihapus.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Gagal:", err);
    process.exit(1);
  });