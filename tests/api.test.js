// Интеграционные тесты: функции api/* вызываются напрямую, МойКласс и GREEN-API — мок на локальном порту.
const { setEnv, call, mock } = require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const time = require("../lib/time");
const sign = require("../lib/sign");
const booking = require("../lib/booking");

const schedule = require("../api/schedule");
const book = require("../api/book");
const cancel = require("../api/cancel");
const lead = require("../api/lead");
const cron = require("../api/cron");

let m;
const D = time.addDays(time.today(), 2); // послезавтра — cutoff не мешает
const post = (handler, body, url = "/") => call(handler, { method: "POST", url, body });
const person = (phone = "+77011112233", extra = {}) => ({ date: D, time: "12:00", classId: 20, name: "Аня", phone, ...extra });
const lessonsReq = () => m.db.requests.filter(r => r.method === "POST" && r.path === "/v1/company/lessons");

test.before(async () => { m = await mock.start(); });
test.after(() => m.close());
test.beforeEach(() => { m.reset(); setEnv(m); });

// ---- расписание ----
test("schedule: неделя, инструменты, кэш-заголовки", async () => {
  m.addLesson({ date: D, beginTime: "12:00", endTime: "13:00", roomId: 5, classId: 20 });
  const r = await call(schedule, { url: "/api/schedule" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, s-maxage=30, stale-while-revalidate=600");
  assert.deepEqual(r.json.instruments, [{ classId: 20, name: "Вокал" }, { classId: 21, name: "Гитара" }, { classId: 22, name: "Фортепиано" }]);
  assert.equal(r.json.weeksAhead, 0);
  assert.equal(r.json.nothingFree, false);
  assert.equal(Object.keys(r.json.days).length, 7);
  const s = r.json.days[D].find(x => x.time === "12:00");
  assert.deepEqual(s.classIds, [21, 22]); // каб. 5 занят → вокала нет, фортепиано в каб. 6/7
  const q = m.db.requests.find(x => x.path.endsWith("/lessons")).search;
  assert.match(q, /date=\d{4}-\d{2}-\d{2}&date=\d{4}-\d{2}-\d{2}&statusId=0/);

  const f = await call(schedule, { url: "/api/schedule?fresh=1" });
  assert.equal(f.headers["cache-control"], "no-store");
});

test("schedule: ошибка config → 500 {error:config}", async () => {
  setEnv(m, { MOYKLASS_TRIAL_GROUPS: "20:99" });
  const r = await call(schedule, { url: "/api/schedule" });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "config");
  assert.match(r.json.problems[0], /кабинета 99/);
  assert.ok(!r.body.includes("test-key") && !r.body.includes("test-secret"));
});

// ---- запись ----
test("book: группа → занятие 45 мин без преподавателя, с филиалом, кабинетом и test", async () => {
  const r = await post(book, person());
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json, { ok: true, date: D, time: "12:00", title: "Вокал" });

  const user = m.db.users[0];
  assert.deepEqual([user.phone, user.name, user.advSourceId], ["77011112233", "Аня", 3]);
  const posts = m.db.requests.filter(x => x.method === "POST").map(x => x.path.replace("/v1/company", ""));
  assert.deepEqual(posts.filter(p => p !== "/auth/getToken" && !p.startsWith("/waInstance")), ["/users", "/joins", "/lessons"]);
  const join = m.db.joins[0];
  assert.deepEqual([join.userId, join.classId, join.statusId, join.autoJoin, join.advSourceId], [user.id, 20, 41075, false, 3]);

  const body = lessonsReq()[0].body;
  assert.deepEqual(
    { date: body.date, beginTime: body.beginTime, endTime: body.endTime, filialId: body.filialId, roomId: body.roomId,
      classId: body.classId, userId: body.userId, maxStudents: body.maxStudents, topic: body.topic, lessonRecord: body.lessonRecord },
    { date: D, beginTime: "12:00", endTime: "12:45", filialId: 1, roomId: 5, classId: 20, userId: user.id, maxStudents: 1,
      topic: "Пробный урок", lessonRecord: { test: true } });
  assert.ok(!("teacherIds" in body));

  // WhatsApp клиенту (со ссылкой отмены) и двум админам
  assert.deepEqual(m.db.whatsapp.map(w => w.chatId).sort(), ["123-456@g.us", "77000000001@c.us", "77011112233@c.us"]);
  const client = m.db.whatsapp.find(w => w.chatId === "77011112233@c.us").message;
  assert.match(client, /Вокал, \d\d\.\d\d\.\d{4} в 12:00/);
  assert.match(client, /https:\/\/book\.example\/cancel\?t=\d+\.[\w-]{22}/);
  assert.match(client, /Позже пробный урок сгорает/);

  // это время у вокала теперь занято, у гитары — нет
  const s = (await call(schedule, { url: "/api/schedule?fresh=1" })).json.days[D].find(x => x.time === "12:00");
  assert.deepEqual(s.classIds, [21, 22]);
});

