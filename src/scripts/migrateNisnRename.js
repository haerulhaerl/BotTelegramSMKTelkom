require("dotenv").config(); // supaya .env terbaca saat skrip ini dijalankan berdiri sendiri

const { db, admin } = require("../firebase");

const DRY_RUN = process.env.DRY_RUN === "true";
const NISN_REGEX = /^\d{10}$/;

async function migrate() {
  console.log(DRY_RUN ? "=== DRY RUN ===\n" : "=== MODE ASLI ===\n");

  const snapshot = await db.collection("siswaProfile").get();

  let renameOk = 0, renameSkip = 0, renameGagal = 0;
  let lookupOk = 0, lookupSkip = 0, lookupGagal = 0;
  const catatan = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = doc.id;

    // --- TAHAP 1: rename field nis -> nisn ---
    let nisn = data.nisn;
    if (nisn) {
      renameSkip++; // sudah pernah di-rename sebelumnya (idempotent)
    } else if (data.nis) {
      nisn = data.nis;
      if (!NISN_REGEX.test(nisn)) {
        catatan.push(`⚠ UID ${uid}: NISN "${nisn}" bukan 10 digit, tetap diproses — cek manual.`);
      }
      if (DRY_RUN) {
        console.log(`[DRY RUN] Rename UID ${uid}: nis="${nisn}" -> nisn`);
      } else {
        await db.collection("siswaProfile").doc(uid).update({
          nisn: nisn,
          nis: admin.firestore.FieldValue.delete(),
        });
        console.log(`✓ Rename UID ${uid}: nis -> nisn (${nisn})`);
      }
      renameOk++;
    } else {
      renameGagal++;
      catatan.push(`✗ UID ${uid}: tidak ada field 'nis' maupun 'nisn' sama sekali, dilewati.`);
      continue; // tidak bisa lanjut tahap 2 tanpa nisn
    }

    // --- TAHAP 2: bikin entry nisnLookup ---
    try {
      const existingLookup = await db.collection("nisnLookup").doc(nisn).get();
      if (existingLookup.exists) {
        lookupSkip++;
        continue;
      }

      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        lookupGagal++;
        catatan.push(`✗ UID ${uid} (NISN ${nisn}): dokumen 'users' tidak ditemukan.`);
        continue;
      }

      const email = userDoc.data().email;
      if (!email) {
        lookupGagal++;
        catatan.push(`✗ UID ${uid} (NISN ${nisn}): field 'email' kosong di users.`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY RUN] Akan membuat nisnLookup/${nisn} -> ${email}`);
      } else {
        await db.collection("nisnLookup").doc(nisn).set({ email, uid });
        console.log(`✓ nisnLookup ${nisn} -> ${email}`);
      }
      lookupOk++;
    } catch (err) {
      lookupGagal++;
      catatan.push(`✗ UID ${uid} (NISN ${nisn}): ${err.message}`);
    }
  }

  console.log("\n=== Ringkasan ===");
  console.log(`Total siswaProfile diperiksa      : ${snapshot.size}`);
  console.log(`Rename nis→nisn : berhasil=${renameOk} dilewati=${renameSkip} gagal=${renameGagal}`);
  console.log(`nisnLookup      : dibuat=${lookupOk} dilewati=${lookupSkip} gagal=${lookupGagal}`);

  if (catatan.length > 0) {
    console.log("\nDetail perlu dicek manual:");
    catatan.forEach((l) => console.log(" " + l));
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migrasi gagal total:", err);
  process.exit(1);
});