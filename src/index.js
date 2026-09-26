const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  ADMIN_UID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = require("./config");
const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { db, admin } = require("./firebase");
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const ws = require("ws");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});
const { startServer } = require("./server");
const { resetPasswordSiswa, DEFAULT_PASSWORD } = require("./resetPasswordService");
const { parseCsv } = require("./csvParser");
const { bulkImportSiswa } = require("./siswaAccountService");
const { kirimNotifikasiTertarget } = require("./notifikasiService");
const {
  daftarKuesionerUntukEkspor,
  buatFileEkspor,
} = require("./eksporKuesionerService");
const {
  DAFTAR_JURUSAN,
  ANGKATAN_TERTUA,
  bakukanJurusan,
  angkatanValid,
} = require("./dataSekolah");

// ─── ERROR POLLING TELEGRAM ──────────────────────────────────
// Koneksi long-polling ke Telegram kadang putus (WiFi/ISP/laptop sleep).
// Library otomatis mencoba lagi, jadi error jaringan cukup dicatat singkat.
bot.on("polling_error", (error) => {
  const pesanAsli = error.message || "";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(pesanAsli)) {
    console.warn(`⚠️ Koneksi ke Telegram terputus sesaat (${pesanAsli}). Mencoba lagi otomatis...`);
    return;
  }
  // Error lain tetap tampil lengkap, misal 409 Conflict = bot jalan di 2 terminal sekaligus
  console.error("❌ Polling error:", error.code, pesanAsli);
});


// ─── JARING PENGAMAN PENGIRIMAN PESAN ────────────────────────
// Kalau Telegram menolak format Markdown (mis. judul berisi "_" atau "*"
// tanpa pasangan), pesan dikirim ulang sebagai teks biasa. Tanpa ini,
// pesan hilang diam-diam dan admin tidak mendapat balasan apa pun.
const kirimPesanAsli = bot.sendMessage.bind(bot);
bot.sendMessage = (chatId, teks, opsi = {}) =>
  kirimPesanAsli(chatId, teks, opsi).catch((error) => {
    const pesanError = error.message || "";
    const formatDitolak =
      opsi.parse_mode && /can't parse entities/i.test(pesanError);

    if (formatDitolak) {
      console.warn(
        `⚠️ Format Markdown ditolak Telegram, dikirim ulang sebagai teks biasa (${pesanError})`,
      );
      const { parse_mode, ...opsiTanpaFormat } = opsi;
      return kirimPesanAsli(chatId, teks, opsiTanpaFormat).catch((e) =>
        console.error("❌ Gagal kirim pesan (teks biasa):", e.message),
      );
    }
    console.error("❌ Gagal kirim pesan:", pesanError);
  });

// Jaring terakhir untuk error async lain yang lolos (Promise bawaan Node).
// Tanpa ini, Node.js 20 menghentikan seluruh proses (bot + server Express).
process.on("unhandledRejection", (alasan) => {
  console.error("❌ Unhandled rejection (bot tetap berjalan):", alasan);
});

// ─── STATE PERCAKAPAN ────────────────────────────────────────
const sesi = {};

function resetSesi(chatId) {
  sesi[chatId] = { tahap: null, data: {} };
}

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

function tampilkanMenu(chatId) {
  bot.sendMessage(chatId, "📋 *Menu Utama*\n\nPilih salah satu opsi:", {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: "➕ Tambah Rekomendasi" }],
        [{ text: "📋 Lihat Rekomendasi" }],
        [{ text: "🗑️ Hapus Rekomendasi" }],
        [{ text: "🔑 Reset Password Siswa" }],
        [{ text: "📥 Import Siswa (CSV)" }],
        [{ text: "📊 Ekspor Hasil Kuesioner" }],
        [{ text: "🧪 Testing" }],
      ],
      resize_keyboard: true,
    },
  });
}

// ─── KIRIM NOTIFIKASI REKOMENDASI ────────────────────────────
async function kirimNotifikasiRekomendasi(judul, instansi, refId = "", targetAngkatan = []) {
  try {
    await kirimNotifikasiTertarget({
      tipe: "REKOMENDASI_BARU",
      judul: "📢 Rekomendasi Baru!",
      pesan: `${judul} dari ${instansi} — Cek sekarang!`,
      refId,
      targetAngkatan,
      // Jurusan sengaja tidak menyaring notif rekomendasi: di aplikasi, jurusan
      // hanya menaikkan skor (MatchingEngine), bukan menyembunyikan rekomendasi.
      targetJurusan: [],
    });
  } catch (error) {
    console.error("❌ Gagal kirim notifikasi rekomendasi:", error);
  }
}
// ─── UPLOAD FOTO KE SUPABASE ─────────────────────────────────
async function uploadFotoKeSupabase(fileId) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);

    const fileName = `rekomendasi_${Date.now()}.jpg`;
    const { data, error } = await supabase.storage
      .from("rekomendasi-images")
      .upload(fileName, buffer, { contentType: "image/jpeg", upsert: false });

    if (error) throw error;

    const { data: urlData } = supabase.storage
      .from("rekomendasi-images")
      .getPublicUrl(fileName);

    return urlData.publicUrl;
  } catch (error) {
    console.error("Error upload foto:", error);
    return null;
  }
}

