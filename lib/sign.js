// Ссылки отмены без хранилища: /cancel?t=<recordId>.<подпись>.
// Подпись — HMAC-SHA256 от "cancel:<recordId>" на SIGNING_SECRET (base64url, 22 символа).
// Формат совпадает со старой версией сайта, поэтому уже отправленные ссылки продолжают работать.
// Если сменить SIGNING_SECRET, все старые ссылки перестанут открываться.
const crypto = require("crypto");
const config = require("./config");

function secret() {
  const s = config.get().signingSecret;
  if (!s) throw new config.ConfigError("SIGNING_SECRET не задана", { missing: ["SIGNING_SECRET"] });
  return s;
}
const sig = id => crypto.createHmac("sha256", secret()).update("cancel:" + id).digest("base64url").slice(0, 22);

const cancelToken = recordId => `${recordId}.${sig(recordId)}`;

// токен → recordId, или 0, если токен испорчен или подделан
function recordIdFromToken(t) {
  const m = String(t || "").match(/^(\d{1,15})\.([A-Za-z0-9_-]{22})$/);
  if (!m) return 0;
  const a = Buffer.from(sig(m[1])), b = Buffer.from(m[2]);
  return crypto.timingSafeEqual(a, b) ? Number(m[1]) : 0;
}

module.exports = { cancelToken, recordIdFromToken };
