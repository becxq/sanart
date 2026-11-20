// POST /api/book {date, time, classId, name, phone, ig, website} — запись на пробный урок.
// Ответ: {ok, date, time, title} или {error: bad|late|taken|used|already|config|crm|crm-auth|server}.
const booking = require("../lib/booking");
const notify = require("../lib/notify");
const http = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return http.json(res, 405, { error: "method" });
  try {
    const r = await booking.book(await http.readBody(req));
    if (r.spam) return http.json(res, 200, { ok: true });
    if (r.error) return http.json(res, r.code, { error: r.error, ...(r.field ? { field: r.field } : {}) });
    const b = r.booking;
    await Promise.all([
      notify.safeSend(b.phone, notify.texts.bookedClient(b, http.baseUrl(req))),
      notify.notifyAdmins(notify.texts.bookedAdmin(b)),
    ]);
    http.json(res, 200, { ok: true, date: b.date, time: b.time, title: b.title });
  } catch (e) { http.fail(res, e); }
};
