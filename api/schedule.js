// GET /api/schedule — free trial slots for the next BOOKING_DAYS days.
// Vercel's CDN keeps the answer 30 s and serves the old copy while refreshing,
// so visitors almost never wait for МойКласс. ?fresh=<anything> skips the cache.
const c = require("../lib/core");

module.exports = async (req, res) => {
  try {
    c.checkConfig();
    const fresh = req.url.includes("fresh=");
    const data = await c.loadSchedule();
    c.json(res, 200, data, {
      "Cache-Control": fresh ? "no-store" : "public, s-maxage=30, stale-while-revalidate=600",
    });
  } catch (e) {
    console.error(e.message);
    c.json(res, 500, { error: "server" }, { "Cache-Control": "no-store" });
  }
};
