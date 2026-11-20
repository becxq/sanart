const { setEnv, mock } = require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const mk = require("../lib/moyklass");
const config = require("../lib/config");
const http = require("../lib/http");

let m;
test.before(async () => { m = await mock.start(); });
test.after(() => m.close());
test.beforeEach(() => { m.reset(); setEnv(m); });

test("массивы в query передаются повторяющимися ключами", async () => {
  assert.equal(mk.buildQuery({ date: ["2026-12-01", "2026-12-07"], classId: [20, 21], x: undefined, y: [] }),
    "date=2026-12-01&date=2026-12-07&classId=20&classId=21");
  await mk.lessons({ date: ["2026-12-01", "2026-12-07"], statusId: 0 });
  const r = m.db.requests.find(x => x.path === "/v1/company/lessons");
  assert.match(r.search, /date=2026-12-01&date=2026-12-07/);
  assert.doesNotMatch(r.search, /%2C|,/);
});

test("при 401 берётся новый токен и запрос повторяется один раз", async () => {
  await mk.classes();
  assert.equal(m.db.tokensIssued, 1);
  m.db.token = "tok-2"; // старый токен истёк
  const r = await mk.request("GET", "/filials");
  assert.equal(r.length, 1);
  assert.equal(m.db.tokensIssued, 2);
});

test("429 TooManyRequests: до двух повторов с паузой, потом ошибка crm 429", async () => {
  mk._setRetryDelays(10, 10);
  try {
    m.db.tooMany = 2;
    assert.equal((await mk.request("GET", "/filials")).length, 1);
    m.db.tooMany = 3;
    const e = await mk.request("GET", "/filials").catch(e => e);
    assert.deepEqual([http.errorInfo(e).error, http.errorInfo(e).status], ["crm", 429]);
  } finally { mk._setRetryDelays(1000, 2000); }
});

test("неверный ключ → MkAuthError → errorInfo crm-auth без секретов", async () => {
  setEnv(m, { MOYKLASS_API_KEY: "wrong" });
  const e = await mk.request("GET", "/classes").catch(e => e);
  assert.ok(e instanceof mk.MkAuthError);
  const info = http.errorInfo(e);
  assert.equal(info.error, "crm-auth");
  assert.ok(!JSON.stringify(info).includes("wrong"));
});

test("ошибка запроса → errorInfo crm со статусом и путём", async () => {
  const e = await mk.request("GET", "/nope").catch(e => e);
  assert.deepEqual([http.errorInfo(e).error, http.errorInfo(e).status], ["crm", 404]);
  assert.match(http.errorInfo(e).detail, /GET \/nope 404/);
});

test("занятия загружаются постранично (limit 500 / offset)", async () => {
  for (let i = 0; i < 1100; i++) m.addLesson({ date: "2026-12-01", beginTime: "10:00", endTime: "10:45", roomId: 5, classId: 20 });
  const all = await mk.lessons({ date: ["2026-12-01", "2026-12-01"] });
  assert.equal(all.length, 1100);
  const offsets = m.db.requests.filter(r => r.path.endsWith("/lessons")).map(r => new URLSearchParams(r.search).get("offset"));
  assert.deepEqual(offsets, ["0", "500", "1000"]);
});

test("справочники кэшируются", async () => {
  await mk.classes(); await mk.classes(); await mk.trialSetup();
  assert.equal(m.db.requests.filter(r => r.path.endsWith("/classes")).length, 1);
});

test("trialSetup: группы, названия, кабинеты; без кабинетов — все активные кабинеты филиала", async () => {
  const s = await mk.trialSetup();
  assert.equal(s.filialId, 1);
  assert.deepEqual(s.groups, [
    { classId: 20, name: "Вокал", roomIds: [5], teacherIds: [] },
    { classId: 21, name: "Гитара", roomIds: [6, 7], teacherIds: [] },
    { classId: 22, name: "Фортепиано", roomIds: [5, 6, 7], teacherIds: [] }]);
});

const configError = async (fn, re) => {
  const e = await fn().catch(e => e);
  assert.ok(e instanceof config.ConfigError, "ожидалась ConfigError, получено " + e);
  const info = http.errorInfo(e);
  assert.equal(info.error, "config");
  assert.match(JSON.stringify(info), re);
  return info;
};

test("config: нет обязательных переменных", async () => {
  setEnv(m, { SIGNING_SECRET: undefined, MOYKLASS_TRIAL_GROUPS: undefined });
  const info = await configError(() => mk.trialSetup(), /SIGNING_SECRET/);
  assert.deepEqual(info.missing, ["SIGNING_SECRET", "MOYKLASS_TRIAL_GROUPS"]);
});

test("config: неизвестный и неактивный кабинет, неизвестная группа", async () => {
  setEnv(m, { MOYKLASS_TRIAL_GROUPS: "20:5,99;21:9;555" });
  const info = await configError(() => mk.trialSetup(), /кабинета 99/);
  assert.equal(info.problems.length, 3);
  assert.match(info.problems.join(), /кабинет 9 .*не активен/);
  assert.match(info.problems.join(), /группы 555 нет/);
});

test("config: несколько активных филиалов", async () => {
  m.db.filials.push({ id: 2, status: "active", name: "Второй" });
  await configError(() => mk.trialSetup(), /2 активных филиал/);
});

test("статус записи в группу: из переменной или со словом «Проб»", async () => {
  assert.equal(await mk.trialJoinStatusId(), 41075);
  setEnv(m, { MOYKLASS_JOIN_STATUS_ID: undefined });
  assert.equal(await mk.trialJoinStatusId(), 77);
  m.db.joinStatuses = [{ id: 2, name: "Учится" }];
  mk._reset();
  await configError(() => mk.trialJoinStatusId(), /MOYKLASS_JOIN_STATUS_ID/);
});

test("trialSetup: преподаватели по группам из MOYKLASS_TRIAL_TEACHERS", async () => {
  setEnv(m, { MOYKLASS_TRIAL_TEACHERS: "21:501,502;20:503;22:503" });
  const s = await mk.trialSetup();
  assert.deepEqual(s.groups.map(g => [g.classId, g.teacherIds]), [[20, [503]], [21, [501, 502]], [22, [503]]]);
});

test("config: неизвестный и уволенный преподаватель, группа не из TRIAL_GROUPS, группа без преподавателей", async () => {
  setEnv(m, { MOYKLASS_TRIAL_TEACHERS: "21:501,999;20:504;777:501" });
  const info = await configError(() => mk.trialSetup(), /преподавателя 999/);
  assert.match(info.problems.join("\n"), /504 «Уволен».*не работает/);
  assert.match(info.problems.join("\n"), /группы 777 нет в MOYKLASS_TRIAL_GROUPS/);
  setEnv(m, { MOYKLASS_TRIAL_TEACHERS: "21" });
  assert.throws(() => config.check(), /не указаны преподаватели/);
});
