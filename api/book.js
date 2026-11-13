// POST /api/book {name, phone, lessonId, ig} — books a trial lesson in МойКласс.
const c = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") return c.json(res, 405, { error: "method" });
  try {
    c.checkConfig();
    const body = await c.readBody(req);
    if (body.website) return c.json(res, 200, { ok: true }); // honeypot
    const name = String(body.name || "").trim().slice(0, 100), phone = body.phone;
    const lessonId = parseInt(body.lessonId, 10), ig = String(body.ig || "").slice(0, 100);
    if (!name || !c.validPhone(phone) || !lessonId) return c.json(res, 400, { error: "bad data" });

    const r = await c.book({ name, phone, lessonId, ig });
    if (r.code !== 200) return c.json(res, r.code, { error: r.error });

    const b = r.booking;
    await Promise.all([
      c.safe(c.sendWhatsApp(phone, `${name}, вы записаны на пробный урок в SanArt: ${c.lessonText(b)}. Ждём вас!\n${c.cancelRule(b, req)}`)),
      c.notifyAdmins(`Новая запись на пробный урок:\n${name}, ${phone}\n${c.lessonText(b)}${ig ? "\nИз Instagram: " + ig : ""}`),
    ]);
    c.json(res, 200, { ok: true, date: b.date, time: b.time, title: b.title });
  } catch (e) {
    console.error(e.message);
    c.json(res, 502, { error: "crm" });
  }
};
