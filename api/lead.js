// POST /api/lead {name, phone, ig} — the page sends this when a visitor typed name and phone
// but left without booking. Nothing is stored: the admin gets a WhatsApp to call back.
const c = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") return c.json(res, 405, { error: "method" });
  const body = await c.readBody(req);
  const name = String(body.name || "").trim().slice(0, 100), phone = body.phone, ig = String(body.ig || "").slice(0, 100);
  if (!name || !c.validPhone(phone)) return c.json(res, 400, { error: "bad data" });
  await c.notifyAdmins(`Не завершил запись на пробный урок (ушёл со страницы) — перезвоните:\n${name}, ${phone}${ig ? "\nInstagram: " + ig : ""}`);
  c.json(res, 200, { ok: true });
};
