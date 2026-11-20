process.env.SANART_NO_DOTENV = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../lib/config");
const sign = require("../lib/sign");

function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(MOYKLASS_|GREEN_|SIGNING_|CRON_|WORK_|TRIAL_|SLOT_|BOOKING_|SEARCH_|REMINDER_|PUBLIC_|ADMIN_)/.test(k)) delete process.env[k];
  Object.assign(process.env, vars);
  config.reset();
  try { return fn(); } finally { process.env = saved; config.reset(); }
}

test("MOYKLASS_TRIAL_GROUPS разбирается по формату classId[:roomId,…];…", () => {
  const p = [];
  assert.deepEqual(config.parseTrialGroups("20:5; 21:6,7 ;22", p), [
    { classId: 20, roomIds: [5] }, { classId: 21, roomIds: [6, 7] }, { classId: 22, roomIds: [] }]);
  assert.deepEqual(p, []);
  config.parseTrialGroups("20:5;abc;20", p);
  assert.equal(p.length, 2);
});

test("нет обязательных переменных → ConfigError со списком", () => withEnv({}, () => {
  assert.throws(() => config.check(), e => e instanceof config.ConfigError
    && e.missing.join() === "MOYKLASS_API_KEY,SIGNING_SECRET,MOYKLASS_TRIAL_GROUPS");
}));

test("значения по умолчанию", () => withEnv({ MOYKLASS_API_KEY: "k", SIGNING_SECRET: "s", MOYKLASS_TRIAL_GROUPS: "1" }, () => {
  const c = config.check();
  assert.equal(c.workStart, 600);
  assert.equal(c.workEnd, 1320);
  assert.equal(c.trialMinutes, 45);
  assert.equal(c.slotStep, 15);
  assert.equal(c.bookingDays, 7);
  assert.equal(c.searchWeeks, 8);
  assert.equal(c.cutoffMs, 3 * 3600e3);
  assert.equal(c.reminderMode, "daily");
  assert.equal(c.green, null);
  assert.equal(c.apiUrl, "https://api.moyklass.com/v1/company");
}));

test("неверные значения → problems", () => withEnv({ MOYKLASS_API_KEY: "k", SIGNING_SECRET: "s", MOYKLASS_TRIAL_GROUPS: "1",
  WORK_START: "25:00", TRIAL_MINUTES: "abc", REMINDER_MODE: "weekly" }, () => {
  assert.throws(() => config.check(), e => e.problems.length === 3 && !e.missing.length);
}));

test("подпись ссылки отмены: верная, подделанная, старый формат", () => withEnv({ SIGNING_SECRET: "secret" }, () => {
  const t = sign.cancelToken(12345);
  assert.match(t, /^12345\.[A-Za-z0-9_-]{22}$/);
  assert.equal(sign.recordIdFromToken(t), 12345);
  assert.equal(sign.recordIdFromToken("12346." + t.split(".")[1]), 0);
  assert.equal(sign.recordIdFromToken("garbage"), 0);
  // тот же алгоритм, что в прежней lib/core.js
  const crypto = require("crypto");
  const old = crypto.createHmac("sha256", "secret").update("cancel:12345").digest("base64url").slice(0, 22);
  assert.equal(t, "12345." + old);
}));
