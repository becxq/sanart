// GET /api/cron — напоминания о пробных уроках.
// Vercel Cron вызывает его раз в день (vercel.json, "0 8 * * *" = 13:00 Алматы) с заголовком
// Authorization: Bearer CRON_SECRET; внешний планировщик может звать ?key=CRON_SECRET.
//  REMINDER_MODE=daily  (по умолчанию, подходит для Hobby): все пробные уроки на завтра;
//  REMINDER_MODE=hourly (нужен почасовой вызов): уроки, которые начинаются через 24–25 ч.
// Флаги «уже отправлено» не нужны: каждый урок попадает ровно в один запуск.
const booking = require("../lib/booking");
const notify = require("../lib/notify");
const config = require("../lib/config");
const http = require("../lib/http");

module.exports = async (req, res) => {
  const secret = config.get().cronSecret;
  const key = http.query(req).get("key");
  if (!secret || (req.headers.authorization !== `Bearer ${secret}` && key !== secret))
    return http.json(res, 401, { error: "unauthorized" });
  try {
    const due = await booking.dueReminders();
    let sent = 0;
    for (const d of due)
      if (await notify.safeSend(d.phone, notify.texts.reminder(d.booking, d.when, http.baseUrl(req)))) sent++;
    http.json(res, 200, { ok: true, mode: config.get().reminderMode, due: due.length, sent });
  } catch (e) { http.fail(res, e); }
};