test("book: гитара берёт второй кабинет, если первый занят; ig → источник Instagram", async () => {
  m.addLesson({ date: D, beginTime: "11:30", endTime: "12:30", roomId: 6, classId: 21 });
  const r = await post(book, person("+77011112233", { classId: 21, ig: "insta_user" }));
  assert.equal(r.status, 200, r.body);
  assert.equal(lessonsReq()[0].body.roomId, 7);
  assert.equal(m.db.users[0].advSourceId, 4);
  assert.match(lessonsReq()[0].body.comment, /Instagram insta_user/);
  assert.match(m.db.whatsapp.find(w => w.chatId === "77000000001@c.us").message, /Из Instagram: insta_user/);
});

test("book: существующий ученик не создаётся заново и не записывается в группу повторно", async () => {
  const u = m.addUser({ name: "Аня", phone: "77011112233" });
  m.db.joins.push({ id: 1, userId: u.id, classId: 20 });
  assert.equal((await post(book, person())).status, 200);
  assert.equal(m.db.users.length, 1);
  assert.equal(m.db.joins.length, 1);
  assert.equal(lessonsReq()[0].body.userId, u.id);
});

test("book: занятое время → taken; занятие без кабинета закрывает все", async () => {
  m.addLesson({ date: D, beginTime: "11:30", endTime: "12:15", roomId: null, classId: 21 });
  const r = await post(book, person());
  assert.deepEqual([r.status, r.json.error], [409, "taken"]);
  assert.equal(lessonsReq().length, 0);
});

test("book: одно пробное на номер — used; повтор той же записи — already", async () => {
  assert.equal((await post(book, person())).status, 200);
  const other = await post(book, person("+77011112233", { time: "15:00", classId: 21 }));
  assert.deepEqual([other.status, other.json.error], [409, "used"]);

  m.reset(); setEnv(m);
  const u = m.addUser({ name: "Аня", phone: "77011112233" });
  m.addLesson({ date: D, beginTime: "12:00", endTime: "12:45", roomId: 6, classId: 20, records: [{ userId: u.id, test: true }] });
  const same = await post(book, person()); // вокал 12:00 в каб. 5 свободен, но запись уже есть
  assert.deepEqual([same.status, same.json.error], [409, "already"]);
});

test("book: гонка двух записей на один кабинет и время → одна taken, занятие одно", async () => {
  m.db.createDelayMs = 30; // оба успевают проверить кабинет до создания
  const [a, b] = await Promise.all([post(book, person("+77011112233")), post(book, person("+77022223344"))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find(x => x.status === 409).json.error, "taken");
  assert.equal(lessonsReq().length, 2);
  assert.equal(m.db.lessons.length, 1);
  const winner = m.db.users.find(u => u.id === m.db.lessons[0].records[0].userId);
  assert.equal("+" + winner.phone, [a, b].find(x => x.status === 200) === a ? "+77011112233" : "+77022223344");
});

test("book: проверки входа", async () => {
  const bad = async (patch, field) => {
    const r = await post(book, person("+77011112233", patch));
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.json.field, field);
  };
  await bad({ name: " " }, "name");
  await bad({ phone: "87011112233" }, "phone");
  await bad({ phone: "+7701111223" }, "phone");
  await bad({ classId: 164244 }, "classId");
  await bad({ time: "12:05" }, "time");
  await bad({ time: "21:30" }, "time");
  await bad({ time: "09:45" }, "time");
  await bad({ date: time.addDays(time.today(), 56) }, "date"); // дальше today + 7*8 − 1
  await bad({ date: time.addDays(time.today(), -1) }, "date");
  assert.equal((await post(book, person("+77011112233", { date: time.addDays(time.today(), 55) }))).status, 200);
  // длинное имя обрезается до 100 символов
  m.reset(); setEnv(m);
  assert.equal((await post(book, person("+77011112233", { name: "Я".repeat(150) }))).status, 200);
  assert.equal(m.db.users[0].name.length, 100);
});

