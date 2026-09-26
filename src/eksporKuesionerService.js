// src/eksporKuesionerService.js
//
// Membuat file Excel (.xlsx) hasil SATU kuesioner, untuk dikirim bot ke admin.
//
// Aturan hitung SAMA dengan layar Hasil Kuesioner di Android (HasilKuesionerViewModel):
//   - satu siswa dihitung satu kali: kalau jawabannya dobel, ambil yang terbaru
//   - jawaban kosong tidak dihitung
//   - persen dihitung dari siswa yang menjawab pertanyaan itu
//   - siswa target memakai siswaCocok() dari notifikasiService.js
// Kalau aturan di Android berubah, file ini wajib ikut diubah.
//
// Isi file:
//   "Jawaban"       satu baris per siswa (data mentah)
//   "Ringkasan"     jumlah & persen per pilihan, siap untuk statistik deskriptif
//   "Belum Mengisi" siswa target yang belum mengisi, beserta nomor telepon

const ExcelJS = require("exceljs");
const { db } = require("./firebase");
const { siswaCocok, normalisasiList } = require("./notifikasiService");

// HARUS sama persis dengan label enum StatusAlumni di Android (data/model/SiswaProfile.kt),
// termasuk urutannya, supaya tabel Ringkasan urut sama dengan layar Hasil Kuesioner.
const LABEL_STATUS_ALUMNI = ["Belum Bekerja", "Bekerja", "Melanjutkan Kuliah", "Wirausaha"];

// WITA, supaya waktu tetap benar walaupun nanti server memakai jam UTC
const ZONA_WAKTU = "Asia/Makassar";

const JENIS_PERTANYAAN = {
  TEKS: "Isian teks",
  PILIHAN_GANDA: "Pilihan ganda",
  SKALA: "Skala 1–5",
  STATUS_ALUMNI: "Status alumni",
};

// ─── PEMBANTU ────────────────────────────────────────────────

/** 1790316368109 -> "25/09/2026 14:06" (WITA). Kosong kalau tidak ada waktu. */
function formatWaktu(ms) {
  if (!ms) return "";
  const teks = new Intl.DateTimeFormat("id-ID", {
    timeZone: ZONA_WAKTU,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  // Format Indonesia menulis jam dengan titik ("14.06"); diganti titik dua supaya tidak rancu
  return teks.replace(",", "").replace(/(\d{2})\.(\d{2})$/, "$1:$2");
}

/** Tanggal hari ini (WITA) sebagai "2026-09-26", untuk nama file. */
function tanggalHariIni() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_WAKTU }).format(new Date());
}

/** "Tracer Alumni 2024!" -> "Tracer_Alumni_2024" (aman dipakai sebagai nama file). */
function amankanNamaFile(teks) {
  const hasil = String(teks || "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return hasil || "Kuesioner";
}

/** Waktu jawaban terbaru: diperbaruiPada kalau ada, kalau tidak submittedAt. */
function waktuTerbaru(respons) {
  return respons.diperbaruiPada ?? respons.submittedAt ?? 0;
}

/** Satu siswa satu jawaban: kalau dokumennya dobel, ambil yang terbaru. */
function ambilJawabanTerbaruPerSiswa(daftarRespons) {
  const perUid = new Map();
  for (const respons of daftarRespons) {
    const lama = perUid.get(respons.siswaUid);
    if (!lama || waktuTerbaru(respons) > waktuTerbaru(lama)) {
      perUid.set(respons.siswaUid, respons);
    }
  }
  return [...perUid.values()];
}

/** Isi jawaban satu pertanyaan dari satu respons; "" kalau tidak ada atau kosong. */
function ambilJawaban(respons, pertanyaanId) {
  const item = (respons.jawaban || []).find((j) => j.pertanyaanId === pertanyaanId);
  const teks = item && item.jawabanTeks ? String(item.jawabanTeks) : "";
  return teks.trim() === "" ? "" : teks;
}

/** Jumlah & persen tiap label (sama dengan hitung() di HasilKuesionerViewModel). */
function hitung(daftarLabel, isiJawaban) {
  const total = isiJawaban.length;
  return daftarLabel.map((label) => {
    const jumlah = isiJawaban.filter((j) => j === label).length;
    return {
      label,
      jumlah,
      persen: total === 0 ? 0 : Math.round((jumlah * 100) / total),
    };
  });
}

/** Seperti hitung(), ditambah baris untuk jawaban yang tidak ada di daftar pilihan
 *  (mis. pilihan diubah setelah ada yang menjawab), supaya tidak hilang diam-diam. */
function hitungDenganSisa(daftarLabel, isiJawaban) {
  const utama = hitung(daftarLabel, isiJawaban);
  const lain = [...new Set(isiJawaban.filter((j) => !daftarLabel.includes(j)))];
  const tambahan = hitung(lain, isiJawaban).map((baris) => ({
    ...baris,
    label: `${baris.label} (di luar daftar pilihan)`,
  }));
  return { rincian: [...utama, ...tambahan], adaDiLuarDaftar: tambahan.length > 0 };
}

/** Tebalkan dan beri latar abu-abu pada baris judul kolom. */
function gayakanJudulKolom(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
    cell.alignment = { vertical: "top", wrapText: true };
  });
}

