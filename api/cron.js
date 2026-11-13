// GET /api/cron — sends trial-lesson reminders. Called by Vercel Cron once a day (see vercel.json),
// or by any external scheduler with ?key=CRON_SECRET.
//  REMINDER_MODE=daily  (default, fits Vercel Hobby): reminds about all trial lessons tomorrow.
//  REMINDER_MODE=hourly (needs an hourly trigger):    reminds lessons starting in 24–25 hours.
// No "already sent" flags are needed: each lesson falls into exactly one run's window.
const c = require("../lib/core");

module.exports = async (req, res) => {
  const key = new URL(req.url, "http://x").searchParams.get("key");
  const auth = req.headers.authorization || "";
  if (!c.cfg.cronSecret || (auth !== `Bearer ${c.cfg.cronSecret}` && key !== c.cfg.cronSecret))
    return c.json(res, 401, { error: "unauthorized" });

  try {
    c.checkConfig();
    const hourly = (process.env.REMINDER_MODE || "daily") === "hourly";
    const now = Date.now(), today = c.todayAlmaty(), tomorrow = c.addDays(today, 1);
    const dates = hourly ? [today, c.addDays(today, 2)] : [tomorrow, tomorrow];
    const lessons = await c.fetchLessons({ date: dates, classId: c.cfg.classIds, filialId: c.cfg.filialIds, statusId: 0 });
    const classes = await c.getClasses();

    const due = [];
    for (const l of lessons) {
      if (!classes.has(l.classId)) continue;
      const start = c.startMs(l.date, l.beginTime);
      if (hourly && !(start - now >= 24 * 3600e3 && start - now < 25 * 3600e3)) continue;
      if (!hourly && l.date !== tomorrow) continue;
      for (const r of l.records || []) {
        if (!r.test || r.skip) continue;
        if (r.createdAt && now - Date.parse(r.createdAt) < 12 * 3600e3) continue; // booked just now: confirmation is enough
        due.push({ r, l });
      }
    }

    // fetch the students' names and phones in one request
    const userIds = [...new Set(due.map(d => d.r.userId))];
    const users = new Map();
    if (userIds.length) {
      const found = await c.mk("GET", "/users", { query: { userIds, limit: 500 } });
      for (const u of found.users || []) users.set(u.id, u);
    }

    let sent = 0;
    for (const { r, l } of due) {
      const u = users.get(r.userId);
      if (!u || !u.phone) continue;
      const b = { recordId: r.id, date: l.date, time: c.hm(l.beginTime), title: (classes.get(l.classId) || {}).name || "", name: u.name || "" };
      const when = l.date === today ? "сегодня" : "завтра";
      try {
        await c.sendWhatsApp("+" + String(u.phone).replace(/\D/g, ""),
          `${b.name}, напоминаем: ${when} у вас пробный урок в SanArt — ${c.lessonText(b)}. Ждём вас!\n${c.cancelRule(b, req)}`);
        sent++;
      } catch (e) { console.error(e.message); }
    }
    c.json(res, 200, { ok: true, mode: hourly ? "hourly" : "daily", due: due.length, sent });
  } catch (e) {
    console.error(e.message);
    c.json(res, 502, { error: "crm" });
  }
};
