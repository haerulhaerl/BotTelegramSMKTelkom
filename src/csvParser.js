// src/csvParser.js
//
// Port dari CsvSiswaParser.kt (Android).
// PENTING: aturan validasi di sini harus SELALU identik dengan versi Kotlin.
// Kalau salah satu diubah, yang lain wajib ikut diubah.

const EXPECTED_COLUMN_COUNT = 5;
const NISN_REGEX = /^\d{10}$/;
const PHONE_REGEX = /^08\d{8,11}$/;

const EXPECTED_HEADER = ["nisn", "nama", "jurusan", "angkatan", "notelepon"];

/**
 * @param {string} csvContent isi file CSV sebagai string utuh
 * @returns {{ok: true, rows: Array} | {ok: false, reason: string}}
 */
function parseCsv(csvContent) {
  // Buang BOM (Byte Order Mark) kalau ada — Excel versi Windows kadang
  // menyisipkan karakter tak kasat mata ini di awal file, bikin header
  // "nisn" terbaca jadi "\uFEFFnisn" dan validasi header gagal padahal
  // isinya terlihat benar.
  const cleaned = csvContent.replace(/^\uFEFF/, "");

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { ok: false, reason: "File CSV kosong atau tidak bisa dibaca." };
  }

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const headerCocok =
    header.length === EXPECTED_HEADER.length &&
    header.every((h, i) => h === EXPECTED_HEADER[i]);

  if (!headerCocok) {
    return {
      ok: false,
      reason:
        "Format header tidak sesuai. Harus persis: nisn,nama,jurusan,angkatan,noTelepon",
    };
  }

  const rows = lines.slice(1).map((line, index) => parseRow(index + 2, line));

  return { ok: true, rows: markInFileDuplicates(rows) };
}

function parseRow(rowNumber, line) {
  const columns = line.split(",").map((c) => c.trim());

  if (columns.length !== EXPECTED_COLUMN_COUNT) {
    return {
      rowNumber,
      nisn: columns[0] || "",
      nama: columns[1] || "",
      jurusan: columns[2] || "",
      angkatan: columns[3] || "",
      noTelepon: columns[4] || "",
      status: "ERROR",
      message: `Jumlah kolom tidak sesuai (harus ${EXPECTED_COLUMN_COUNT} kolom)`,
    };
  }

  const [nisn, nama, jurusan, angkatan, noTelepon] = columns;
  const row = { rowNumber, nisn, nama, jurusan, angkatan, noTelepon };

  return { ...row, ...validateRow(row) };
}

function validateRow(row) {
  if (!row.nama) {
    return { status: "ERROR", message: "Nama tidak boleh kosong" };
  }
  if (!row.jurusan) {
    return { status: "ERROR", message: "Jurusan tidak boleh kosong" };
  }
  if (!row.angkatan || isNaN(parseInt(row.angkatan, 10))) {
    return { status: "ERROR", message: "Angkatan harus berupa angka (contoh: 2021)" };
  }
  if (!NISN_REGEX.test(row.nisn)) {
    return { status: "ERROR", message: "NISN harus persis 10 digit angka" };
  }
  if (!PHONE_REGEX.test(row.noTelepon)) {
    return { status: "WARNING", message: "Format nomor telepon terlihat tidak biasa, cek kembali" };
  }
  return { status: "VALID", message: "" };
}

/** Cek NISN yang muncul lebih dari sekali DI DALAM FILE ini sendiri.
 *  Duplikat terhadap data yang sudah ada di Firestore dicek terpisah
 *  di siswaAccountService.js. */
function markInFileDuplicates(rows) {
  const hitung = {};
  rows.forEach((r) => {
    hitung[r.nisn] = (hitung[r.nisn] || 0) + 1;
  });

  return rows.map((row) => {
    if (hitung[row.nisn] > 1 && row.status === "VALID") {
      return {
        ...row,
        status: "ERROR",
        message: "NISN duplikat di dalam file ini (baris lain juga pakai NISN yang sama)",
      };
    }
    return row;
  });
}

module.exports = { parseCsv };