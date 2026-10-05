/**
 * Hapus data uji — tahap 2 pembersihan data uji.
 *
 * Daftar ID di bawah disalin dari hasil inventarisDataUji.js (5 Okt 2026), sesuai pilihan:
 *  - semua siswa uji kecuali baso (A2–A11) dan semua akun tidak lengkap (B1–B5)
 *  - semua rekomendasi (C1–C11) dan semua kuesioner (D1–D13)
 *  - notifikasi baso dikosongkan, akunnya tetap ada
 *  - semua data yatim (bagian E inventaris)
 *
 * Data terkait yang ikut dihapus:
 *  - siswa       -> akun Auth, users, siswaProfile, nisnLookup, jawaban kuesioner, notifikasi
 *  - rekomendasi -> notifikasi siswa dan antrean notifikasi yang menunjuk ke rekomendasi itu
 *  - kuesioner   -> jawaban, notifikasi siswa, dan antrean notifikasi yang menunjuk ke kuesioner itu
 * Foto di Supabase tidak disentuh (keterbatasan yang sudah tercatat).
 *
 * Aman dijalankan ulang: ID yang sudah terhapus hanya ditandai TIDAK DITEMUKAN.
 *
 * Cara pakai (dari folder tracerstudy-bot):
 *   node src/scripts/hapusDataUji.js          -> UJI COBA: hanya menampilkan, tidak menghapus
 *   node src/scripts/hapusDataUji.js --hapus  -> benar-benar menghapus (tidak bisa dibatalkan)
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// Sama seperti bersihkanNotifikasi.js: baca file service account langsung (tanpa .env)
const serviceAccount = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "tracerstudy-cad74-e7e38e069475.json"),
    "utf8",
  ),
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const HAPUS = process.argv.includes("--hapus");

// ─── DAFTAR YANG DIHAPUS (dari hasil inventaris) ─────────────

// Akun siswa beserta semua datanya
const UID_SISWA_HAPUS = [
  "Nzxz285JGAVGj1d93ngDTkBb2i73", // A2  uji kelas 12
  "jlL2J6DB16enk3J0g5GEMTCV6CF3", // A3  Ahmad Fauzi
  "gYezHbqESmY4KhweMyTHxWiypD13", // A4  Budi Santoso
  "1uJXw9OJruXMyvDDJTmOnC6sgul1", // A5  Siti Nurhaliza
  "aaUp2Gt6evXD7bdDZe2g01j4TTO2", // A6  Dewi Lestari
  "zqTSbZZN1vbue1wrqHh2PgnPVHg2", // A7  haerul
  "SXG3POnjhGOH9gpOipdOkwePS1o1", // A8  Rian Hidayat
  "NZdf4wMwYxUV7SIGj5F4YCBty4C3", // A9  testsiswa1
  "v0mm7op0CdVwt3aAPNuh0xKgALQ2", // A10 testsiswa2
  "3uqxXX9ZYvMuxoW6qy0RyC8pCyn1", // A11 Nur Aisyah
  "MigpfxSQYTUn84Dv9j9jHJAtzG32", // B1  testingNama
  "QkH0dDtU5Ve6Lce3yWjbhBCCuZd2", // B2  siswatesting3
  "U6MEoJGWkZduhziW2gm6ew23ZEj2", // B3  siswatesting2
  "U8923co7ayTTZOiCy7BQc9wwpc63", // B4  siswa3testing
  "pq3cYCaWnPQWcDa9IDCsje0UySw2", // B5  siswaperhotelan
];

// Akunnya tetap ada, hanya notifikasinya yang dikosongkan
const UID_KOSONGKAN_NOTIFIKASI = [
  "75pDkjpjOffzu6xPlNaV84Wx5LA2", // A1  baso
];

const ID_REKOMENDASI_HAPUS = [
  "8a6721cb8fb4421084ae", // C1  Magang Indigohub
  "e9495099cec84682ad55", // C2  Magang Claro
  "2b513f927ab24de2a252", // C3  notfikasi rekomendasi
  "4ac15cc232154ef5938a", // C4  telkom school
  "9c34cd738c6d44b58e61", // C5  teslokasi1
  "dde2d9e2f41f4f51a631", // C6  teslokasi 2
  "41874b41eb55436d869e", // C7  tes pin lokasi
  "e7a03c02bf014b5dac2e", // C8  uji_format
  "17f42492db3b49d28309", // C9  Uji Seri A
  "6c6a8df754cd4228b559", // C10 Uji Seri B
  "udeHi56770jVXVkcQilP", // C11 uji link
];

const ID_KUESIONER_HAPUS = [
  "jVNYQfAdVbxQUPf4f0tE", // D1  judultesting1
  "g1gU9jMn71GYt8gdOC9A", // D2  kuesioner testing 2
  "GOqbP6qUUUOZNl6duy8S", // D3  testingnotifikasi
  "1pvC3O2CengcBerkv7kp", // D4  testingnotgikasi2
  "G7XRJEZrqlyZatWY2jtj", // D5  kuesioner buat tes notifikasi
  "nmRE5mk9KpKJmytp5Ixa", // D6  tesuntukangkatan2024
  "9TNEFzRQcAzXl3QGOFCM", // D7  Tes status
  "Dn4rxOJoAjxF0l4u0VsT", // D8  kuesioner uji
  "qPIOeLVL10r351nEAmTp", // D9  tes skala
  "NHRcepd1LdufRYFu0UFf", // D10 teslagi
  "wKr4cgVkdGKQPmKrH2rM", // D11 tes01
  "hJxrtzTy7jqT8OWq1rR6", // D12 tes123
  "VNZ1qRcET6IGYhYZhemJ", // D13 tes status
];

// ─── PENGUMPULAN ─────────────────────────────────────────────

// Semua dokumen yang akan dihapus, dengan path dokumen sebagai kunci.
// Dokumen yang terkumpul dua kali (mis. notifikasi milik siswa uji yang juga
// menunjuk ke rekomendasi uji) tetap tercatat dan dihapus sekali.
const akanDihapus = new Map();

function tandai(docs) {
  docs.forEach((doc) => akanDihapus.set(doc.ref.path, doc.ref));
}

async function ambil(query) {
  return (await query.get()).docs;
}

// Satu dokumen, dibungkus array supaya bisa digabung dengan hasil query: [] kalau tidak ada
async function ambilDokumen(koleksi, id) {
  const snap = await db.collection(koleksi).doc(id).get();
  return snap.exists ? [snap] : [];
}

async function kumpulkanSiswa(emailAuth) {
  console.log(`\n1. Akun siswa yang dihapus: ${UID_SISWA_HAPUS.length}`);
  for (const uid of UID_SISWA_HAPUS) {
    const [user, profil, lookup, jawaban, notifikasi] = await Promise.all([
      ambilDokumen("users", uid),
      ambilDokumen("siswaProfile", uid),
      ambil(db.collection("nisnLookup").where("uid", "==", uid)),
      ambil(db.collection("kuesionerResponses").where("siswaUid", "==", uid)),
      ambil(db.collection("notifikasi_siswa").where("targetUid", "==", uid)),
    ]);

    // Pengaman: kalau ada akun ADMIN di daftar, berhenti sebelum apa pun dihapus
    if (user[0]?.data().role === "ADMIN") {
      throw new Error(`UID ${uid} adalah akun ADMIN. Dibatalkan, tidak ada yang dihapus.`);
    }

    const semua = [...user, ...profil, ...lookup, ...jawaban, ...notifikasi];
    if (semua.length === 0 && !emailAuth.has(uid)) {
      console.log(`   TIDAK DITEMUKAN (sudah terhapus, atau ID salah) | ${uid}`);
      continue;
    }
    tandai(semua);

    const nama = user[0]?.data().nama || profil[0]?.data().nama || "(tanpa nama)";
    const nisn = profil[0]?.data().nisn || lookup[0]?.id || "-";
    console.log(
      `   ${nama} | NISN ${nisn} | Auth: ${emailAuth.get(uid) || "tidak ada"} | ` +
        `jawaban ${jawaban.length} | notifikasi ${notifikasi.length} | ${uid}`,
    );
  }
}

// Rekomendasi atau kuesioner, beserta notifikasi dan antrean yang menunjuk ke sana.
// Untuk kuesioner, jawabannya juga ikut.
async function kumpulkanInduk(koleksi, daftarId, denganJawaban) {
  for (const id of daftarId) {
    const [induk, notifikasi, antrean, jawaban] = await Promise.all([
      ambilDokumen(koleksi, id),
      ambil(db.collection("notifikasi_siswa").where("refId", "==", id)),
      ambil(db.collection("notifikasi").where("refId", "==", id)),
      denganJawaban
        ? ambil(db.collection("kuesionerResponses").where("kuesionerId", "==", id))
        : Promise.resolve([]),
    ]);

    const semua = [...induk, ...notifikasi, ...antrean, ...jawaban];
    if (semua.length === 0) {
      console.log(`   TIDAK DITEMUKAN (sudah terhapus, atau ID salah) | ${id}`);
      continue;
    }
    tandai(semua);

    const judul = induk[0]?.data().judul || "(dokumennya sudah tidak ada)";
    const infoJawaban = denganJawaban ? ` | jawaban ${jawaban.length}` : "";
    console.log(`   ${judul}${infoJawaban} | notifikasi ${notifikasi.length} | ${id}`);
  }
}

async function kumpulkanNotifikasiAkunTetap() {
  console.log(`\n4. Notifikasi dikosongkan, akunnya tetap ada: ${UID_KOSONGKAN_NOTIFIKASI.length}`);
  for (const uid of UID_KOSONGKAN_NOTIFIKASI) {
    const [user, notifikasi] = await Promise.all([
      ambilDokumen("users", uid),
      ambil(db.collection("notifikasi_siswa").where("targetUid", "==", uid)),
    ]);
    tandai(notifikasi);
    console.log(`   ${user[0]?.data().nama || "(tanpa nama)"} | notifikasi ${notifikasi.length} | ${uid}`);
  }
}

// Data yatim saat ini, dengan aturan yang sama seperti bagian E di inventaris
async function kumpulkanYatim() {
  const [users, rekomendasi, kuesioner, jawaban, notifikasi] = await Promise.all([
    db.collection("users").get(),
    db.collection("rekomendasi").get(),
    db.collection("kuesioner").get(),
    db.collection("kuesionerResponses").get(),
    db.collection("notifikasi_siswa").get(),
  ]);
  const uidUsers = new Set(users.docs.map((doc) => doc.id));
  const idRekomendasi = new Set(rekomendasi.docs.map((doc) => doc.id));
  const idKuesioner = new Set(kuesioner.docs.map((doc) => doc.id));

  const jawabanYatim = jawaban.docs.filter((doc) => {
    const d = doc.data();
    return !idKuesioner.has(d.kuesionerId) || !uidUsers.has(d.siswaUid);
  });
  const notifikasiYatim = notifikasi.docs.filter((doc) => {
    const d = doc.data();
    if (!uidUsers.has(d.targetUid)) return true; // pemiliknya sudah tidak ada
    if (!d.refId) return false; // tanpa refId tidak bisa dicek
    if (d.tipe === "REKOMENDASI_BARU") return !idRekomendasi.has(d.refId);
    if (d.tipe === "KUESIONER_BARU") return !idKuesioner.has(d.refId);
    return false;
  });

  tandai([...jawabanYatim, ...notifikasiYatim]);
  console.log(
    `\n5. Data yatim: jawaban ${jawabanYatim.length}, notifikasi ${notifikasiYatim.length}`,
  );
}

// ─── PENGHAPUSAN ─────────────────────────────────────────────

async function hapusSemua(refs) {
  // Satu batch Firestore maksimal 500 operasi
  for (let i = 0; i < refs.length; i += 500) {
    const batch = db.batch();
    refs.slice(i, i + 500).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function main() {
  console.log(HAPUS ? "MODE: HAPUS" : "MODE: UJI COBA (tidak ada yang dihapus)");

  // Akun Auth dari daftar siswa yang masih ada (getUsers menerima maksimal 100 uid)
  const hasilAuth = await admin.auth().getUsers(UID_SISWA_HAPUS.map((uid) => ({ uid })));
  const emailAuth = new Map(
    hasilAuth.users.map((akun) => [akun.uid, akun.email || "(tanpa email)"]),
  );

  // Semua yang akan dihapus dikumpulkan dulu. Uji coba dan mode hapus memakai
  // pengumpulan yang sama, jadi yang tampil saat uji coba = persis yang dihapus.
  await kumpulkanSiswa(emailAuth);
  console.log(`\n2. Rekomendasi: ${ID_REKOMENDASI_HAPUS.length}`);
  await kumpulkanInduk("rekomendasi", ID_REKOMENDASI_HAPUS, false);
  console.log(`\n3. Kuesioner: ${ID_KUESIONER_HAPUS.length}`);
  await kumpulkanInduk("kuesioner", ID_KUESIONER_HAPUS, true);
  await kumpulkanNotifikasiAkunTetap();
  await kumpulkanYatim();

  // Ringkasan per koleksi. Angka di bagian 1–5 bisa tumpang tindih; angka di sini tanpa duplikat.
  const perKoleksi = new Map();
  for (const pathDokumen of akanDihapus.keys()) {
    const koleksi = pathDokumen.split("/")[0];
    perKoleksi.set(koleksi, (perKoleksi.get(koleksi) || 0) + 1);
  }
  console.log("\nRingkasan (tanpa duplikat):");
  perKoleksi.forEach((jumlah, koleksi) => console.log(`   ${koleksi}: ${jumlah}`));
  console.log(`   akun Firebase Auth: ${emailAuth.size}`);

  if (!HAPUS) {
    console.log(
      `\nTotal ${akanDihapus.size} dokumen + ${emailAuth.size} akun Auth AKAN dihapus. ` +
        "Jalankan ulang dengan --hapus untuk menghapus.",
    );
    return;
  }

  await hapusSemua([...akanDihapus.values()]);

  let akunTerhapus = 0;
  if (emailAuth.size > 0) {
    const hasil = await admin.auth().deleteUsers([...emailAuth.keys()]);
    akunTerhapus = hasil.successCount;
    hasil.errors.forEach((e) => console.log(`   Gagal menghapus akun Auth: ${e.error.message}`));
  }
  console.log(`\nSelesai: ${akanDihapus.size} dokumen dan ${akunTerhapus} akun Auth dihapus.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Gagal:", err.message || err);
    process.exit(1);
  });