// ─── HANDLER /start ──────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    bot.sendMessage(
      chatId,
      "⛔ Maaf, bot ini hanya untuk admin Tracer Study SMK Telkom.",
    );
    return;
  }
  resetSesi(chatId);
  bot.sendMessage(
    chatId,
    `👋 Halo, *Admin SMK Telkom*!\n\nSelamat datang di bot Tracer Study.`,
    {
      parse_mode: "Markdown",
    },
  );
  tampilkanMenu(chatId);
});

// ─── HANDLER FOTO ────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  if (!sesi[chatId]) resetSesi(chatId);

  const { tahap } = sesi[chatId];

  if (tahap === "foto") {
    bot.sendMessage(chatId, "⏳ Mengupload foto...");
    const foto = msg.photo[msg.photo.length - 1];
    const imageUrl = await uploadFotoKeSupabase(foto.file_id);

    if (!imageUrl) {
      bot.sendMessage(
        chatId,
        "❌ Gagal upload foto. Coba lagi atau ketik `-` untuk skip.",
      );
      return;
    }

    sesi[chatId].data.imageUrl = imageUrl;
    bot.sendMessage(chatId, "✅ Foto berhasil diupload!");
    await lanjutKeKonfirmasi(chatId);
  } else {
    bot.sendMessage(chatId, "⚠️ Foto tidak diharapkan di tahap ini.");
  }
});

// ─── HANDLER PIN LOKASI (📎 → Location) ──────────────────────
bot.on("location", async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  if (!sesi[chatId]) resetSesi(chatId);

  if (sesi[chatId].tahap !== "pin") {
    bot.sendMessage(chatId, "⚠️ Lokasi tidak diharapkan di tahap ini.");
    return;
  }

  const { latitude, longitude } = msg.location;
  sesi[chatId].data.latitude = latitude;
  sesi[chatId].data.longitude = longitude;
  await bot.sendMessage(chatId, `✅ Pin tersimpan: ${latitude}, ${longitude}`);
  tanyaDeskripsi(chatId);
});

/** Ubah teks "-5.1477, 119.4327" jadi { latitude, longitude }.
 *  Return null kalau formatnya salah atau angkanya di luar rentang. */
function parseKoordinat(teks) {
  const cocok = teks
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!cocok) return null;

  const latitude = parseFloat(cocok[1]);
  const longitude = parseFloat(cocok[2]);
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/** Pertanyaan deskripsi dipakai dari dua tempat (pin via Location
 *  dan pin via teks), jadi dijadikan satu fungsi. */
function tanyaDeskripsi(chatId) {
  sesi[chatId].tahap = "deskripsi";
  bot.sendMessage(
    chatId,
    "📄 Masukkan *deskripsi* singkat:\n\nKetik `-` jika tidak ada.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    },
  );
}

// ─── TARGET JURUSAN (TOMBOL PILIHAN) ─────────────────────────
const TOMBOL_SEMUA_JURUSAN = "Semua jurusan";
const TOMBOL_SELESAI_JURUSAN = "✅ Selesai";

/** Keyboard target jurusan: satu tombol per jurusan baku dari dataSekolah.js,
 *  jadi kalau ada jurusan baru cukup ditambah di DAFTAR_JURUSAN. */
function keyboardTargetJurusan() {
  return {
    keyboard: [
      DAFTAR_JURUSAN.map((j) => ({ text: j })),
      [{ text: TOMBOL_SEMUA_JURUSAN }],
      [{ text: TOMBOL_SELESAI_JURUSAN }],
      [{ text: "❌ Batal" }],
    ],
    resize_keyboard: true,
  };
}

/** Pertanyaan target angkatan dipakai dari dua tempat
 *  ("Semua jurusan" dan "✅ Selesai"), jadi dijadikan satu fungsi. */
function tanyaTargetAngkatan(chatId) {
  sesi[chatId].tahap = "targetAngkatan";
  bot.sendMessage(
    chatId,
    "📅 Masukkan *target angkatan* (pisah dengan koma):\nContoh: `2023, 2024`\n\nKetik `-` untuk semua angkatan.\n\n_Siswa di luar angkatan ini tidak akan melihat rekomendasi dan tidak menerima notifikasinya._",
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    },
  );
}

// ─── HANDLER DOKUMEN (FILE CSV IMPORT SISWA) ─────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  if (!sesi[chatId]) resetSesi(chatId);

  const { tahap } = sesi[chatId];

  if (tahap !== "upload_csv") {
    bot.sendMessage(chatId, "⚠️ File tidak diharapkan di tahap ini.");
    return;
  }

  const doc = msg.document;

  if (doc.file_size > 2 * 1024 * 1024) {
    bot.sendMessage(chatId, "❌ File terlalu besar (maksimal 2 MB).");
    return;
  }

  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith(".csv")) {
    bot.sendMessage(
      chatId,
      "❌ File harus berformat *.csv*.\n\nKalau datamu di Excel, simpan dulu sebagai CSV (File → Save As → CSV UTF-8).",
      { parse_mode: "Markdown" },
    );
    return;
  }

  bot.sendMessage(chatId, "⏳ Membaca file CSV...");

  const csvContent = await unduhIsiFileTelegram(doc.file_id);
  if (csvContent === null) {
    bot.sendMessage(chatId, "❌ Gagal mengunduh file. Coba kirim ulang.");
    return;
  }

  const hasilParse = parseCsv(csvContent);

  if (!hasilParse.ok) {
    bot.sendMessage(chatId, `❌ ${hasilParse.reason}`);
    return;
  }

  await tampilkanPreviewImport(chatId, hasilParse.rows, doc.file_name);
});

