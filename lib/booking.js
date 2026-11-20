// Расписание, запись, отмена и напоминания — бизнес-правила сайта.
//  - пробные уроки — в группах из MOYKLASS_TRIAL_GROUPS (группа = инструмент), в их кабинетах;
//  - одно пробное на номер телефона (запись с test=true); отменённое вовремя возвращает право;
//  - запись: ученик (найти по телефону или создать) → запись в группу → отдельное занятие на 45 мин
//    в первом свободном кабинете инструмента, без преподавателя;
//  - записаться и отменить можно не позже чем за BOOKING_CUTOFF_HOURS до урока.
const config = require("./config");
const mk = require("./moyklass");
const time = require("./time");
const avail = require("./availability");

const settingsOf = cfg => ({ workStart: cfg.workStart, workEnd: cfg.workEnd, trialMinutes: cfg.trialMinutes,
  slotStep: cfg.slotStep, cutoffMs: cfg.cutoffMs });
const lastDate = (cfg, now) => time.addDays(time.today(now), cfg.bookingDays * cfg.searchWeeks - 1);
const schoolLessons = (from, to) => mk.lessons({ date: [from, to], statusId: 0 }); // все непроведённые занятия школы

async function context() {
  const cfg = config.check();
  return { cfg, ...(await mk.trialSetup()) };
}

// ---- расписание для страницы ----
async function schedule(now = Date.now()) {
  const { cfg, groups } = await context();
  const today = time.today(now);
  const week = await avail.findSchedule({ lessonsFor: schoolLessons, groups, today, settings: settingsOf(cfg), now,
    days: cfg.bookingDays, weeks: cfg.searchWeeks });
  return { today, ...week, instruments: groups.map(g => ({ classId: g.classId, name: g.name })) };
}

// ---- проверка входа ----
const validPhone = p => /^\+7\d{10}$/.test(String(p || ""));
const cleanName = s => String(s || "").trim().replace(/\s+/g, " ").slice(0, 100);
const cleanIg = s => String(s || "").trim().slice(0, 100);

// → { spam } | { error, field } | { date, time, start, classId, group, name, phone, ig }
function validate(body, { cfg, groups }, now) {
  if (body.website) return { spam: true }; // honeypot: поле скрыто от людей, его заполняют только боты
  const bad = field => ({ error: "bad", field });
  const name = cleanName(body.name), phone = String(body.phone || ""), ig = cleanIg(body.ig);
  const date = String(body.date || ""), start = time.toMin(body.time), classId = Number(body.classId);
  if (!name) return bad("name");
  if (!validPhone(phone)) return bad("phone");
  const group = groups.find(g => g.classId === classId);
  if (!group) return bad("classId");
  if (!time.isDate(date) || date < time.today(now) || date > lastDate(cfg, now)) return bad("date");
  if (!/^\d{2}:\d{2}$/.test(String(body.time)) || !time.slotStarts(settingsOf(cfg)).includes(start)) return bad("time");
  if (time.startMs(date, start) - now < cfg.cutoffMs) return { error: "late" };
  return { date, time: time.fromMin(start), start, classId, group, name, phone, ig };
}

// ---- ученики ----
async function findUser(phone) {
  const digits = phone.slice(1);
  const r = await mk.request("GET", "/users", { query: { phone: digits, limit: 20 } });
  return mk.asList(r, "users").find(u => String(u.phone || "").replace(/\D/g, "") === digits) || null;
}
const trialRecords = async userId =>
  mk.asList(await mk.request("GET", "/lessonRecords", { query: { userId: [userId], test: true, limit: 20 } }), "lessonRecords");

async function ensureJoin(userId, classId, comment, source) {
  const j = await mk.request("GET", "/joins", { query: { userId, classId } });
  if (mk.asList(j, "joins").length) return;
  await mk.request("POST", "/joins", { body: { userId, classId, statusId: await mk.trialJoinStatusId(),
    autoJoin: false, comment, ...(source ? { advSourceId: source } : {}) } });
}

// другое непроведённое занятие в этом кабинете (или без кабинета), пересекающееся с [start, end)
const conflicts = (lessons, roomId, date, start, end, exceptId) => lessons.filter(l => l.id !== exceptId && l.date === date
  && (!l.roomId || l.roomId === roomId) && time.overlaps(start, end, time.toMin(l.beginTime), time.toMin(l.endTime)));

