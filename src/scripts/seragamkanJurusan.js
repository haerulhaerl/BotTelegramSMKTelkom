/**
 * Seragamkan tulisan jurusan di data lama (fitur jurusan/angkatan baku).
 *
 * Bentuk baku HARUS sama dengan DataSekolah.DAFTAR_JURUSAN di aplikasi Android:
 *   "RPL", "TKJ", "Perhotelan"
 *
 * Yang diperiksa:
 *   siswaProfile.jurusan, users.jurusan          (teks)
 *   kuesioner.targetJurusan, rekomendasi.targetJurusan  (daftar)
 *
 * Nilai yang TIDAK DIKENALI tidak diubah, hanya dilaporkan.
 *
 * Cara pakai (dari folder tracerstudy-bot):
 *   node src/scripts/seragamkanJurusan.js             -> UJI COBA: hanya menampilkan, tidak mengubah
 *   node src/scripts/seragamkanJurusan.js --terapkan  -> benar-benar mengubah data
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// Sama seperti script lain: baca file service account langsung (tanpa .env)
const serviceAccount = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "tracerstudy-cad74-e7e38e069475.json"),
    "utf8",
  ),
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TERAPKAN = process.argv.includes("--terapkan");

// Harus sama dengan DataSekolah.DAFTAR_JURUSAN (Android)
const DAFTAR_JURUSAN = ["RPL", "TKJ", "Perhotelan"];

// Variasi tulisan yang dikenal -> bentuk baku.
// Kuncinya sudah "diratakan": huruf kecil, tanpa spasi/tanda baca, "&" dibaca "dan".
const PEMETAAN = {
  rpl: "RPL",
  rekayasaperangkatlunak: "RPL",
  rekayasaperangkatlunakrpl: "RPL",
  tkj: "TKJ",
  teknikkomputerdanjaringan: "TKJ",
  teknikkomputerjaringan: "TKJ",
  teknikkomputerdanjaringantkj: "TKJ",
  perhotelan: "Perhotelan",
  akomodasiperhotelan: "Perhotelan",
  aph: "Perhotelan", // singkatan umum Akomodasi Perhotelan
};

/** "Rekayasa Perangkat-Lunak " -> "rekayasaperangkatlunak" */
function ratakan(teks) {
  return String(teks)
    .toLowerCase()
    .replace(/&/g, "dan")
    .replace(/[^a-z0-9]/g, "");
}

/** Tentukan bentuk baku sebuah nilai jurusan beserta statusnya. */
function bakukan(nilai) {
  if (nilai === null || nilai === undefined || String(nilai).trim() === "") {
    return { hasil: "", status: "kosong" };
  }
  const teks = String(nilai).trim();
  if (DAFTAR_JURUSAN.includes(teks)) return { hasil: teks, status: "baku" };
  const baku = PEMETAAN[ratakan(teks)];
  if (baku) return { hasil: baku, status: "diubah" };
  return { hasil: teks, status: "tidakDikenali" };
}

/** Hitung berapa kali setiap nilai asli muncul, untuk laporan. */
function catat(ringkasan, nilai, status, hasil) {
  const kunci = nilai === null || nilai === undefined ? "" : String(nilai);
  const lama = ringkasan.get(kunci);
  if (lama) lama.jumlah += 1;
  else ringkasan.set(kunci, { status, hasil, jumlah: 1 });
}

/** Koleksi dengan field teks "jurusan" (siswaProfile, users). */
async function periksaFieldTeks(namaKoleksi) {
  const snapshot = await db.collection(namaKoleksi).get();
  const ringkasan = new Map();
  const perubahan = [];

  snapshot.docs.forEach((doc) => {
    const nilai = doc.data().jurusan;
    const { hasil, status } = bakukan(nilai);
    catat(ringkasan, nilai, status, hasil);
    if (status === "diubah") {
      perubahan.push({
        ref: doc.ref,
        data: { jurusan: hasil },
        keterangan: `"${nilai}" -> "${hasil}"`,
      });
    }
  });
  return { total: snapshot.size, ringkasan, perubahan };
}