test("book: ближе cutoff → late (проверка с заданным «сейчас»)", async () => {
  const now = time.startMs(D, "10:00"); // «сейчас» 10:00 в день урока
  assert.deepEqual(await booking.book(person("+77011112233", { time: "12:45" }), now), { code: 409, error: "late", field: undefined });
  const ok = await booking.book(person("+77011112233", { time: "13:00" }), now);
  assert.equal(ok.code, 200);
});

test("book: honeypot website → 200 без записи", async () => {
  const r = await post(book, person("+77011112233", { website: "http://spam" }));
  assert.deepEqual(r.json, { ok: true });
  assert.equal(m.db.requests.filter(x => x.method === "POST" && !x.path.endsWith("getToken")).length, 0);
});

test("book: МойКласс требует преподавателя → понятная ошибка crm", async () => {
  m.db.requireTeacher = true;
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(" "));
  try {
    const r = await post(book, person());
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "crm");
    assert.equal(r.json.status, 400);
    assert.match(r.json.detail, /не принял преподавателя/);
    assert.ok(errors.some(e => /не принял преподавателя/.test(e)));
  } finally { console.error = orig; }
});

test("book: без GREEN_* запись проходит, сообщения не отправляются", async () => {
  setEnv(m, { GREEN_URL: undefined });
  assert.equal((await post(book, person())).status, 200);
  assert.equal(m.db.whatsapp.length, 0);
});

test("book: ошибка WhatsApp не ломает запись", async () => {
  setEnv(m, { GREEN_URL: m.url + "/broken" });
  const orig = console.error; console.error = () => {};
  try { assert.equal((await post(book, person())).status, 200); } finally { console.error = orig; }
});

// ---- отмена ----
async function booked() {
  assert.equal((await post(book, person())).status, 200);
  const rec = m.db.lessons[0].records[0];
  m.db.whatsapp = [];
  return { rec, t: sign.cancelToken(rec.id) };
}

test("cancel: GET показывает страницу и ничего не отменяет; POST удаляет занятие, время снова свободно", async () => {
  const { t } = await booked();
  const page = await call(cancel, { url: "/api/cancel?t=" + t });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.body, /Аня/);
  assert.match(page.body, /Вокал, \d\d\.\d\d\.\d{4} в 12:00/);
  assert.match(page.body, /Отменить запись/);
  assert.equal(m.db.lessons.length, 1);
  assert.ok(!m.db.requests.some(x => x.method === "DELETE"));

  const r = await post(cancel, { t });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(m.db.lessons.length, 0);
  assert.ok(m.db.requests.some(x => x.method === "DELETE" && /\/lessons\/\d+$/.test(x.path)));
  assert.equal(m.db.whatsapp.length, 3);
  assert.match(m.db.whatsapp.find(w => w.chatId === "77011112233@c.us").message, /отменена/);

  const s = (await call(schedule, { url: "/api/schedule?fresh=1" })).json.days[D].find(x => x.time === "12:00");
  assert.deepEqual(s.classIds, [20, 21, 22]);
  // право на пробное вернулось
  assert.equal((await post(book, person())).status, 200);
});

test("cancel: подделанная подпись и удалённая запись → gone", async () => {
  const { rec, t } = await booked();
  const forged = `${rec.id}.${"A".repeat(22)}`;
  assert.equal((await call(cancel, { url: "/api/cancel?t=" + forged })).status, 404);
  assert.deepEqual((await post(cancel, { t: forged })).json, { error: "gone" });
  assert.equal(m.db.lessons.length, 1);
  m.db.lessons = [];
  const r = await post(cancel, { t });
  assert.deepEqual([r.status, r.json.error], [409, "gone"]);
});