/** Tulis tabel kecil (judul kolom + isi) di sheet Ringkasan. */
function tulisTabel(sheet, judulKolom, rincian) {
  gayakanJudulKolom(sheet.addRow(judulKolom));
  rincian.forEach((r) => sheet.addRow([r.label, r.jumlah, r.persen]));
}

// ─── DAFTAR KUESIONER (untuk menu pilih di bot) ──────────────

/** Kuesioner terbaru beserta jumlah siswa yang sudah mengisi. */
async function daftarKuesionerUntukEkspor(batas = 10) {
  const snapshot = await db
    .collection("kuesioner")
    .orderBy("createdAt", "desc")
    .limit(batas)
    .get();

  return Promise.all(
    snapshot.docs.map(async (doc) => {
      const k = doc.data();
      const snapJawaban = await db
        .collection("kuesionerResponses")
        .where("kuesionerId", "==", doc.id)
        .get();
      // Dihitung per siswa, sama seperti layar Hasil (jawaban dobel dihitung satu)
      const jumlahResponden = new Set(snapJawaban.docs.map((d) => d.data().siswaUid)).size;
      return {
        id: doc.id,
        judul: k.judul || "(tanpa judul)",
        aktif: k.aktif !== false,
        jumlahResponden,
      };
    }),
  );
}

// ─── BUAT FILE EKSPOR ────────────────────────────────────────

/**
 * Buat file Excel hasil satu kuesioner.
 * @returns {{buffer: Buffer, namaFile: string, ringkas: object}}
 */