/** Koleksi dengan field daftar "targetJurusan" (kuesioner, rekomendasi). */
async function periksaFieldDaftar(namaKoleksi) {
  const snapshot = await db.collection(namaKoleksi).get();
  const ringkasan = new Map();
  const perubahan = [];

  snapshot.docs.forEach((doc) => {
    const daftar = doc.data().targetJurusan || [];
    const baru = [];
    daftar.forEach((nilai) => {
      const { hasil, status } = bakukan(nilai);
      catat(ringkasan, nilai, status, hasil);
      // Isi kosong dibuang, dan duplikat (mis. "rpl" + "RPL") digabung jadi satu
      if (status !== "kosong" && !baru.includes(hasil)) baru.push(hasil);
    });

    const berubah =
      baru.length !== daftar.length || baru.some((v, i) => v !== daftar[i]);
    if (berubah) {
      perubahan.push({
        ref: doc.ref,
        data: { targetJurusan: baru },
        keterangan: `[${daftar.join(", ")}] -> [${baru.join(", ")}]`,
      });
    }
  });
  return { total: snapshot.size, ringkasan, perubahan };
}

function tampilkanLaporan(label, { total, ringkasan, perubahan }) {
  const arti = {
    baku: "sudah baku",
    kosong: "kosong, dibiarkan",
    tidakDikenali: "TIDAK DIKENALI (tidak diubah)",
  };

  console.log(`\n=== ${label} (${total} dokumen) ===`);
  for (const [nilai, info] of ringkasan) {
    const tampil = nilai === "" ? "(kosong)" : `"${nilai}"`;
    const keterangan =
      info.status === "diubah" ? `-> "${info.hasil}"` : arti[info.status];
    console.log(
      `  ${tampil.padEnd(34)} ${String(info.jumlah).padStart(3)}x  ${keterangan}`,
    );
  }

  console.log(`  Dokumen yang akan diubah: ${perubahan.length}`);
  perubahan
    .slice(0, 10)
    .forEach((p) => console.log(`    - ${p.ref.path} | ${p.keterangan}`));
  if (perubahan.length > 10)
    console.log(`    ...dan ${perubahan.length - 10} lainnya`);
}

async function terapkanSemua(perubahan) {
  // Satu batch Firestore maksimal 500 operasi
  for (let i = 0; i < perubahan.length; i += 500) {
    const batch = db.batch();
    perubahan
      .slice(i, i + 500)
      .forEach(({ ref, data }) => batch.update(ref, data));
    await batch.commit();
  }
}

async function main() {
  console.log(
    TERAPKAN
      ? "MODE: TERAPKAN (data akan diubah)"
      : "MODE: UJI COBA (tidak ada yang diubah)",
  );

  const hasil = {
    "siswaProfile.jurusan": await periksaFieldTeks("siswaProfile"),
    "users.jurusan": await periksaFieldTeks("users"),
    "kuesioner.targetJurusan": await periksaFieldDaftar("kuesioner"),
    "rekomendasi.targetJurusan": await periksaFieldDaftar("rekomendasi"),
  };

  for (const [label, h] of Object.entries(hasil)) tampilkanLaporan(label, h);

  const semuaPerubahan = Object.values(hasil).flatMap((h) => h.perubahan);
  const adaTidakDikenali = Object.values(hasil).some((h) =>
    [...h.ringkasan.values()].some((info) => info.status === "tidakDikenali"),
  );

  if (adaTidakDikenali) {
    console.log(
      "\nPERHATIAN: ada nilai TIDAK DIKENALI. Tambahkan ke PEMETAAN atau perbaiki manual.",
    );
  }

  if (!TERAPKAN) {
    console.log(
      `\nTotal ${semuaPerubahan.length} dokumen AKAN diubah. Jalankan ulang dengan --terapkan untuk menerapkan.`,
    );
    return;
  }

  await terapkanSemua(semuaPerubahan);
  console.log(`\nSelesai: ${semuaPerubahan.length} dokumen diubah.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Gagal:", err);
    process.exit(1);
  });
