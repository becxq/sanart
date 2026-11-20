process.env.SANART_NO_DOTENV = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../lib/time");

test("toMin / fromMin", () => {
  assert.equal(t.toMin("10:30"), 630);
  assert.equal(t.toMin("10:30:00"), 630);
  assert.ok(Number.isNaN(t.toMin("")));
  assert.equal(t.fromMin(630), "10:30");
  assert.equal(t.fromMin(9 * 60 + 5), "09:05");
});

test("сегодня по Алматы (UTC+5)", () => {
  assert.equal(t.today(Date.parse("2026-11-21T18:59:00Z")), "2026-11-21");
  assert.equal(t.today(Date.parse("2026-11-21T19:00:00Z")), "2026-11-22"); // полночь в Алматы
  assert.deepEqual(t.almaty(Date.parse("2026-11-21T05:15:00Z")), { date: "2026-11-21", min: 10 * 60 + 15 });
});

test("startMs — время урока по Алматы", () => {
  assert.equal(t.startMs("2026-11-23", "10:00"), Date.parse("2026-11-23T05:00:00Z"));
  assert.equal(t.startMs("2026-11-23", 600), Date.parse("2026-11-23T05:00:00Z"));
});

test("даты", () => {
  assert.equal(t.addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(t.dateRange("2026-11-29", 3), ["2026-11-29", "2026-11-30", "2026-12-01"]);
  assert.ok(t.isDate("2026-02-28"));
  assert.ok(!t.isDate("2026-02-30"));
  assert.ok(!t.isDate("26-02-01"));
  assert.equal(t.ruDate("2026-11-23"), "23.11.2026");
});

test("сетка стартов: 10:00 … 21:15 при 45 мин и шаге 15", () => {
  const s = t.slotStarts({ workStart: 600, workEnd: 1320, trialMinutes: 45, slotStep: 15 });
  assert.equal(t.fromMin(s[0]), "10:00");
  assert.equal(t.fromMin(s[s.length - 1]), "21:15");
  assert.equal(s.length, 46);
});

test("пересечение интервалов — границы не пересекаются", () => {
  assert.ok(t.overlaps(600, 645, 630, 675));
  assert.ok(!t.overlaps(600, 645, 645, 690));
  assert.ok(!t.overlaps(645, 690, 600, 645));
});
