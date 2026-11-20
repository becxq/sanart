// POST /api/lead {name, phone, ig} — человек ввёл имя и телефон, но ушёл, не записавшись.
// Страница шлёт это один раз (sendBeacon). Сервер ничего не хранит, только пишет админу в WhatsApp.
const booking = require("../lib/booking");
const notify = require("../lib/notify");
const http = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return http.json(res, 405, { error: "method" });
  try {
    const lead = booking.parseLead(await http.readBody(req));
    if (lead.spam) return http.json(res, 200, { ok: true });
    if (lead.error) return http.json(res, 400, { error: lead.error });
    await notify.notifyAdmins(notify.texts.lead(lead));
    http.json(res, 200, { ok: true });
  } catch (e) { http.fail(res, e); }
};
