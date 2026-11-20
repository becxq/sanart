// Diagnostic: shows what exists in МойКласс for one phone number.
// Run from the project folder:  node tools/check.js +77011234567
const c = require("../lib/core");

(async () => {
  const phone = (process.argv[2] || "").replace(/[^\d+]/g, "");
  if (!c.validPhone(phone)) { console.log("Usage: node tools/check.js +77011234567"); process.exit(1); }
  const digits = phone.slice(1);

  const found = await c.mk("GET", "/users", { query: { phone: digits, limit: 10 } });
  const users = (found.users || []).filter(u => String(u.phone || "").replace(/\D/g, "") === digits);
  if (!users.length) { console.log("Ученик с номером " + phone + " в МойКласс не найден."); return; }

  const [classes, statuses] = await Promise.all([
    c.mk("GET", "/classes", {}).then(l => new Map(l.map(x => [x.id, x]))),
    c.mk("GET", "/joinStatuses", {}).then(l => new Map(l.map(x => [x.id, x.name]))).catch(() => new Map()),
  ]);
  const cls = id => { const x = classes.get(id); return x ? `${x.name} (группа ${id}, мест: ${x.maxStudents || "∞"})` : `группа ${id}`; };

  for (const u of users) {
    console.log(`\n=== Ученик ${u.id}: ${u.name}, +${digits}, создан ${u.createdAt || "?"}`);

    const joins = await c.mk("GET", "/joins", { query: { userId: u.id } });
    console.log("\nЗаписи в группы:");
    for (const j of joins.joins || [])
      console.log(`  • ${cls(j.classId)} — статус ${j.statusId} «${statuses.get(j.statusId) || "?"}», autoJoin: ${j.autoJoin}, создана ${j.createdAt}`);
    if (!(joins.joins || []).length) console.log("  (нет)");

    const recs = await c.mk("GET", "/lessonRecords", { query: { userId: [u.id], limit: 50 } });
    console.log("\nЗаписи на занятия:");
    for (const r of recs.lessonRecords || []) {
      const [l] = await c.fetchLessons({ lessonId: [r.lessonId] });
      const when = l ? `${l.date} ${c.hm(l.beginTime)}–${c.hm(l.endTime)}, ${cls(l.classId)}, преподаватели: ${(l.teacherIds || []).join(",") || "нет"}, учеников на занятии: ${(l.records || []).length}/${l.maxStudents || "∞"}` : "занятие не найдено";
      console.log(`  • запись ${r.id} на занятие ${r.lessonId}: ${when}; test: ${r.test}, free: ${r.free}, skip: ${r.skip}`);
    }
    if (!(recs.lessonRecords || []).length) console.log("  (нет) ← ученик не записан ни на одно занятие");

    const tasks = await c.mk("GET", "/tasks", { query: { userId: u.id, limit: 20 } }).catch(e => ({ error: e.message }));
    console.log("\nЗадачи:");
    if (tasks.error) console.log("  не удалось получить: " + tasks.error);
    for (const t of tasks.tasks || []) console.log("  • " + JSON.stringify(t).slice(0, 300));
    if (tasks.tasks && !tasks.tasks.length) console.log("  (нет)");
  }
})().catch(e => { console.error(e.message); process.exit(1); });
