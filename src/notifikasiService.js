// src/notifikasiService.js
//
// Mengirim notifikasi ke siswa yang DITARGETKAN, dengan pola
// "satu dokumen per siswa" (bukan satu dokumen broadcast bersama).
//
// Kenapa per siswa: dokumen broadcast dipakai bersama, sehingga saat satu
// siswa menghapus / menandai dibaca, efeknya menimpa SEMUA siswa.
// Dengan satu dokumen per siswa, tiap siswa mengelola notifikasinya sendiri.

const { admin, db } = require("./firebase");

const BATAS_BATCH = 500;      // batas operasi per batch Firestore
const BATAS_MULTICAST = 500;  // batas token per sendEachForMulticast

/** Ubah input jadi array string bersih.
 *  Kuesioner menyimpan targetAngkatan sebagai String, rekomendasi nanti
 *  sebagai array — fungsi ini menyeragamkan keduanya. */
function normalisasiList(nilai) {
  if (!nilai) return [];
  if (Array.isArray(nilai)) {
    return nilai.map((v) => String(v).trim()).filter(Boolean);
  }
  const s = String(nilai).trim();
  return s ? [s] : [];
}

/** Pecah array besar jadi potongan-potongan kecil. */
function potong(arr, ukuran) {
  const hasil = [];
  for (let i = 0; i < arr.length; i += ukuran) hasil.push(arr.slice(i, i + ukuran));
  return hasil;
}

/**
 * PENTING: aturan ini HARUS identik dengan penyaringan di Android
 * (IsiKuesionerViewModel & SiswaHomeViewModel). Kalau salah satu diubah,
 * yang lain wajib ikut diubah — kalau tidak, siswa bisa dapat notifikasi
 * untuk kuesioner yang tidak bisa dia lihat, atau sebaliknya.
 */
function siswaCocok(profil, targetAngkatan, targetJurusan) {
  const angkatan = String(profil.angkatan || "").trim();
  const jurusan = String(profil.jurusan || "").trim().toLowerCase();

  const cocokAngkatan =
    targetAngkatan.length === 0 ||
    angkatan === "" ||
    targetAngkatan.includes(angkatan);

  const cocokJurusan =
    targetJurusan.length === 0 ||
    targetJurusan.some((j) => j.toLowerCase() === jurusan);

  return cocokAngkatan && cocokJurusan;
}

async function kirimNotifikasiTertarget({
  tipe,
  judul,
  pesan,
  refId = "",
  targetAngkatan,
  targetJurusan,
}) {
  const angkatanList = normalisasiList(targetAngkatan);
  const jurusanList = normalisasiList(targetJurusan);

  // ─── 1. Tentukan siswa yang ditargetkan ─────────────────────
  const snapshot = await db.collection("siswaProfile").get();
  const uidTarget = snapshot.docs
    .filter((doc) => siswaCocok(doc.data(), angkatanList, jurusanList))
    .map((doc) => doc.id);

  if (uidTarget.length === 0) {
    console.log(`ℹ️ Tidak ada siswa yang cocok untuk notifikasi "${judul}"`);
    return { totalTarget: 0, pushTerkirim: 0 };
  }

  // ─── 2. Satu dokumen notifikasi per siswa ───────────────────
  const createdAt = Date.now();
  for (const kelompok of potong(uidTarget, BATAS_BATCH)) {
    const batch = db.batch();
    kelompok.forEach((uid) => {
      const ref = db.collection("notifikasi_siswa").doc();
      batch.set(ref, {
        tipe,
        judul,
        pesan,
        refId,
        targetUid: uid,
        createdAt,
        sudahDibaca: false,
      });
    });
    await batch.commit();
  }

  // ─── 3. Push notification ke HP masing-masing ───────────────
  const pushTerkirim = await kirimPushKeSiswa(uidTarget, judul, pesan, tipe);

  console.log(
    `✅ Notifikasi "${judul}": ${uidTarget.length} siswa ditargetkan, ${pushTerkirim} push terkirim`,
  );
  return { totalTarget: uidTarget.length, pushTerkirim };
}

async function kirimPushKeSiswa(uidList, judul, pesan, tipe) {
  // Ambil fcmToken tiap siswa dari collection users
  const pasangan = []; // [{ uid, token }]
  for (const kelompok of potong(uidList, 100)) {
    const refs = kelompok.map((uid) => db.collection("users").doc(uid));
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      const token = doc.exists ? doc.data().fcmToken : null;
      if (token) pasangan.push({ uid: doc.id, token });
    });
  }

  let terkirim = 0;
  for (const kelompok of potong(pasangan, BATAS_MULTICAST)) {
    const response = await admin.messaging().sendEachForMulticast({
      tokens: kelompok.map((p) => p.token),
      notification: { title: judul, body: pesan },
      data: { TIPE_NOTIFIKASI: tipe },
      android: {
        priority: "high",
        notification: { priority: "high", channelId: "tracer_study_notification" },
      },
    });
    terkirim += response.successCount;

    // Bersihkan token yang sudah tidak berlaku (aplikasi di-uninstall, dll)
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const kode = r.error && r.error.code;
      if (
        kode === "messaging/registration-token-not-registered" ||
        kode === "messaging/invalid-registration-token"
      ) {
        db.collection("users")
          .doc(kelompok[i].uid)
          .update({ fcmToken: admin.firestore.FieldValue.delete() })
          .catch(() => {});
      }
    });
  }
  return terkirim;
}

module.exports = { kirimNotifikasiTertarget };