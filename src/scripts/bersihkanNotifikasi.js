/**
 * Bersihkan notifikasi yang sudah tidak terpakai (revisi #8).
 *
 * Yang dihapus:
 *  A. notifikasi_siswa dengan targetUid ""  -> broadcast model lama, sudah tidak dibaca aplikasi
 *  B. notifikasi dengan sudahDikirim true   -> antrean permintaan yang sudah diproses bot
 *  C. notifikasi_siswa tipe REKOMENDASI_BARU yang rekomendasinya sudah dihapus ("yatim")
 *
 * Cara pakai (dari folder tracerstudy-bot):
 *   node src/scripts/bersihkanNotifikasi.js          -> UJI COBA: hanya menampilkan, tidak menghapus
 *   node src/scripts/bersihkanNotifikasi.js --hapus  -> benar-benar menghapus
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// Sama seperti script migrasi NISN: baca file service account langsung (tanpa .env)
const serviceAccount = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "tracerstudy-cad74-e7e38e069475.json"),
    "utf8",
  ),
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const HAPUS = process.argv.includes("--hapus");

function tampilkanContoh(label, docs) {
  console.log(`\n${label}: ${docs.length} dokumen`);
  docs.slice(0, 10).forEach((doc) => {
    const d = doc.data();
    console.log(`  - ${doc.ref.path} | ${d.judul || "(tanpa judul)"} | ${d.pesan || ""}`);
  });
  if (docs.length > 10) console.log(`  ...dan ${docs.length - 10} lainnya`);
}

async function cariNotifikasiYatim() {
  const snapshot = await db
    .collection("notifikasi_siswa")
    .where("tipe", "==", "REKOMENDASI_BARU")
    .get();

  // Broadcast lama (targetUid "") sudah ditangani kategori A, jadi dilewati di sini
  const kandidat = snapshot.docs.filter((doc) => {
    const d = doc.data();
    return d.refId && d.targetUid !== "";
  });

  // Cek rekomendasi mana yang masih ada. Set = daftar tanpa duplikat.
  const semuaRefId = [...new Set(kandidat.map((doc) => doc.data().refId))];
  const masihAda = new Set();
  for (let i = 0; i < semuaRefId.length; i += 100) {
    const refs = semuaRefId
      .slice(i, i + 100)
      .map((id) => db.collection("rekomendasi").doc(id));
    const hasil = await db.getAll(...refs);
    hasil.forEach((snap) => {
      if (snap.exists) masihAda.add(snap.id);
    });
  }

  return kandidat.filter((doc) => !masihAda.has(doc.data().refId));
}

async function hapusSemua(docs) {
  // Satu batch Firestore maksimal 500 operasi
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function main() {
  console.log(HAPUS ? "MODE: HAPUS" : "MODE: UJI COBA (tidak ada yang dihapus)");

  const broadcastLama = (
    await db.collection("notifikasi_siswa").where("targetUid", "==", "").get()
  ).docs;
  const antreanSelesai = (
    await db.collection("notifikasi").where("sudahDikirim", "==", true).get()
  ).docs;
  const yatim = await cariNotifikasiYatim();

  tampilkanContoh("A. Broadcast lama (targetUid kosong)", broadcastLama);
  tampilkanContoh("B. Antrean notifikasi yang sudah diproses", antreanSelesai);
  tampilkanContoh("C. Notifikasi rekomendasi yang rekomendasinya sudah dihapus", yatim);

  const total = broadcastLama.length + antreanSelesai.length + yatim.length;
  if (!HAPUS) {
    console.log(`\nTotal ${total} dokumen AKAN dihapus. Jalankan ulang dengan --hapus untuk menghapus.`);
    return;
  }

  await hapusSemua([...broadcastLama, ...antreanSelesai, ...yatim]);
  console.log(`\nSelesai: ${total} dokumen dihapus.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Gagal:", err);
    process.exit(1);
  });