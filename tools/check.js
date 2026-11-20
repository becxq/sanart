// Диагностика: что есть в МойКласс по номеру телефона.
// Запуск из папки проекта:  node tools/check.js +77011234567   (MOYKLASS_API_KEY берётся из .env)
const mk = require("../lib/moyklass");
const time = require("../lib/time");

(async () => {
  const phone = String(process.argv[2] || "").replace(/[^\d+]/g, "");
  if (!/^\+7\d{10}$/.test(phone)) { console.log("Использование: node tools/check.js +77011234567"); process.exit(1); }
  const digits = phone.slice(1);

  const users = mk.asList(await mk.request("GET", "/users", { query: { phone: digits, limit: 20 } }), "users")
    .filter(u => String(u.phone || "").replace(/\D/g, "") === digits);
  if (!users.length) { console.log(`Ученик с номером ${phone} в МойКласс не найден.`); return; }

  const [classes, rooms, statuses] = await Promise.all([
    mk.classes().then(l => new Map(l.map(x => [x.id, x.name]))),
    mk.rooms().then(l => new Map(l.map(x => [x.id, x.name]))).catch(() => new Map()),
    mk.joinStatuses().then(l => new Map(l.map(x => [x.id, x.name]))).catch(() => new Map()),
  ]);
  const cls = id => `${classes.get(id) || "?"} (группа ${id})`;

  for (const u of users) {
    console.log(`\n=== Ученик ${u.id}: ${u.name}, ${phone}, создан ${u.createdAt || "?"}`);

    const joins = mk.asList(await mk.request("GET", "/joins", { query: { userId: u.id } }), "joins");
    console.log("\nЗаписи в группы:");
    for (const j of joins) console.log(`  • ${cls(j.classId)} — статус ${j.statusId} «${statuses.get(j.statusId) || "?"}», создана ${j.createdAt || "?"}`);
    if (!joins.length) console.log("  (нет)");

    const recs = mk.asList(await mk.request("GET", "/lessonRecords", { query: { userId: [u.id], limit: 50 } }), "lessonRecords");
    const lessons = recs.length ? new Map((await mk.lessons({ lessonId: recs.map(r => r.lessonId) }, { includeRecords: true })).map(l => [l.id, l])) : new Map();
    console.log("\nЗаписи на занятия:");
    for (const r of recs) {
      const l = lessons.get(r.lessonId);
      const when = l ? `${time.ruDate(l.date)} ${time.fromMin(time.toMin(l.beginTime))}–${time.fromMin(time.toMin(l.endTime))}, ${cls(l.classId)}, `
        + `кабинет ${l.roomId ? `${rooms.get(l.roomId) || "?"} (${l.roomId})` : "не указан"}, учеников: ${(l.records || []).length}, `
        + `преподаватели: ${(l.teacherIds || []).join(",") || "нет"}` : "занятие не найдено";
      console.log(`  • запись ${r.id}, занятие ${r.lessonId}: ${when}; test: ${!!r.test}, skip: ${!!r.skip}`);
    }
    if (!recs.length) console.log("  (нет)");

    const tasks = await mk.request("GET", "/tasks", { query: { userId: u.id, limit: 20 } }).catch(e => ({ error: e.message }));
    console.log("\nЗадачи:");
    if (tasks.error) console.log("  не удалось получить: " + tasks.error);
    else {
      const list = mk.asList(tasks, "tasks");
      for (const t of list) console.log("  • " + JSON.stringify(t).slice(0, 300));
      if (!list.length) console.log("  (нет)");
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
