// GET  /cancel?t=<recordId>.<подпись> (rewrite на /api/cancel) — страница с данными урока и кнопкой «Отменить».
//      GET ничего не отменяет: WhatsApp сам открывает ссылки для предпросмотра.
// POST /api/cancel {t} — отмена, если до урока не меньше BOOKING_CUTOFF_HOURS. Ошибки: late, gone.
const booking = require("../lib/booking");
const notify = require("../lib/notify");
const sign = require("../lib/sign");
const http = require("../lib/http");
const { cancelPage } = require("../lib/cancel-page");

module.exports = async (req, res) => {
  if (req.method === "POST") return post(req, res);
  const t = http.query(req).get("t") || "";
  let state = "error", info = null, cutoff = "";
  try {
    cutoff = notify.cutoffText();
    ({ state, info } = await booking.cancelState(sign.recordIdFromToken(t)));
  } catch (e) { console.error(e && e.stack || e); }
  http.html(res, state === "gone" ? 404 : 200, cancelPage({ state, info, token: t, cutoff }));
};

async function post(req, res) {
  try {
    const { t } = await http.readBody(req);
    const r = await booking.cancel(sign.recordIdFromToken(t));
    if (r.error) return http.json(res, r.code, { error: r.error });
    const b = r.info;
    await Promise.all([
      notify.safeSend(b.phone, notify.texts.cancelledClient(b)),
      notify.notifyAdmins(notify.texts.cancelledAdmin(b)),
    ]);
    http.json(res, 200, { ok: true });
  } catch (e) { http.fail(res, e); }
}