// ─── HANDLER PESAN TEKS ──────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const teks = msg.text;

  if (!teks || teks.startsWith("/start")) return;
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, "⛔ Maaf, kamu tidak punya akses ke bot ini.");
    return;
  }
  if (!sesi[chatId]) resetSesi(chatId);

  const { tahap } = sesi[chatId];

  // ─── MENU UTAMA ──────────────────────────────────────────
  if (teks === "➕ Tambah Rekomendasi") {
    resetSesi(chatId);
    sesi[chatId].tahap = "judul";
    bot.sendMessage(
      chatId,
      "📝 *Tambah Rekomendasi Baru*\n\nMasukkan *judul* rekomendasi:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (teks === "📋 Lihat Rekomendasi") {
    await tampilkanDaftarRekomendasi(chatId);
    return;
  }

  if (teks === "🗑️ Hapus Rekomendasi") {
    await mulaiHapusRekomendasi(chatId);
    return;
  }

    if (teks === "🔑 Reset Password Siswa") {
    await mulaiResetPasswordSiswa(chatId);
    return;
  }


  if (teks === "📥 Import Siswa (CSV)") {
    await mulaiImportSiswa(chatId);
    return;
  }

  if (teks === "📊 Ekspor Hasil Kuesioner") {
    await mulaiEksporKuesioner(chatId);
    return;
  }

    // ─── ALUR IMPORT SISWA ───────────────────────────────────
  if (tahap === "upload_csv") {
    bot.sendMessage(
      chatId,
      "⚠️ Kirim *file CSV* sebagai dokumen (lampiran 📎), bukan teks.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (tahap === "konfirmasi_import") {
    if (teks === "✅ Ya, Import") {
      await jalankanImportSiswa(chatId);
    } else {
      resetSesi(chatId);
      bot.sendMessage(chatId, "❌ Dibatalkan.");
      tampilkanMenu(chatId);
    }
    return;
  }

  if (teks === "❌ Batal") {
    resetSesi(chatId);
    bot.sendMessage(chatId, "✅ Dibatalkan.");
    tampilkanMenu(chatId);
    return;
  }

  // ─── TESTING ─────────────────────────────────────────────
  if (teks === "🧪 Testing") {
    resetSesi(chatId);
    sesi[chatId].data = {
      judul: "Magang Testing Dummy",
      instansi: "PT Testing Bot",
      jenis: "MAGANG",
      lokasi: "Bandung",
      deskripsi: "Ini adalah rekomendasi dummy untuk keperluan testing bot.",
      targetAngkatan: [],
      targetKeahlian: ["JavaScript", "Node.js"],
      link: "https://example.com",
      imageUrl: "",
    };
    await simpanRekomendasi(chatId);
    return;
  }

  // ─── ALUR TAMBAH REKOMENDASI ─────────────────────────────
  if (tahap === "judul") {
    sesi[chatId].data.judul = teks;
    sesi[chatId].tahap = "instansi";
    bot.sendMessage(chatId, "🏢 Masukkan *nama instansi/perusahaan*:", {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (tahap === "instansi") {
    sesi[chatId].data.instansi = teks;
    sesi[chatId].tahap = "jenis";
    bot.sendMessage(chatId, "📌 Pilih *jenis* rekomendasi:", {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          [{ text: "MAGANG" }, { text: "PEKERJAAN" }],
          [{ text: "BEASISWA" }, { text: "❌ Batal" }],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (tahap === "jenis") {
    const jenisValid = ["MAGANG", "PEKERJAAN", "BEASISWA"];
    if (!jenisValid.includes(teks)) {
      bot.sendMessage(
        chatId,
        "⚠️ Pilih salah satu: MAGANG, PEKERJAAN, atau BEASISWA",
      );
      return;
    }
    sesi[chatId].data.jenis = teks;
    sesi[chatId].tahap = "lokasi";
    bot.sendMessage(
      chatId,
      "📍 Masukkan *lokasi*:\n\nKetik `-` jika tidak ada.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "lokasi") {
    sesi[chatId].data.lokasi = teks === "-" ? "" : teks;
    sesi[chatId].tahap = "pin";
    bot.sendMessage(
      chatId,
      "🗺️ Kirim *pin lokasi*:\n📎 Lampiran → Location, geser pin ke tempatnya, lalu kirim.\n\nBisa juga ketik koordinat, contoh: `-5.1477, 119.4327`\n\nKetik `-` jika tidak ada pin.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "-" }], [{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "pin") {
    if (teks === "-") {
      sesi[chatId].data.latitude = null;
      sesi[chatId].data.longitude = null;
      tanyaDeskripsi(chatId);
      return;
    }

    const koordinat = parseKoordinat(teks);
    if (!koordinat) {
      bot.sendMessage(
        chatId,
        "⚠️ Format koordinat tidak dikenali.\nContoh: `-5.1477, 119.4327` (lintang dulu, lalu bujur)\n\nAtau kirim pin lewat 📎 → Location, atau ketik `-` untuk lewati.",
        { parse_mode: "Markdown" },
      );
      return; // tetap di tahap pin, admin mencoba lagi
    }

    sesi[chatId].data.latitude = koordinat.latitude;
    sesi[chatId].data.longitude = koordinat.longitude;
    tanyaDeskripsi(chatId);
    return;
  }

  if (tahap === "deskripsi") {
    sesi[chatId].data.deskripsi = teks === "-" ? "" : teks;
    sesi[chatId].tahap = "targetJurusan";
    sesi[chatId].data.targetJurusan = [];
    bot.sendMessage(
      chatId,
      "🎓 Pilih *target jurusan* dengan tombol di bawah.\nBisa lebih dari satu: tekan satu per satu, lalu tekan *✅ Selesai*.\n\nTekan *Semua jurusan* kalau rekomendasi ini untuk semua jurusan.",
      { parse_mode: "Markdown", reply_markup: keyboardTargetJurusan() },
    );
    return;
  }

  if (tahap === "targetJurusan") {
    // "-" tetap diterima sebagai "semua jurusan" (cara lama)
    if (teks === TOMBOL_SEMUA_JURUSAN || teks === "-") {
      sesi[chatId].data.targetJurusan = [];
      tanyaTargetAngkatan(chatId);
      return;
    }

    if (teks === TOMBOL_SELESAI_JURUSAN) {
      if (sesi[chatId].data.targetJurusan.length === 0) {
        bot.sendMessage(
          chatId,
          "⚠️ Belum ada jurusan yang dipilih. Pilih minimal satu, atau tekan *Semua jurusan*.",
          { parse_mode: "Markdown", reply_markup: keyboardTargetJurusan() },
        );
        return;
      }
      tanyaTargetAngkatan(chatId);
      return;
    }

    // Tombol jurusan, atau ketikan manual seperti "rpl, tkj" -> dibakukan dulu
    const masukan = teks
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tidakDikenali = masukan.filter((j) => !bakukanJurusan(j));
    if (masukan.length === 0 || tidakDikenali.length > 0) {
      bot.sendMessage(
        chatId,
        `⚠️ Jurusan tidak dikenali: ${amankanMarkdown(tidakDikenali.join(", ") || teks)}\nPilih lewat tombol di bawah.`,
        { parse_mode: "Markdown", reply_markup: keyboardTargetJurusan() },
      );
      return; // tetap di tahap ini
    }

    const dipilih = sesi[chatId].data.targetJurusan;
    masukan
      .map((j) => bakukanJurusan(j))
      .forEach((j) => {
        if (!dipilih.includes(j)) dipilih.push(j);
      });

    bot.sendMessage(
      chatId,
      `Dipilih: *${dipilih.join(", ")}*\n\nTekan jurusan lain untuk menambah, atau *✅ Selesai* untuk lanjut.`,
      { parse_mode: "Markdown", reply_markup: keyboardTargetJurusan() },
    );
    return;
  }

  if (tahap === "targetAngkatan") {
    if (teks === "-") {
      sesi[chatId].data.targetAngkatan = [];
    } else {
      const daftar = teks
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tidakValid = daftar.filter((a) => !angkatanValid(a));
      if (daftar.length === 0 || tidakValid.length > 0) {
        bot.sendMessage(
          chatId,
          `⚠️ Angkatan harus tahun lulus 4 digit, dari ${ANGKATAN_TERTUA} sampai tahun ini, contoh \`2024\`.\nTidak valid: ${amankanMarkdown(tidakValid.join(", ") || teks)}\n\nCoba lagi, atau ketik \`-\` untuk semua angkatan.`,
          { parse_mode: "Markdown" },
        );
        return; // tetap di tahap ini, admin mengetik ulang
      }
      sesi[chatId].data.targetAngkatan = [...new Set(daftar)].sort();
    }
    sesi[chatId].tahap = "targetKeahlian";
    bot.sendMessage(
      chatId,
      "💡 Masukkan *target keahlian* (pisah dengan koma):\nContoh: `JavaScript, React`\n\nKetik `-` jika tidak ada.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "targetKeahlian") {
    sesi[chatId].data.targetKeahlian =
      teks === "-"
        ? []
        : teks
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    sesi[chatId].tahap = "link";
    bot.sendMessage(
      chatId,
      "🔗 Masukkan *link pendaftaran / info lengkap*:\nContoh: `https://google.com`\n\nKetik `-` jika tidak ada.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "link") {
    sesi[chatId].data.link = teks === "-" ? "" : teks;
    sesi[chatId].tahap = "foto";
    bot.sendMessage(
      chatId,
      "🖼️ Kirim *foto* untuk rekomendasi ini:\n\nKetik `-` jika tidak ada foto.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "-" }], [{ text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "foto") {
    if (teks === "-") {
      sesi[chatId].data.imageUrl = "";
      await lanjutKeKonfirmasi(chatId);
    } else {
      bot.sendMessage(
        chatId,
        "⚠️ Kirim foto langsung (bukan teks), atau ketik `-` untuk skip.",
      );
    }
    return;
  }

  // ─── KONFIRMASI SIMPAN ────────────────────────────────────
  if (tahap === "konfirmasi") {
    if (teks === "✅ Ya, Simpan") {
      await simpanRekomendasi(chatId);
    } else {
      resetSesi(chatId);
      bot.sendMessage(chatId, "❌ Dibatalkan.");
      tampilkanMenu(chatId);
    }
    return;
  }

  // ─── ALUR HAPUS ──────────────────────────────────────────
  if (tahap === "pilih_hapus") {
    const nomorDipilih = parseInt(teks);
    const daftar = sesi[chatId].data.daftarHapus;
    if (
      isNaN(nomorDipilih) ||
      nomorDipilih < 1 ||
      nomorDipilih > daftar.length
    ) {
      bot.sendMessage(chatId, "⚠️ Nomor tidak valid. Coba lagi.");
      return;
    }

    const dipilih = daftar[nomorDipilih - 1];
    sesi[chatId].data.hapusDipilih = dipilih;
    sesi[chatId].tahap = "konfirmasi_hapus";
    bot.sendMessage(
      chatId,
      `🗑️ Yakin ingin menghapus:\n*"${dipilih.judul}"* - ${dipilih.instansi}?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "✅ Ya, Hapus" }, { text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "konfirmasi_hapus") {
    if (teks === "✅ Ya, Hapus") {
      await hapusRekomendasi(chatId);
    } else {
      resetSesi(chatId);
      bot.sendMessage(chatId, "❌ Dibatalkan.");
      tampilkanMenu(chatId);
    }
    return;
  }

  // ─── ALUR RESET PASSWORD SISWA ───────────────────────────
  if (tahap === "pilih_reset_password") {
    const nomorDipilih = parseInt(teks);
    const daftar = sesi[chatId].data.daftarSiswaReset;
    if (
      isNaN(nomorDipilih) ||
      nomorDipilih < 1 ||
      nomorDipilih > daftar.length
    ) {
      bot.sendMessage(chatId, "⚠️ Nomor tidak valid. Coba lagi.");
      return;
    }

    const dipilih = daftar[nomorDipilih - 1];
    sesi[chatId].data.siswaDipilihReset = dipilih;
    sesi[chatId].tahap = "konfirmasi_reset_password";
    bot.sendMessage(
      chatId,
      `🔑 Yakin ingin reset password:\n*${dipilih.nama}* (${dipilih.email})?\n\nPassword akan diubah menjadi: \`${DEFAULT_PASSWORD}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "✅ Ya, Reset" }, { text: "❌ Batal" }]],
          resize_keyboard: true,
        },
      },
    );
    return;
  }

  if (tahap === "konfirmasi_reset_password") {
    if (teks === "✅ Ya, Reset") {
      await konfirmasiResetPassword(chatId);
    } else {
      resetSesi(chatId);
      bot.sendMessage(chatId, "❌ Dibatalkan.");
      tampilkanMenu(chatId);
    }
    return;
  }

  // ─── ALUR EKSPOR HASIL KUESIONER ─────────────────────────
  if (tahap === "pilih_ekspor") {
    const nomorDipilih = parseInt(teks);
    const daftar = sesi[chatId].data.daftarEkspor;
    if (
      isNaN(nomorDipilih) ||
      nomorDipilih < 1 ||
      nomorDipilih > daftar.length
    ) {
      bot.sendMessage(chatId, "⚠️ Nomor tidak valid. Coba lagi.");
      return;
    }

    await kirimFileEkspor(chatId, daftar[nomorDipilih - 1]);
    return;
  }

  tampilkanMenu(chatId);
});

// ─── TAMPILKAN KONFIRMASI ─────────────────────────────────────
async function lanjutKeKonfirmasi(chatId) {
  const d = sesi[chatId].data;
  // Teks bebas dari admin (judul, instansi, lokasi, deskripsi, keahlian, link)
  // di-escape supaya karakter seperti _ atau * tidak merusak format Markdown.
  // Jenis, target jurusan, dan target angkatan berasal dari pilihan tetap.
  const ringkasan = `
✅ *Konfirmasi Data Rekomendasi*

📝 *Judul:* ${amankanMarkdown(d.judul)}
🏢 *Instansi:* ${amankanMarkdown(d.instansi)}
📌 *Jenis:* ${d.jenis}
📍 *Lokasi:* ${amankanMarkdown(d.lokasi) || "-"}
🗺️ *Pin Peta:* ${d.latitude != null ? `${d.latitude}, ${d.longitude}` : "Tidak ada"}
📄 *Deskripsi:* ${amankanMarkdown(d.deskripsi) || "-"}
🎓 *Target Jurusan:* ${d.targetJurusan && d.targetJurusan.length > 0 ? d.targetJurusan.join(", ") : "Semua"}
📅 *Target Angkatan:* ${d.targetAngkatan && d.targetAngkatan.length > 0 ? d.targetAngkatan.join(", ") : "Semua"}
💡 *Target Keahlian:* ${d.targetKeahlian.length > 0 ? amankanMarkdown(d.targetKeahlian.join(", ")) : "-"}
🔗 *Link:* ${amankanMarkdown(d.link) || "-"}
🖼️ *Foto:* ${d.imageUrl ? "Ada ✅" : "Tidak ada"}

Simpan rekomendasi ini?`;

  sesi[chatId].tahap = "konfirmasi";
  bot.sendMessage(chatId, ringkasan, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [[{ text: "✅ Ya, Simpan" }, { text: "❌ Batal" }]],
      resize_keyboard: true,
    },
  });
}

// ─── SIMPAN KE FIRESTORE + KIRIM NOTIFIKASI ──────────────────
async function simpanRekomendasi(chatId) {
  try {
    bot.sendMessage(chatId, "⏳ Menyimpan rekomendasi...");
    const d = sesi[chatId].data;
    const id = uuidv4().replace(/-/g, "").substring(0, 20);

    await db
      .collection("rekomendasi")
      .doc(id)
      .set({
        id,
        judul: d.judul,
        instansi: d.instansi,
        jenis: d.jenis,
        lokasi: d.lokasi || "",
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        deskripsi: d.deskripsi || "",
        imageUrl: d.imageUrl || "",
        link: d.link || "",
        targetJurusan: d.targetJurusan || [],
        targetAngkatan: d.targetAngkatan || [],
        targetKeahlian: d.targetKeahlian || [],
        targetMinat: [],
        deadline: null,
        createdBy: ADMIN_UID,
        createdAt: Date.now(),
      });

    await kirimNotifikasiRekomendasi(d.judul, d.instansi, id, d.targetAngkatan || []);
    resetSesi(chatId);
    bot.sendMessage(
      chatId,
      `✅ *Rekomendasi berhasil disimpan!*\n\n"${amankanMarkdown(d.judul)}" dari ${amankanMarkdown(d.instansi)} sudah muncul di aplikasi siswa dan notifikasi telah dikirim. 🔔`,
      { parse_mode: "Markdown" },
    );
    tampilkanMenu(chatId);
  } catch (error) {
    console.error("Error simpan:", error);
    bot.sendMessage(chatId, "❌ Gagal menyimpan. Coba lagi nanti.");
    tampilkanMenu(chatId);
  }
}

// ─── LIHAT REKOMENDASI ────────────────────────────────────────
async function tampilkanDaftarRekomendasi(chatId) {
  try {
    bot.sendMessage(chatId, "⏳ Mengambil data...");
    const snapshot = await db
      .collection("rekomendasi")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    if (snapshot.empty) {
      bot.sendMessage(chatId, "📭 Belum ada rekomendasi.");
      tampilkanMenu(chatId);
      return;
    }

    let pesan = "📋 *Daftar Rekomendasi (10 terbaru):*\n\n";
    snapshot.docs.forEach((doc, index) => {
      const r = doc.data();
      pesan += `${index + 1}. *${r.judul}*\n   🏢 ${r.instansi} | 📌 ${r.jenis} ${r.imageUrl ? "🖼️" : ""}\n\n`;
    });

    bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
    tampilkanMenu(chatId);
  } catch (error) {
    console.error("Error lihat:", error);
    bot.sendMessage(chatId, "❌ Gagal mengambil data.");
    tampilkanMenu(chatId);
  }
}

// ─── HAPUS REKOMENDASI ────────────────────────────────────────
async function mulaiHapusRekomendasi(chatId) {
  try {
    bot.sendMessage(chatId, "⏳ Mengambil data...");
    const snapshot = await db
      .collection("rekomendasi")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    if (snapshot.empty) {
      bot.sendMessage(chatId, "📭 Belum ada rekomendasi.");
      tampilkanMenu(chatId);
      return;
    }

    const daftar = [];
    let pesan = "🗑️ *Pilih nomor yang ingin dihapus:*\n\n";

    snapshot.forEach((doc) => {
      const r = doc.data();
      daftar.push({ id: doc.id, judul: r.judul, instansi: r.instansi });
      pesan += `${daftar.length}. *${r.judul}*\n   🏢 ${r.instansi}\n\n`;
    });

    pesan += "Ketik nomor urut rekomendasi:";
    sesi[chatId] = { tahap: "pilih_hapus", data: { daftarHapus: daftar } };

    bot.sendMessage(chatId, pesan, {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    });
  } catch (error) {
    console.error("Error hapus:", error);
    bot.sendMessage(chatId, "❌ Gagal mengambil data.");
    tampilkanMenu(chatId);
  }
}

async function hapusRekomendasi(chatId) {
  try {
    const { id, judul } = sesi[chatId].data.hapusDipilih;
    await db.collection("rekomendasi").doc(id).delete();
    resetSesi(chatId);
    bot.sendMessage(chatId, `✅ *"${judul}"* berhasil dihapus.`, {
      parse_mode: "Markdown",
    });
    tampilkanMenu(chatId);
  } catch (error) {
    console.error("Error hapus:", error);
    bot.sendMessage(chatId, "❌ Gagal menghapus.");
    tampilkanMenu(chatId);
  }
}

// ─── RESET PASSWORD SISWA ─────────────────────────────────────
async function mulaiResetPasswordSiswa(chatId) {
  try {
    bot.sendMessage(chatId, "⏳ Mengambil data siswa...");
    const snapshot = await db
      .collection("users")
      .where("role", "==", "SISWA")
      .get();

    if (snapshot.empty) {
      bot.sendMessage(chatId, "📭 Belum ada siswa terdaftar.");
      tampilkanMenu(chatId);
      return;
    }

    const daftar = [];
    let pesan = "🔑 *Pilih nomor siswa yang password-nya ingin direset:*\n\n";

    snapshot.forEach((doc) => {
      const u = doc.data();
      daftar.push({ uid: doc.id, nama: u.nama || "-", email: u.email || "-" });
      pesan += `${daftar.length}. *${u.nama || "-"}*\n   📧 ${u.email || "-"}\n\n`;
    });

    pesan += "Ketik nomor urut siswa:";
    sesi[chatId] = { tahap: "pilih_reset_password", data: { daftarSiswaReset: daftar } };

    bot.sendMessage(chatId, pesan, {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    });
  } catch (error) {
    console.error("Error ambil daftar siswa:", error);
    bot.sendMessage(chatId, "❌ Gagal mengambil data siswa.");
    tampilkanMenu(chatId);
  }
}

async function konfirmasiResetPassword(chatId) {
  try {
    const { uid, nama } = sesi[chatId].data.siswaDipilihReset;
    await resetPasswordSiswa(uid, nama);
    resetSesi(chatId);
    bot.sendMessage(
      chatId,
      `✅ Password *${nama}* berhasil direset menjadi \`${DEFAULT_PASSWORD}\`.`,
      { parse_mode: "Markdown" },
    );
    tampilkanMenu(chatId);
  } catch (error) {
    console.error("Error reset password:", error);
    bot.sendMessage(chatId, "❌ Gagal reset password. Coba lagi nanti.");
    tampilkanMenu(chatId);
  }
}

// ─── EKSPOR HASIL KUESIONER (.xlsx) ──────────────────────────
async function mulaiEksporKuesioner(chatId) {
  try {
    bot.sendMessage(chatId, "⏳ Mengambil daftar kuesioner...");
    const daftar = await daftarKuesionerUntukEkspor(10);

    if (daftar.length === 0) {
      bot.sendMessage(chatId, "📭 Belum ada kuesioner.");
      tampilkanMenu(chatId);
      return;
    }

    let pesan = "📊 *Pilih kuesioner yang ingin diekspor (10 terbaru):*\n\n";
    daftar.forEach((k, i) => {
      const keterangan = k.aktif ? "" : " (nonaktif)";
      pesan += `${i + 1}. ${amankanMarkdown(k.judul)}${keterangan}\n   👥 ${k.jumlahResponden} responden\n\n`;
    });
    pesan += "Ketik nomor urut kuesioner:";

    sesi[chatId] = { tahap: "pilih_ekspor", data: { daftarEkspor: daftar } };

    bot.sendMessage(chatId, pesan, {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    });
  } catch (error) {
    console.error("Error ambil daftar kuesioner:", error);
    bot.sendMessage(chatId, "❌ Gagal mengambil daftar kuesioner.");
    tampilkanMenu(chatId);
  }
}

/** Buat file Excel lalu kirim sebagai dokumen. Teks tanpa Markdown,
 *  supaya judul kuesioner berisi _ atau * tidak merusak pesan. */
async function kirimFileEkspor(chatId, kuesioner) {
  resetSesi(chatId); // selesai memilih; kalau gagal, admin mulai lagi dari menu
  bot.sendMessage(chatId, `⏳ Menyiapkan file Excel "${kuesioner.judul}"...`);

  try {
    const hasil = await buatFileEkspor(kuesioner.id);
    const r = hasil.ringkas;

    const keterangan = [
      `📊 ${r.judul}`,
      `Responden: ${r.jumlahResponden}`,
      `Siswa target: ${r.jumlahTarget} (sudah mengisi ${r.targetSudahMengisi}, tingkat respons ${r.tingkatRespons}%)`,
      r.adaDiLuarDaftar ? "⚠️ Ada jawaban di luar daftar pilihan, lihat sheet Ringkasan." : "",
      "🔒 File ini memuat nomor telepon siswa. Jangan dibagikan sembarangan.",
    ]
      .filter(Boolean)
      .join("\n");

    // Buffer dikirim langsung sebagai file; nama & tipe file wajib disebutkan
    await bot.sendDocument(
      chatId,
      hasil.buffer,
      { caption: keterangan },
      {
        filename: hasil.namaFile,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    console.log(`📊 Ekspor "${r.judul}" terkirim (${r.jumlahResponden} responden)`);
  } catch (error) {
    console.error("❌ Gagal ekspor kuesioner:", error);
    bot.sendMessage(chatId, `❌ Gagal membuat file ekspor: ${error.message}`);
  }

  tampilkanMenu(chatId);
}

// ─── IMPORT SISWA VIA CSV 

/** Amankan teks dinamis (nama file, nama siswa, pesan error) sebelum
 *  dimasukkan ke pesan ber-Markdown. Tanpa ini, karakter seperti _ atau *
 *  di dalam data akan dibaca Telegram sebagai perintah format dan
 *  membuat seluruh pesan ditolak (error "can't parse entities"). */
function amankanMarkdown(teks) {
  if (teks === null || teks === undefined) return "";
  return String(teks).replace(/([_*`\[\]])/g, "\\$1");
}

async function mulaiImportSiswa(chatId) {
  resetSesi(chatId);
  sesi[chatId].tahap = "upload_csv";

  bot.sendMessage(
    chatId,
    `📥 *Import Siswa dari CSV*

Kirim file CSV sebagai *dokumen* (lampiran 📎).

Format kolom (baris pertama wajib header):
\`nisn,nama,jurusan,angkatan,noTelepon\`

Contoh isi:
\`\`\`
nisn,nama,jurusan,angkatan,noTelepon
0051234567,Ahmad Fauzi,RPL,2023,081234567890
\`\`\`

Catatan:
- NISN wajib 10 digit angka
- Password semua akun: \`${DEFAULT_PASSWORD}\`
- Email dibuat otomatis dari NISN`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "❌ Batal" }]],
        resize_keyboard: true,
      },
    },
  );
}

/** Unduh isi file dari Telegram sebagai teks. Return null kalau gagal. */
async function unduhIsiFileTelegram(fileId) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    return Buffer.from(response.data).toString("utf8");
  } catch (error) {
    console.error("❌ Gagal unduh file CSV dari Telegram:", error);
    return null;
  }
}

async function tampilkanPreviewImport(chatId, rows, fileName) {
  const rowsValid = rows.filter((r) => r.status !== "ERROR");
  const rowsError = rows.filter((r) => r.status === "ERROR");

    let pesan = `📋 *Preview Import*\n📄 File: ${amankanMarkdown(fileName)}\n\n`;
  pesan += `Total baris: ${rows.length}\n`;
  pesan += `✅ Siap diimport: ${rowsValid.length}\n`;
  pesan += `❌ Ditolak: ${rowsError.length}\n`;

  if (rowsValid.length > 0) {
    pesan += `\n*Akan diimport:*\n`;
    // Batasi 15 baris di pesan — Telegram punya batas 4096 karakter per pesan,
    // dan 200 baris akan melebihi itu.
    rowsValid.slice(0, 15).forEach((r) => {
      const tandaWarning = r.status === "WARNING" ? " ⚠️" : "";
      pesan += `• ${amankanMarkdown(r.nama)} (${amankanMarkdown(r.nisn)})${tandaWarning}\n`;
    });

    if (rowsValid.length > 15) {
      pesan += `_...dan ${rowsValid.length - 15} lainnya_\n`;
    }
  }

  if (rowsError.length > 0) {
    pesan += `\n*Ditolak:*\n`;
      rowsError.slice(0, 10).forEach((r) => {
      pesan += `• Baris ${r.rowNumber}: ${amankanMarkdown(r.message)}\n`;
    });
    if (rowsError.length > 10) {
      pesan += `_...dan ${rowsError.length - 10} lainnya_\n`;
    }
  }

  if (rowsValid.length === 0) {
    resetSesi(chatId);
    bot.sendMessage(chatId, pesan + `\n❌ Tidak ada baris yang bisa diimport.`, {
      parse_mode: "Markdown",
    });
    tampilkanMenu(chatId);
    return;
  }

  sesi[chatId] = {
    tahap: "konfirmasi_import",
    data: { rowsSiapImport: rowsValid },
  };

  bot.sendMessage(chatId, pesan + `\nLanjutkan import?`, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [[{ text: "✅ Ya, Import" }, { text: "❌ Batal" }]],
      resize_keyboard: true,
    },
  });
}

async function jalankanImportSiswa(chatId) {
  const rows = sesi[chatId].data.rowsSiapImport;

  bot.sendMessage(
    chatId,
    `⏳ Membuat ${rows.length} akun siswa...\n\nProses dibuat satu per satu, mohon tunggu.`,
  );

  try {
    const hasil = await bulkImportSiswa(rows);
    resetSesi(chatId);

    let pesan = `✅ *Import Selesai*\n\n`;
    pesan += `Berhasil: ${hasil.berhasil.length} akun\n`;
    pesan += `Gagal: ${hasil.gagal.length} baris\n`;

    if (hasil.gagal.length > 0) {
      pesan += `\n*Yang gagal:*\n`;
      hasil.gagal.slice(0, 10).forEach((g) => {
      pesan += `• ${amankanMarkdown(g.nama)} (${amankanMarkdown(g.nisn)}): ${amankanMarkdown(g.alasan)}\n`;
      });
      if (hasil.gagal.length > 10) {
        pesan += `_...dan ${hasil.gagal.length - 10} lainnya_\n`;
      }
    }

    if (hasil.berhasil.length > 0) {
      pesan += `\nPassword semua akun baru: \`${DEFAULT_PASSWORD}\``;
    }

    bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
    tampilkanMenu(chatId);
  } catch (error) {
    console.error("❌ Gagal bulk import via bot:", error);
    resetSesi(chatId);
    bot.sendMessage(chatId, `❌ Gagal import: ${error.message}`);
    tampilkanMenu(chatId);
  }
}

// ─── PANTAU COLLECTION NOTIFIKASI DARI ANDROID ───────────────
db.collection("notifikasi")
  .where("sudahDikirim", "==", false)
  .onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        const data = change.doc.data();

        try {
          if (data.tipe === "KUESIONER_BARU") {
            await kirimNotifikasiTertarget({
              tipe: data.tipe,
              judul: "📝 Kuesioner Baru!",
              pesan: `Admin menambahkan kuesioner baru: "${data.judul}". Isi sekarang!`,
              refId: "",
              // Field ini dikirim Android mulai Fase B.
              // Selama belum ada, otomatis dianggap "semua siswa".
              targetAngkatan: data.targetAngkatan || "",
              targetJurusan: data.targetJurusan || [],
            });
          } else if (data.tipe === "REKOMENDASI_BARU") {
            // Dikirim Android saat admin menambah rekomendasi dari aplikasi
            await kirimNotifikasiRekomendasi(
              data.judul || "Rekomendasi baru",
              data.instansi || "admin",
              data.refId || "",
              data.targetAngkatan || [],
            );
          }

          await db
            .collection("notifikasi")
            .doc(change.doc.id)
            .update({ sudahDikirim: true });
        } catch (error) {
          console.error(`❌ Gagal memproses permintaan notifikasi (${data.tipe}):`, error);
        }
      }
    }
  });

console.log("🤖 Bot Tracer Study berjalan...");

startServer();