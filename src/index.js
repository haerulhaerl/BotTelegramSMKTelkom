require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const { db } = require("./firebase");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = require("firebase-admin");

// ─── KONFIGURASI ────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ADMIN_UID = process.env.ADMIN_UID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const ws = require("ws");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
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
      ],
      resize_keyboard: true,
    },
  });
}

// ─── KIRIM NOTIFIKASI FCM KE SEMUA SISWA ─────────────────────
async function kirimNotifikasiRekomendasi(judul, instansi) {
  try {
    const message = {
      notification: {
        title: "📢 Rekomendasi Baru!",
        body: `${judul} dari ${instansi} — Cek sekarang!`,
      },
      topic: "siswa",
    };
    const response = await admin.messaging().send(message);
    console.log("✅ Notifikasi FCM terkirim:", response);
  } catch (error) {
    console.error("❌ Gagal kirim notifikasi FCM:", error);
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

  if (teks === "❌ Batal") {
    resetSesi(chatId);
    bot.sendMessage(chatId, "✅ Dibatalkan.");
    tampilkanMenu(chatId);
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
    return;
  }

  if (tahap === "deskripsi") {
    sesi[chatId].data.deskripsi = teks === "-" ? "" : teks;
    sesi[chatId].tahap = "targetJurusan";
    bot.sendMessage(
      chatId,
      "🎓 Masukkan *target jurusan* (pisah dengan koma):\nContoh: `RPL, TKJ, PERHOTELAN`\n\nKetik `-` untuk semua jurusan.",
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

  if (tahap === "targetJurusan") {
    sesi[chatId].data.targetJurusan =
      teks === "-"
        ? []
        : teks
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
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

  tampilkanMenu(chatId);
});

// ─── TAMPILKAN KONFIRMASI ─────────────────────────────────────
async function lanjutKeKonfirmasi(chatId) {
  const d = sesi[chatId].data;
  const ringkasan = `
✅ *Konfirmasi Data Rekomendasi*

📝 *Judul:* ${d.judul}
🏢 *Instansi:* ${d.instansi}
📌 *Jenis:* ${d.jenis}
📍 *Lokasi:* ${d.lokasi || "-"}
📄 *Deskripsi:* ${d.deskripsi || "-"}
🎓 *Target Jurusan:* ${d.targetJurusan.length > 0 ? d.targetJurusan.join(", ") : "Semua"}
💡 *Target Keahlian:* ${d.targetKeahlian.length > 0 ? d.targetKeahlian.join(", ") : "-"}
🔗 *Link:* ${d.link || "-"}
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
        deskripsi: d.deskripsi || "",
        imageUrl: d.imageUrl || "",
        link: d.link || "",
        targetJurusan: d.targetJurusan || [],
        targetKeahlian: d.targetKeahlian || [],
        targetMinat: [],
        deadline: null,
        createdBy: ADMIN_UID,
        createdAt: Date.now(),
      });

    // ─── KIRIM NOTIFIKASI FCM ─────────────────────────────
    await kirimNotifikasiRekomendasi(d.judul, d.instansi);

    resetSesi(chatId);
    bot.sendMessage(
      chatId,
      `✅ *Rekomendasi berhasil disimpan!*\n\n"${d.judul}" dari ${d.instansi} sudah muncul di aplikasi siswa dan notifikasi telah dikirim. 🔔`,
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

// ─── PANTAU COLLECTION NOTIFIKASI DARI ANDROID ───────────────
db.collection("notifikasi")
  .where("sudahDikirim", "==", false)
  .onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        const data = change.doc.data();

        try {
          let title = "";
          let body = "";

          if (data.tipe === "KUESIONER_BARU") {
            title = "📝 Kuesioner Baru!";
            body = `Admin menambahkan kuesioner baru: "${data.judul}". Isi sekarang!`;
          }

          if (title) {
            await admin.messaging().send({
              notification: { title, body },
              topic: "siswa",
            });
            console.log(`✅ Notifikasi kuesioner terkirim: ${data.judul}`);
          }

          // Tandai sudah dikirim
          await db
            .collection("notifikasi")
            .doc(change.doc.id)
            .update({ sudahDikirim: true });
        } catch (error) {
          console.error("❌ Gagal kirim notifikasi kuesioner:", error);
        }
      }
    }
  });

console.log("🤖 Bot Tracer Study berjalan...");