test("cancel: позже cutoff → late, занятие не трогается", async () => {
  const soon = time.almaty(Date.now() + 3600e3);
  const u = m.addUser({ name: "Аня", phone: "77011112233" });
  const l = m.addLesson({ date: soon.date, beginTime: time.fromMin(soon.min), endTime: time.fromMin(Math.min(soon.min + 45, 1439)),
    roomId: 5, classId: 20, records: [{ userId: u.id, test: true }] });
  const t = sign.cancelToken(l.records[0].id);
  assert.match((await call(cancel, { url: "/api/cancel?t=" + t })).body, /отменить запись уже нельзя/);
  const r = await post(cancel, { t });
  assert.deepEqual([r.status, r.json.error], [409, "late"]);
  assert.equal(m.db.lessons.length, 1);
});

test("cancel: в групповом занятии удаляется только запись ученика", async () => {
  const u = m.addUser({ name: "Аня", phone: "77011112233" });
  const l = m.addLesson({ date: D, beginTime: "12:00", endTime: "13:00", roomId: 5, classId: 20,
    records: [{ userId: u.id, test: true }, { userId: 999 }] });
  const r = await post(cancel, { t: sign.cancelToken(l.records[0].id) });
  assert.equal(r.status, 200);
  assert.equal(m.db.lessons.length, 1);
  assert.deepEqual(m.db.lessons[0].records.map(x => x.userId), [999]);
});

// ---- напоминания ----
function trialAt(ms, { createdAgoH = 24, test = true, classId = 20, phone = "77011112233" } = {}) {
  const a = time.almaty(ms);
  const u = m.addUser({ name: "Аня", phone });
  return m.addLesson({ date: a.date, beginTime: time.fromMin(a.min), endTime: time.fromMin(Math.min(a.min + 45, 1439)), roomId: 5, classId,
    records: [{ userId: u.id, test, createdAt: new Date(Date.now() - createdAgoH * 3600e3).toISOString() }] });
}
const cronCall = (q = "", headers = { authorization: "Bearer cron-secret" }) => call(cron, { url: "/api/cron" + q, headers });

test("cron: авторизация Bearer или ?key=", async () => {
  assert.equal((await cronCall("", {})).status, 401);
  assert.equal((await cronCall("", { authorization: "Bearer nope" })).status, 401);
  assert.equal((await cronCall("?key=nope", {})).status, 401);
  assert.equal((await cronCall("?key=cron-secret", {})).status, 200);
  assert.equal((await cronCall()).status, 200);
  setEnv(m, { CRON_SECRET: undefined });
  assert.equal((await cronCall()).status, 401); // без секрета cron закрыт
});

test("cron daily: пробные на завтра; свежие (< 12 ч), не test и чужие группы — пропускаются", async () => {
  const tomorrow = time.addDays(time.today(), 1);
  const at = (date, hm) => time.startMs(date, hm);
  trialAt(at(tomorrow, "12:00"), { phone: "77010000001" });
  trialAt(at(tomorrow, "13:00"), { phone: "77010000002", createdAgoH: 2 });
  trialAt(at(tomorrow, "14:00"), { phone: "77010000003", test: false });
  trialAt(at(tomorrow, "15:00"), { phone: "77010000004", classId: 777 });
  trialAt(at(time.addDays(tomorrow, 1), "12:00"), { phone: "77010000005" });
  const r = await cronCall();
  assert.deepEqual(r.json, { ok: true, mode: "daily", due: 1, sent: 1 });
  assert.deepEqual(m.db.whatsapp.map(w => w.chatId), ["77010000001@c.us"]);
  assert.match(m.db.whatsapp[0].message, /напоминаем: завтра у вас пробный урок в SanArt — Вокал, .* в 12:00/);
  assert.match(m.db.whatsapp[0].message, /\/cancel\?t=/);
  const usersReq = m.db.requests.filter(x => x.path === "/v1/company/users");
  assert.equal(usersReq.length, 1); // имена и телефоны одним запросом
  assert.match(usersReq[0].search, /userIds=\d+/);
});

test("cron hourly: только уроки через 24–25 ч", async () => {
  setEnv(m, { REMINDER_MODE: "hourly" });
  trialAt(Date.now() + 24.5 * 3600e3, { phone: "77010000001" });
  trialAt(Date.now() + 23.5 * 3600e3, { phone: "77010000002" });
  trialAt(Date.now() + 25.5 * 3600e3, { phone: "77010000003" });
  const r = await cronCall();
  assert.deepEqual([r.json.mode, r.json.due, r.json.sent], ["hourly", 1, 1]);
  assert.deepEqual(m.db.whatsapp.map(w => w.chatId), ["77010000001@c.us"]);
});