async function buatFileEkspor(kuesionerId) {
  // ─── 1. Ambil data (tiga pengambilan berjalan bersamaan) ───
  const [docKuesioner, snapJawaban, snapSiswa] = await Promise.all([
    db.collection("kuesioner").doc(kuesionerId).get(),
    db.collection("kuesionerResponses").where("kuesionerId", "==", kuesionerId).get(),
    db.collection("siswaProfile").get(),
  ]);

  if (!docKuesioner.exists) {
    throw new Error("Kuesioner tidak ditemukan (mungkin sudah dihapus).");
  }

  const kuesioner = docKuesioner.data();
  const daftarPertanyaan = kuesioner.pertanyaan || [];
  const responsTerbaru = ambilJawabanTerbaruPerSiswa(snapJawaban.docs.map((d) => d.data()));
  const profilPerUid = new Map(snapSiswa.docs.map((d) => [d.id, d.data()]));

  // Siswa target: aturan yang sama dengan notifikasi dan layar Hasil
  const targetAngkatan = normalisasiList(kuesioner.targetAngkatan);
  const targetJurusan = normalisasiList(kuesioner.targetJurusan);
  const siswaTarget = snapSiswa.docs.filter((d) =>
    siswaCocok(d.data(), targetAngkatan, targetJurusan),
  );
  const uidSudahMengisi = new Set(responsTerbaru.map((r) => r.siswaUid));
  const targetSudahMengisi = siswaTarget.filter((d) => uidSudahMengisi.has(d.id)).length;
  const tingkatRespons =
    siswaTarget.length === 0 ? 0 : Math.round((targetSudahMengisi * 100) / siswaTarget.length);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TracerStudy SMK Telkom Makassar";
  workbook.created = new Date();

  // ─── 2. Sheet "Jawaban": satu baris per siswa ──────────────
  const sheetJawaban = workbook.addWorksheet("Jawaban", {
    views: [{ state: "frozen", ySplit: 1 }], // baris judul kolom tetap terlihat saat digulir
  });
  sheetJawaban.columns = [
    { header: "No", key: "no", width: 5 },
    // "@" = format Teks, supaya NISN seperti 0051234567 tidak kehilangan nol di depan
    { header: "NISN", key: "nisn", width: 13, style: { numFmt: "@" } },
    { header: "Nama", key: "nama", width: 25 },
    { header: "Jurusan", key: "jurusan", width: 11 },
    { header: "Angkatan", key: "angkatan", width: 10 },
    { header: "Waktu Mengisi (WITA)", key: "waktu", width: 18 },
    ...daftarPertanyaan.map((p, i) => ({
      header: `${i + 1}. ${p.teks}`,
      key: `p${i}`,
      width: (p.tipe || "TEKS") === "TEKS" ? 35 : 18,
    })),
  ];
  gayakanJudulKolom(sheetJawaban.getRow(1));

  [...responsTerbaru]
    .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0)) // terbaru di atas, sama dengan layar Hasil
    .forEach((respons, index) => {
      const profil = profilPerUid.get(respons.siswaUid) || {};
      const baris = {
        no: index + 1,
        nisn: String(profil.nisn || ""),
        nama: profil.nama || "(nama tidak ditemukan)",
        jurusan: profil.jurusan || "",
        angkatan: profil.angkatan || "",
        waktu: formatWaktu(respons.submittedAt),
      };

      daftarPertanyaan.forEach((p, i) => {
        const isi = ambilJawaban(respons, p.id);
        if (isi === "") {
          // Tidak ditanyakan (pertanyaan bersyarat) atau tidak dijawab: sel dibiarkan kosong,
          // supaya rumus Excel seperti AVERAGE dan COUNTIF mengabaikannya
          baris[`p${i}`] = null;
        } else if (p.tipe === "SKALA" && /^\d+$/.test(isi.trim())) {
          baris[`p${i}`] = Number(isi); // disimpan sebagai angka, bisa langsung dirata-rata
        } else {
          baris[`p${i}`] = isi;
        }
      });

      sheetJawaban.addRow(baris).alignment = { vertical: "top", wrapText: true };
    });

  // ─── 3. Sheet "Ringkasan": statistik deskriptif ────────────
  const sheetRingkasan = workbook.addWorksheet("Ringkasan");
  sheetRingkasan.columns = [{ width: 50 }, { width: 12 }, { width: 12 }];

  sheetRingkasan.addRow([kuesioner.judul || "(tanpa judul)"]).font = { bold: true, size: 14 };
  const tambahInfo = (label, nilai) => {
    sheetRingkasan.addRow([label, nilai]).getCell(1).font = { bold: true };
  };
  tambahInfo("Target angkatan", targetAngkatan.length ? targetAngkatan.join(", ") : "Semua angkatan");
  tambahInfo("Target jurusan", targetJurusan.length ? targetJurusan.join(", ") : "Semua jurusan");
  tambahInfo("Diekspor pada (WITA)", formatWaktu(Date.now()));
  tambahInfo("Jumlah responden", responsTerbaru.length);
  tambahInfo("Siswa target", siswaTarget.length);
  tambahInfo("Siswa target yang sudah mengisi", targetSudahMengisi);
  tambahInfo("Tingkat respons (%)", tingkatRespons);

  let adaDiLuarDaftar = false;

  daftarPertanyaan.forEach((p, i) => {
    const tipe = p.tipe || "TEKS";
    const isiJawaban = responsTerbaru
      .map((r) => ambilJawaban(r, p.id))
      .filter((isi) => isi !== "");

    sheetRingkasan.addRow([]);
    const judul = sheetRingkasan.addRow([`${i + 1}. ${p.teks}`]);
    judul.font = { bold: true };
    judul.alignment = { wrapText: true };
    sheetRingkasan.addRow([
      `${JENIS_PERTANYAAN[tipe] || tipe} — ${isiJawaban.length} siswa menjawab`,
    ]).font = { italic: true };

    if (tipe === "PILIHAN_GANDA" || tipe === "STATUS_ALUMNI") {
      const daftarLabel = tipe === "STATUS_ALUMNI" ? LABEL_STATUS_ALUMNI : p.opsi || [];
      const hasil = hitungDenganSisa(daftarLabel, isiJawaban);
      if (hasil.adaDiLuarDaftar) adaDiLuarDaftar = true;
      tulisTabel(sheetRingkasan, ["Pilihan", "Jumlah", "Persen (%)"], hasil.rincian);
    } else if (tipe === "SKALA") {
      // Sama dengan toIntOrNull() di Android: hanya bilangan bulat yang dirata-rata
      const angka = isiJawaban.filter((j) => /^-?\d+$/.test(j)).map(Number);
      const rataRata = angka.length ? angka.reduce((a, b) => a + b, 0) / angka.length : 0;
      sheetRingkasan.addRow(["Rata-rata", Math.round(rataRata * 100) / 100]).getCell(1).font = {
        bold: true,
      };
      tulisTabel(
        sheetRingkasan,
        ["Nilai", "Jumlah", "Persen (%)"],
        hitung(["1", "2", "3", "4", "5"], isiJawaban),
      );
    } else {
      sheetRingkasan.addRow(["Isi jawaban ada di sheet Jawaban"]);
    }
  });

  // ─── 4. Sheet "Belum Mengisi": untuk ditindaklanjuti admin ─
  const sheetBelum = workbook.addWorksheet("Belum Mengisi", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheetBelum.columns = [
    { header: "No", key: "no", width: 5 },
    { header: "NISN", key: "nisn", width: 13, style: { numFmt: "@" } },
    { header: "Nama", key: "nama", width: 25 },
    { header: "Jurusan", key: "jurusan", width: 11 },
    { header: "Angkatan", key: "angkatan", width: 10 },
    // Teks juga, supaya nol di depan nomor HP (08...) tidak hilang
    { header: "No. Telepon", key: "noTelepon", width: 15, style: { numFmt: "@" } },
  ];
  gayakanJudulKolom(sheetBelum.getRow(1));

  const belumMengisi = siswaTarget
    .filter((d) => !uidSudahMengisi.has(d.id))
    .map((d) => d.data())
    .sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));

  if (belumMengisi.length === 0) {
    sheetBelum.addRow({ nama: "Semua siswa target sudah mengisi." });
  } else {
    belumMengisi.forEach((s, i) => {
      sheetBelum.addRow({
        no: i + 1,
        nisn: String(s.nisn || ""),
        nama: s.nama || "",
        jurusan: s.jurusan || "",
        angkatan: s.angkatan || "",
        noTelepon: String(s.noTelepon || ""),
      });
    });
  }

  if (adaDiLuarDaftar) {
    console.warn(
      `⚠️ Ekspor "${kuesioner.judul}": ada jawaban di luar daftar pilihan (ditandai di sheet Ringkasan)`,
    );
  }

  // ─── 5. Jadikan file ───────────────────────────────────────
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    buffer,
    namaFile: `Hasil_${amankanNamaFile(kuesioner.judul)}_${tanggalHariIni()}.xlsx`,
    ringkas: {
      judul: kuesioner.judul || "(tanpa judul)",
      jumlahResponden: responsTerbaru.length,
      jumlahTarget: siswaTarget.length,
      targetSudahMengisi,
      tingkatRespons,
      adaDiLuarDaftar,
    },
  };
}

module.exports = {
  daftarKuesionerUntukEkspor,
  buatFileEkspor,
  LABEL_STATUS_ALUMNI,
};