// ---- запись ----
// → { spam } | { code, error } | { code: 200, booking }
async function book(body, now = Date.now()) {
  const ctx = await context();
  const { cfg, filialId } = ctx;
  const v = validate(body, ctx, now);
  if (v.spam) return v;
  if (v.error) return { code: v.error === "bad" ? 400 : 409, error: v.error, field: v.field };
  const end = v.start + cfg.trialMinutes;

  // 1. кабинет ещё свободен? (расписание на странице могло устареть)
  const before = await schoolLessons(v.date, v.date);
  const roomId = avail.freeRoom(avail.busyIndex(before), v.group, v.date, v.start, settingsOf(cfg));
  if (!roomId) return { code: 409, error: "taken" };

  // 2. ученик и правило одного пробного
  const source = v.ig ? cfg.sourceIdIg : cfg.sourceId;
  const existing = await findUser(v.phone);
  let userId;
  if (existing) {
    userId = existing.id;
    const trials = await trialRecords(userId);
    if (trials.length) {
      const ls = await mk.lessons({ lessonId: trials.map(r => r.lessonId) });
      const same = ls.some(l => l.date === v.date && time.toMin(l.beginTime) === v.start && l.classId === v.classId);
      return { code: 409, error: same ? "already" : "used" };
    }
  } else {
    userId = (await mk.request("POST", "/users", { body: { name: v.name, phone: v.phone.slice(1),
      ...(source ? { advSourceId: source } : {}) } })).id;
  }

  // 3. запись в группу (без неё МойКласс не даст записать ученика на занятие группы)
  const comment = `Пробный урок с сайта: ${time.ruDate(v.date)} ${v.time}${v.ig ? ", Instagram " + v.ig : ""}`;
  await ensureJoin(userId, v.classId, comment, source);

  // 4. отдельное индивидуальное занятие, без преподавателя
  let lesson;
  try {
    lesson = await mk.request("POST", "/lessons", { body: {
      date: v.date, beginTime: v.time, endTime: time.fromMin(end), filialId, roomId, classId: v.classId,
      userId, maxStudents: 1, topic: "Пробный урок", comment, lessonRecord: { test: true },
    } });
  } catch (e) {
    if (e instanceof mk.MkError && e.status === 400 && /teacher|преподав/i.test(e.message)) {
      e.detail = "POST /lessons 400: МойКласс требует преподавателя для занятия — пробный урок без преподавателя создать нельзя. " + e.detail;
      console.error(e.detail);
    }
    throw e;
  }
  let rec = (lesson.records || []).find(r => r.userId === userId);
  if (!rec) rec = ((await mk.lessons({ lessonId: [lesson.id] }, { includeRecords: true }))[0]?.records || []).find(r => r.userId === userId);
  if (!rec) throw new Error(`МойКласс создал занятие ${lesson.id} без записи ученика ${userId}`);

  // 5. гонка: два человека заняли кабинет одновременно (на разных экземплярах функции) —
  //    уступает тот, чьё занятие создано позже (больший id)
  const after = await schoolLessons(v.date, v.date);
  if (conflicts(after, roomId, v.date, v.start, end, lesson.id).some(l => l.id < lesson.id)) {
    await mk.request("DELETE", `/lessons/${lesson.id}`).catch(e => console.error(e.message));
    return { code: 409, error: "taken" };
  }
  return { code: 200, booking: { recordId: rec.id, lessonId: lesson.id, roomId, classId: v.classId, title: v.group.name,
    date: v.date, time: v.time, name: v.name, phone: v.phone, ig: v.ig } };
}

