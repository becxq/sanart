process.env.SANART_NO_DOTENV = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../lib/availability");
const t = require("../lib/time");

const settings = { workStart: 600, workEnd: 1320, trialMinutes: 45, slotStep: 15, cutoffMs: 3 * 3600e3 };
const D = "2026-12-01";
const NOW = Date.parse("2026-11-30T00:00:00Z"); // за сутки до D — cutoff не мешает
const vocal = { classId: 20, roomIds: [5] };
const guitar = { classId: 21, roomIds: [6, 7] };
const lesson = (roomId, b, e, date = D) => ({ date, beginTime: b + ":00", endTime: e + ":00", roomId });
const times = (slots, classId) => slots.filter(s => s.classIds.includes(classId)).map(s => s.time);

test("занятие 10:30–11:15 в каб. 5 закрывает старты 10:00–11:00 только в каб. 5", () => {
  const idx = a.busyIndex([lesson(5, "10:30", "11:15")]);
  const slots = a.daySlots(idx, [vocal, { classId: 22, roomIds: [8] }], D, settings, NOW);
  const v = times(slots, 20);
  for (const x of ["10:00", "10:15", "10:30", "10:45", "11:00"]) assert.ok(!v.includes(x), x + " должно быть занято");
  assert.ok(v.includes("11:15"));
  assert.ok(!v.includes("09:45"));
  assert.equal(times(slots, 22)[0], "10:00"); // другой кабинет свободен
  assert.equal(times(slots, 22).length, 46);
});

test("последний старт 21:15, 21:30 нет", () => {
  const v = times(a.daySlots(a.busyIndex([]), [vocal], D, settings, NOW), 20);
  assert.equal(v[v.length - 1], "21:15");
  assert.ok(!v.includes("21:30"));
  assert.equal(a.freePlace(a.busyIndex([]), vocal, D, t.toMin("21:30"), settings), null);
  assert.equal(a.freePlace(a.busyIndex([]), vocal, D, t.toMin("09:45"), settings), null);
});

test("занятие без кабинета закрывает все кабинеты", () => {
  const idx = a.busyIndex([lesson(null, "12:00", "13:00")]);
  const slots = a.daySlots(idx, [vocal, guitar], D, settings, NOW);
  assert.ok(!slots.some(s => s.time === "12:00" || s.time === "11:30"));
  assert.ok(slots.some(s => s.time === "11:15"));
  assert.ok(slots.some(s => s.time === "13:00"));
});

test("инструмент с двумя кабинетами доступен, пока свободен хоть один", () => {
  let idx = a.busyIndex([lesson(6, "14:00", "15:00")]);
  assert.equal(a.freePlace(idx, guitar, D, t.toMin("14:00"), settings)?.roomId, 7);
  assert.ok(times(a.daySlots(idx, [guitar], D, settings, NOW), 21).includes("14:00"));
  idx = a.busyIndex([lesson(6, "14:00", "15:00"), lesson(7, "14:30", "15:30")]);
  assert.equal(a.freePlace(idx, guitar, D, t.toMin("14:00"), settings), null);
  assert.ok(!times(a.daySlots(idx, [guitar], D, settings, NOW), 21).includes("14:00"));
  assert.equal(a.freePlace(idx, guitar, D, t.toMin("13:00"), settings)?.roomId, 6); // первый по порядку из настроек
});

test("другие даты не мешают", () => {
  const idx = a.busyIndex([lesson(5, "10:00", "22:00", "2026-12-02")]);
  assert.equal(a.daySlots(idx, [vocal], D, settings, NOW).length, 46);
});

test("cutoff: слоты ближе 3 ч к текущему моменту не показываются", () => {
  const now = t.startMs(D, "12:00"); // сейчас 12:00 в Алматы
  const v = times(a.daySlots(a.busyIndex([]), [vocal], D, settings, now), 20);
  assert.equal(v[0], "15:00");
  assert.ok(!v.includes("14:45"));
});

