/**
 * Inventaris data — tahap 1 pembersihan data uji.
 *
 * HANYA MEMBACA: tidak ada data yang diubah atau dihapus, jadi aman dijalankan
 * kapan saja, termasuk saat bot sedang menyala.
 *
 * Yang ditampilkan:
 *  A. Siswa (siswaProfile) + jumlah jawaban kuesioner dan notifikasi miliknya
 *  B. Akun siswa tidak lengkap: akun yang salah satu dari 4 bagiannya hilang
 *     (akun Auth, users, siswaProfile, nisnLookup)
 *  C. Rekomendasi (urut dari yang terlama)
 *  D. Kuesioner + jumlah jawaban (urut dari yang terlama)
 *  E. Data yatim: jawaban dan notifikasi yang kuesioner/rekomendasi/pemiliknya sudah tidak ada
 *  F. Antrean notifikasi yang belum dikirim bot
 *
 * Cara pakai (dari folder tracerstudy-bot):
 *   node src/scripts/inventarisDataUji.js
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

const MAKS_CONTOH = 10; // daftar panjang di bagian E dan F dipotong sampai sekian baris

// createdAt bisa berupa angka milidetik (dari Android) atau Timestamp Firestore
function keMilidetik(nilai) {
  if (typeof nilai === "number") return nilai;
  if (nilai && typeof nilai.toMillis === "function") return nilai.toMillis();
  return 0;
}

function formatTanggal(nilai) {
  const ms = keMilidetik(nilai);
  if (!ms) return "-";
  return new Date(ms).toLocaleString("id-ID", {
    timeZone: "Asia/Makassar",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// targetAngkatan: List di rekomendasi, String di kuesioner. Kosong = semua angkatan
function teksTarget(nilai) {
  const teks = Array.isArray(nilai) ? nilai.join(", ") : String(nilai ?? "");
  return teks || "semua";
}

// Hitung jumlah dokumen per nilai sebuah field, mis. jumlah jawaban per siswaUid
function hitungPer(docs, field) {
  const jumlah = new Map();
  docs.forEach((doc) => {
    const kunci = doc.data()[field];
    jumlah.set(kunci, (jumlah.get(kunci) || 0) + 1);
  });
  return jumlah;
}

function urutTerlama(docs) {
  return [...docs].sort(
    (a, b) => keMilidetik(a.data().createdAt) - keMilidetik(b.data().createdAt),
  );
}

function tampilkanContoh(baris) {
  baris.slice(0, MAKS_CONTOH).forEach((b) => console.log(`   ${b}`));
  if (baris.length > MAKS_CONTOH) {
    console.log(`   ...dan ${baris.length - MAKS_CONTOH} lainnya`);
  }
}

// listUsers mengembalikan maksimal 1000 akun per halaman, jadi diulang sampai habis
async function ambilSemuaAkunAuth() {
  const semua = [];
  let pageToken;
  do {
    const hasil = await admin.auth().listUsers(1000, pageToken);
    semua.push(...hasil.users);
    pageToken = hasil.pageToken;
  } while (pageToken);
  return semua;
}

async function main() {
  console.log("INVENTARIS DATA (hanya membaca, tidak ada yang diubah)");

  // Data project ini masih kecil, jadi semua koleksi dibaca utuh, sekaligus
  const [users, profil, lookup, rekomendasi, kuesioner, jawaban, notifikasi, antrean, akunAuth] =
    await Promise.all([
      db.collection("users").get(),
      db.collection("siswaProfile").get(),
      db.collection("nisnLookup").get(),
      db.collection("rekomendasi").get(),
      db.collection("kuesioner").get(),
      db.collection("kuesionerResponses").get(),
      db.collection("notifikasi_siswa").get(),
      db.collection("notifikasi").get(),
      ambilSemuaAkunAuth(),
    ]);

  // Map: uid -> isi dokumen. Dipakai untuk cek cepat "apakah uid ini punya bagian X?"
  const dataUsers = new Map(users.docs.map((doc) => [doc.id, doc.data()]));
  const dataProfil = new Map(profil.docs.map((doc) => [doc.id, doc.data()]));
  const emailAuth = new Map(akunAuth.map((akun) => [akun.uid, akun.email]));
  const nisnPerUid = new Map(
    lookup.docs.filter((doc) => doc.data().uid).map((doc) => [doc.data().uid, doc.id]),
  );
  const idRekomendasi = new Set(rekomendasi.docs.map((doc) => doc.id));
  const idKuesioner = new Set(kuesioner.docs.map((doc) => doc.id));

  const jawabanPerSiswa = hitungPer(jawaban.docs, "siswaUid");
  const jawabanPerKuesioner = hitungPer(jawaban.docs, "kuesionerId");
  const notifikasiPerSiswa = hitungPer(notifikasi.docs, "targetUid");

  // ─── A. Siswa ─────────────────────────────────────────────
  console.log(`\nA. Siswa (siswaProfile): ${profil.size}`);
  console.log("   No | NISN | Nama | Jurusan | Angkatan | Jawaban | Notifikasi | UID");
  const siswaUrut = [...profil.docs].sort((a, b) => {
    const pa = a.data();
    const pb = b.data();
    return (
      String(pa.angkatan ?? "").localeCompare(String(pb.angkatan ?? "")) ||
      String(pa.nama ?? "").localeCompare(String(pb.nama ?? ""))
    );
  });
  siswaUrut.forEach((doc, i) => {
    const d = doc.data();
    console.log(
      `   A${i + 1} | ${d.nisn} | ${d.nama} | ${d.jurusan} | ${d.angkatan} | ` +
        `${jawabanPerSiswa.get(doc.id) || 0} | ${notifikasiPerSiswa.get(doc.id) || 0} | ${doc.id}`,
    );
  });

  // ─── B. Akun siswa tidak lengkap ──────────────────────────
  // Akun siswa yang utuh punya 4 bagian. Uid yang muncul di salah satu bagian
  // tapi tidak di bagian lain berarti akunnya terputus (sisa uji coba).
  const semuaUid = new Set([
    ...emailAuth.keys(),
    ...dataUsers.keys(),
    ...dataProfil.keys(),
    ...nisnPerUid.keys(),
  ]);
  const tidakLengkap = [];
  semuaUid.forEach((uid) => {
    // Akun ADMIN memang tidak punya siswaProfile dan nisnLookup
    if (dataUsers.get(uid)?.role === "ADMIN") return;

    const bagian = {
      Auth: emailAuth.has(uid),
      users: dataUsers.has(uid),
      siswaProfile: dataProfil.has(uid),
      nisnLookup: nisnPerUid.has(uid),
    };
    const hilang = Object.keys(bagian).filter((nama) => !bagian[nama]);
    if (hilang.length === 0) return; // lengkap, tidak ditampilkan

    const ada = Object.keys(bagian).filter((nama) => bagian[nama]);
    const nama =
      dataUsers.get(uid)?.nama || dataProfil.get(uid)?.nama || emailAuth.get(uid) || "(tanpa nama)";
    const nisn = dataProfil.get(uid)?.nisn || nisnPerUid.get(uid) || "-";
    tidakLengkap.push(
      `${nama} | NISN ${nisn} | ada: ${ada.join(", ")} | hilang: ${hilang.join(", ")} | ${uid}`,
    );
  });
  console.log(`\nB. Akun siswa tidak lengkap: ${tidakLengkap.length}`);
  tidakLengkap.forEach((baris, i) => console.log(`   B${i + 1} | ${baris}`));

  // ─── C. Rekomendasi ───────────────────────────────────────
  console.log(`\nC. Rekomendasi: ${rekomendasi.size}`);
  console.log("   No | Dibuat | Jenis | Judul | Instansi | Target angkatan | ID");
  urutTerlama(rekomendasi.docs).forEach((doc, i) => {
    const d = doc.data();
    console.log(
      `   C${i + 1} | ${formatTanggal(d.createdAt)} | ${d.jenis} | ${d.judul} | ` +
        `${d.instansi} | ${teksTarget(d.targetAngkatan)} | ${doc.id}`,
    );
  });

  // ─── D. Kuesioner ─────────────────────────────────────────
  console.log(`\nD. Kuesioner: ${kuesioner.size}`);
  console.log("   No | Dibuat | Status | Judul | Target angkatan | Jawaban | ID");
  urutTerlama(kuesioner.docs).forEach((doc, i) => {
    const d = doc.data();
    console.log(
      `   D${i + 1} | ${formatTanggal(d.createdAt)} | ${d.aktif ? "aktif" : "nonaktif"} | ` +
        `${d.judul} | ${teksTarget(d.targetAngkatan)} | ${jawabanPerKuesioner.get(doc.id) || 0} | ${doc.id}`,
    );
  });

  // ─── E. Data yatim (induknya sudah tidak ada) ─────────────
  const jawabanYatim = jawaban.docs.filter((doc) => {
    const d = doc.data();
    return !idKuesioner.has(d.kuesionerId) || !dataUsers.has(d.siswaUid);
  });
  const notifikasiYatim = notifikasi.docs.filter((doc) => {
    const d = doc.data();
    if (!dataUsers.has(d.targetUid)) return true; // pemiliknya sudah tidak ada
    // Notifikasi tanpa refId tidak bisa dicek, jadi tidak dianggap yatim
    if (!d.refId) return false;
    if (d.tipe === "REKOMENDASI_BARU") return !idRekomendasi.has(d.refId);
    if (d.tipe === "KUESIONER_BARU") return !idKuesioner.has(d.refId);
    return false;
  });
  console.log("\nE. Data yatim (induknya sudah tidak ada)");
  console.log(`   Jawaban kuesioner: ${jawabanYatim.length}`);
  tampilkanContoh(
    jawabanYatim.map((doc) => {
      const d = doc.data();
      return `${doc.id} | kuesioner ${d.kuesionerId} | siswa ${d.siswaUid}`;
    }),
  );
  console.log(`   Notifikasi siswa: ${notifikasiYatim.length}`);
  tampilkanContoh(
    notifikasiYatim.map((doc) => {
      const d = doc.data();
      return `${doc.id} | ${d.tipe} | ${d.judul || "(tanpa judul)"} | pemilik ${d.targetUid || "(kosong)"}`;
    }),
  );

  // ─── F. Antrean notifikasi yang belum dikirim ─────────────
  const belumDikirim = antrean.docs.filter((doc) => doc.data().sudahDikirim === false);
  console.log(`\nF. Antrean notifikasi belum dikirim bot: ${belumDikirim.length}`);
  tampilkanContoh(
    belumDikirim.map((doc) => {
      const d = doc.data();
      return `${doc.id} | ${d.tipe} | ${d.judul || "(tanpa judul)"} | ${formatTanggal(d.createdAt)}`;
    }),
  );

  console.log("\nSelesai. Tidak ada data yang diubah.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Gagal:", err);
    process.exit(1);
  });