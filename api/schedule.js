// GET /api/schedule — свободное время на неделю (или первую неделю со свободным временем).
// CDN Vercel держит ответ 30 с и отдаёт старую копию, пока обновляет: посетители почти не ждут МойКласс.
// ?fresh=<что угодно> — мимо кэша (страница так перезагружает расписание после «время заняли»).
const booking = require("../lib/booking");
const http = require("../lib/http");

module.exports = async (req, res) => {
  const fresh = http.query(req).has("fresh");
  try {
    http.json(res, 200, await booking.schedule(),
      { "Cache-Control": fresh ? "no-store" : "public, s-maxage=30, stale-while-revalidate=600" });
  } catch (e) { http.fail(res, e); }
};