// ---- незавершённая заявка ----
test("lead: пишет админам, ничего не создаёт в МойКласс", async () => {
  const r = await post(lead, { name: "Боря", phone: "+77013334455", ig: "bot123" });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(m.db.whatsapp.length, 2);
  assert.match(m.db.whatsapp[0].message, /перезвоните:\nБоря, \+77013334455\nInstagram: bot123/);
  assert.ok(!m.db.requests.some(x => x.path.startsWith("/v1/company")));
});

test("lead: sendBeacon присылает строку; неверные данные → 400; GET → 405", async () => {
  assert.equal((await post(lead, JSON.stringify({ name: "Боря", phone: "+77013334455" }))).status, 200);
  assert.equal((await post(lead, { name: "Боря", phone: "8701" })).status, 400);
  assert.equal((await call(lead, { url: "/api/lead" })).status, 405);
  assert.equal((await post(lead, { name: "Боря", phone: "+77013334455", website: "x" })).json.ok, true);
  assert.equal(m.db.whatsapp.length, 2); // honeypot не отправил
});

// ---- преподаватели (MOYKLASS_TRIAL_TEACHERS) ----
const TEACHERS = { MOYKLASS_TRIAL_TEACHERS: "21:501,502;20:503;22:503" };

test("book с преподавателями: занятие с teacherIds первого свободного преподавателя", async () => {
  setEnv(m, TEACHERS);
  m.addLesson({ date: D, beginTime: "11:30", endTime: "12:30", roomId: 99, classId: 777, teacherIds: [501] }); // 501 занят
  const r = await post(book, person("+77011112233", { classId: 21 }));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([lessonsReq()[0].body.teacherIds, lessonsReq()[0].body.roomId], [[502], 6]);
});

test("book с преподавателями: вокал занял преподавателя → фортепиано в это время недоступно (taken)", async () => {
  setEnv(m, TEACHERS);
  assert.equal((await post(book, person("+77011112233", { classId: 20 }))).status, 200);
  const s = (await call(schedule, { url: "/api/schedule?fresh=1" })).json.days[D].find(x => x.time === "12:00");
  assert.deepEqual(s.classIds, [21]);
  const r = await post(book, person("+77022223344", { classId: 22 }));
  assert.deepEqual([r.status, r.json.error], [409, "taken"]);
});

test("book с преподавателями: гонка за одного преподавателя в разных кабинетах → одна taken", async () => {
  setEnv(m, { ...TEACHERS, MOYKLASS_TRIAL_GROUPS: "20:5;21:6,7;22:6" }); // вокал в каб. 5, фортепиано в каб. 6
  m.db.createDelayMs = 30;
  const [a, b] = await Promise.all([post(book, person("+77011112233", { classId: 20 })), post(book, person("+77022223344", { classId: 22 }))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(m.db.lessons.length, 1);
  assert.deepEqual(lessonsReq().map(x => x.body.roomId).sort(), [5, 6]); // кабинеты разные — конфликт только по преподавателю
});

test("book: сбой МойКласс после создания занятия не срывает запись — сообщения уходят", async () => {
  m.db.failLessonsAfterCreate = true;
  const errors = [], orig = console.error; console.error = (...a) => errors.push(a.join(" "));
  try {
    const r = await post(book, person());
    assert.equal(r.status, 200, r.body);
    assert.equal(m.db.lessons.length, 1);
    assert.equal(m.db.whatsapp.length, 3); // клиент + 2 админа
    assert.ok(errors.some(e => /проверка гонки пропущена/.test(e)));
  } finally { console.error = orig; }
});

test("book: без recordId сообщение клиенту без ссылки отмены", () => {
  const notify = require("../lib/notify");
  const msg = notify.texts.bookedClient({ name: "Аня", title: "Вокал", date: D, time: "12:00", recordId: null }, "https://x");
  assert.doesNotMatch(msg, /cancel\?t=/);
  assert.match(msg, /напишите нам/);
});