// ---- запись по id (страница отмены) ----
async function recordInfo(recordId, groups) {
  let rec;
  try { rec = await mk.request("GET", `/lessonRecords/${recordId}`); }
  catch (e) { if (e instanceof mk.MkError && e.status === 404) return null; throw e; }
  if (!rec || !rec.lessonId) return null;
  const [lesson] = await mk.lessons({ lessonId: [rec.lessonId] }, { includeRecords: true });
  if (!lesson) return null;
  const user = await mk.request("GET", `/users/${rec.userId}`).catch(() => null);
  const group = groups.find(g => g.classId === lesson.classId);
  return { recordId, lessonId: lesson.id, classId: lesson.classId, userId: rec.userId, test: !!rec.test,
    onlyStudent: (lesson.records || []).every(r => r.userId === rec.userId), trialGroup: !!group,
    date: lesson.date, time: time.fromMin(time.toMin(lesson.beginTime)), title: group ? group.name : lesson.topic || "",
    name: (user && user.name) || "", phone: user && user.phone ? "+" + String(user.phone).replace(/\D/g, "") : "" };
}

// состояние записи для отмены: { state: "ask" | "late" | "gone", info }
async function cancelState(recordId, now = Date.now()) {
  const { cfg, groups } = await context();
  const info = recordId ? await recordInfo(recordId, groups) : null;
  if (!info) return { state: "gone", info: null };
  return { state: time.startMs(info.date, info.time) - now < cfg.cutoffMs ? "late" : "ask", info };
}

// Отмена. Пробное занятие, созданное сайтом (запись test, ученик единственный, группа из настроек), удаляется целиком —
// кабинет снова свободен. Иначе удаляется только запись ученика. → { code, error } | { code: 200, info }
async function cancel(recordId, now = Date.now()) {
  const { state, info } = await cancelState(recordId, now);
  if (state !== "ask") return { code: 409, error: state, info };
  try {
    if (info.test && info.onlyStudent && info.trialGroup) await mk.request("DELETE", `/lessons/${info.lessonId}`);
    else await mk.request("DELETE", `/lessonRecords/${info.recordId}`);
  } catch (e) {
    if (e instanceof mk.MkError && e.status === 404) return { code: 409, error: "gone" };
    throw e;
  }
  return { code: 200, info };
}

// ---- напоминания ----
// daily: пробные записи на завтра; hourly: уроки, которые начинаются через 24–25 ч.
// Записи, созданные меньше 12 ч назад, пропускаются — подтверждение пришло недавно.
// → [{ phone, when: "сегодня"|"завтра", booking }]
async function dueReminders(now = Date.now()) {
  const { cfg, groups } = await context();
  const hourly = cfg.reminderMode === "hourly";
  const today = time.today(now), tomorrow = time.addDays(today, 1);
  const lessons = await mk.lessons({ date: hourly ? [today, time.addDays(today, 2)] : [tomorrow, tomorrow],
    classId: groups.map(g => g.classId), statusId: 0 }, { includeRecords: true });

  const due = [];
  for (const l of lessons) {
    const group = groups.find(g => g.classId === l.classId);
    if (!group) continue;
    const left = time.startMs(l.date, l.beginTime) - now;
    if (hourly ? !(left >= 24 * 3600e3 && left < 25 * 3600e3) : l.date !== tomorrow) continue;
    for (const r of l.records || []) {
      if (!r.test || r.skip) continue;
      if (r.createdAt && now - Date.parse(r.createdAt) < 12 * 3600e3) continue;
      due.push({ r, l, group });
    }
  }
  if (!due.length) return [];

  const userIds = [...new Set(due.map(d => d.r.userId))];
  const users = new Map(mk.asList(await mk.request("GET", "/users", { query: { userIds, limit: 500 } }), "users").map(u => [u.id, u]));
  const out = [];
  for (const { r, l, group } of due) {
    const u = users.get(r.userId);
    if (!u || !u.phone) continue;
    out.push({ phone: "+" + String(u.phone).replace(/\D/g, ""), when: l.date === today ? "сегодня" : "завтра",
      booking: { recordId: r.id, date: l.date, time: time.fromMin(time.toMin(l.beginTime)), title: group.name, name: u.name || "" } });
  }
  return out;
}

// ---- незавершённая заявка ----
function parseLead(body) {
  if (body.website) return { spam: true };
  const name = cleanName(body.name), phone = String(body.phone || "");
  if (!name || !validPhone(phone)) return { error: "bad" };
  return { name, phone, ig: cleanIg(body.ig) };
}

module.exports = { schedule, validate, book, recordInfo, cancelState, cancel, dueReminders, parseLead, validPhone };