test("findSchedule: первая неделя занята → следующая неделя", async () => {
  const today = "2026-12-01", calls = [];
  const fullWeek = t.dateRange(today, 7).map(d => lesson(null, "10:00", "22:00", d));
  const r = await a.findSchedule({
    lessonsFor: async (from, to) => { calls.push([from, to]); return from === today ? fullWeek : []; },
    groups: [vocal], today, settings, now: NOW, days: 7, weeks: 8,
  });
  assert.equal(r.weeksAhead, 1);
  assert.equal(r.nothingFree, false);
  assert.equal(r.from, "2026-12-08");
  assert.equal(r.to, "2026-12-14");
  assert.deepEqual(calls, [["2026-12-01", "2026-12-07"], ["2026-12-08", "2026-12-14"]]);
  assert.equal(r.days["2026-12-08"].length, 46);
});

test("findSchedule: нигде нет времени → ближайшая неделя с nothingFree", async () => {
  const today = "2026-12-01";
  const r = await a.findSchedule({
    lessonsFor: async (from) => t.dateRange(from, 7).map(d => lesson(null, "09:00", "23:00", d)),
    groups: [vocal], today, settings, now: NOW, days: 7, weeks: 3,
  });
  assert.equal(r.nothingFree, true);
  assert.equal(r.weeksAhead, 0);
  assert.equal(r.from, today);
  assert.deepEqual(Object.keys(r.days), t.dateRange(today, 7));
  assert.ok(Object.values(r.days).every(s => s.length === 0));
});

// ---- преподаватели ----
const lessonT = (roomId, b, e, teacherIds) => ({ ...lesson(roomId, b, e), teacherIds });
const gtr = { classId: 21, roomIds: [6, 7], teacherIds: [501, 502] };
const voc = { classId: 20, roomIds: [5], teacherIds: [503] };
const pno = { classId: 22, roomIds: [8], teacherIds: [503] };

test("преподаватель занят в другом кабинете → инструмент недоступен", () => {
  const idx = a.busyIndex([lessonT(99, "15:00", "16:00", [503])]);
  assert.equal(a.freePlace(idx, voc, D, t.toMin("15:00"), settings), null);
  assert.equal(a.freePlace(idx, voc, D, t.toMin("14:30"), settings), null);
  assert.deepEqual(a.freePlace(idx, voc, D, t.toMin("14:15"), settings), { roomId: 5, teacherId: 503 }); // 14:15–15:00 впритык
  assert.deepEqual(a.freePlace(idx, voc, D, t.toMin("16:00"), settings), { roomId: 5, teacherId: 503 });
});

test("общий преподаватель вокала и фортепиано: занят — закрыты оба инструмента", () => {
  const idx = a.busyIndex([lessonT(5, "12:00", "12:45", [503])]); // например, пробный вокал
  const s = a.daySlots(idx, [voc, pno, gtr], D, settings, NOW).find(x => x.time === "12:00");
  assert.deepEqual(s.classIds, [21]);
});

test("два преподавателя гитары: берётся первый свободный; заняты оба — гитары нет", () => {
  let idx = a.busyIndex([lessonT(99, "14:00", "15:00", [501])]);
  assert.deepEqual(a.freePlace(idx, gtr, D, t.toMin("14:00"), settings), { roomId: 6, teacherId: 502 });
  idx = a.busyIndex([lessonT(99, "14:00", "15:00", [501]), lessonT(98, "13:30", "14:30", [502])]);
  assert.equal(a.freePlace(idx, gtr, D, t.toMin("14:00"), settings), null);
});

test("группа без преподавателей — только кабинеты (teacherId null)", () => {
  const idx = a.busyIndex([lessonT(99, "14:00", "15:00", [501])]);
  assert.deepEqual(a.freePlace(idx, guitar, D, t.toMin("14:00"), settings), { roomId: 6, teacherId: null });
});
