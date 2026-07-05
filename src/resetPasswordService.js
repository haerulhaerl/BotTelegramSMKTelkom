const { admin } = require("./firebase");

const DEFAULT_PASSWORD = "smktelkom123";

async function resetPasswordSiswa(uid) {
  if (!uid) {
    throw new Error("UID wajib diisi");
  }
  await admin.auth().updateUser(uid, { password: DEFAULT_PASSWORD });
  return { uid, passwordBaru: DEFAULT_PASSWORD };
}

module.exports = { resetPasswordSiswa, DEFAULT_PASSWORD };