// src/dataSekolah.js
//
// Satu-satunya sumber data jurusan dan angkatan di backend.
// PENTING: harus identik dengan DataSekolah.kt (Android).
// Kalau salah satu diubah, yang lain wajib ikut diubah.

/**
 * Harus sama persis dengan DataSekolah.DAFTAR_JURUSAN (Android).
 * Nilai inilah yang DISIMPAN ke Firestore.
 */
const DAFTAR_JURUSAN = ["RPL", "TKJ", "Perhotelan"];

/** Angkatan = tahun LULUS. Harus sama dengan DataSekolah.ANGKATAN_TERTUA (Android). */
const ANGKATAN_TERTUA = 2010;

// Variasi tulisan yang dikenal -> bentuk baku.
// Kuncinya sudah "diratakan": huruf kecil, tanpa spasi/tanda baca, "&" dibaca "dan".
// Disalin dari src/scripts/seragamkanJurusan.js (script itu sudah selesai dijalankan).
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

/**
 * Ubah tulisan jurusan apa pun ke bentuk baku.
 * Contoh: "rekayasa perangkat lunak" -> "RPL", "tkj" -> "TKJ".
 * @returns {string|null} bentuk baku, atau null kalau kosong / tidak dikenali
 */
function bakukanJurusan(nilai) {
  if (nilai === null || nilai === undefined) return null;
  const teks = String(nilai).trim();
  if (teks === "") return null;
  if (DAFTAR_JURUSAN.includes(teks)) return teks;
  return PEMETAAN[ratakan(teks)] || null;
}

/**
 * Angkatan tertinggi = tahun lulus kelas XII yang sedang berjalan.
 * Tahun ajaran baru dimulai Juli, jadi:
 * - Juli–Desember: tahun ini + 1 (mis. Oktober 2026 → 2027)
 * - Januari–Juni: tahun ini (kelas XII lulus tahun ini)
 * HARUS sama dengan DataSekolah.angkatanTertinggi() (Android).
 */
function angkatanTertinggi() {
  const now = new Date();
  const tahunIni = now.getFullYear();
  const BULAN_JULI = 6; // getMonth() dimulai dari 0 (Januari = 0), sama seperti Calendar.MONTH di Android
  return now.getMonth() >= BULAN_JULI ? tahunIni + 1 : tahunIni;
}

/**
 * Sama dengan DataSekolah.daftarAngkatan() (Android):
 * dari angkatan tertinggi (kelas XII yang sedang berjalan) turun sampai ANGKATAN_TERTUA, sebagai teks.
 */
function daftarAngkatan() {
  const hasil = [];
  for (let tahun = angkatanTertinggi(); tahun >= ANGKATAN_TERTUA; tahun--) {
    hasil.push(String(tahun));
  }
  return hasil;
}

/** true kalau nilai persis 4 digit angka dan berada di rentang angkatan. */
function angkatanValid(nilai) {
  const teks = String(nilai ?? "").trim();
  if (!/^\d{4}$/.test(teks)) return false;
  const tahun = Number(teks);
  return tahun >= ANGKATAN_TERTUA && tahun <= angkatanTertinggi();
}

module.exports = {
  DAFTAR_JURUSAN,
  ANGKATAN_TERTUA,
  bakukanJurusan,
  daftarAngkatan,
  angkatanValid,
};