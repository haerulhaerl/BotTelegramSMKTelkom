require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
  ADMIN_UID: process.env.ADMIN_UID,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ADMIN_API_KEY: process.env.ADMIN_API_KEY,
};