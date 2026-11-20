// Расчёт свободного времени. Только чистые функции: на входе занятия, группы, настройки и «сейчас»,
// на выходе — слоты. Сеть здесь не используется, поэтому всё проверяется тестами (tests/availability.test.js).
//
// Правила:
//  - уроки идут параллельно в разных кабинетах; занятие занимает только свой кабинет (roomId),
//    занятие без кабинета занимает все кабинеты;
//  - кабинет свободен на старте, если [старт, старт + TRIAL_MINUTES) не пересекается ни с одним его занятием;
//  - инструмент (группа) доступен на старте, если свободен хотя бы один из его кабинетов;
//  - время показывается, если доступен хотя бы один инструмент и до начала не меньше BOOKING_CUTOFF_HOURS;
//  - если в неделе нет свободного времени, смотрим следующую, до SEARCH_WEEKS недель.
const { toMin, fromMin, overlaps, slotStarts, startMs, addDays, dateRange } = require("./time");

// Занятость по датам: date → { all: [[начало, конец]] (занятия без кабинета), rooms: Map(roomId → [[начало, конец]]) }
function busyIndex(lessons) {
  const index = new Map();
  for (const l of lessons || []) {
    const s = toMin(l.beginTime), e = toMin(l.endTime);
    if (!l.date || Number.isNaN(s) || Number.isNaN(e)) continue;
    if (!index.has(l.date)) index.set(l.date, { all: [], rooms: new Map() });
    const day = index.get(l.date);
    if (!l.roomId) day.all.push([s, e]);
    else {
      if (!day.rooms.has(l.roomId)) day.rooms.set(l.roomId, []);
      day.rooms.get(l.roomId).push([s, e]);
    }
  }
  return index;
}

function roomFree(index, date, roomId, start, end) {
  const day = index.get(date);
  if (!day) return true;
  const hit = ([s, e]) => overlaps(start, end, s, e);
  return !day.all.some(hit) && !(day.rooms.get(roomId) || []).some(hit);
}

// первый свободный кабинет группы на этот старт (в порядке из настроек), или null
function freeRoom(index, group, date, start, settings) {
  const end = start + settings.trialMinutes;
  if (start < settings.workStart || end > settings.workEnd) return null;
  return group.roomIds.find(r => roomFree(index, date, r, start, end)) ?? null;
}

// слоты одного дня: [{ time: "10:00", classIds: [группы, доступные на этот старт] }]
function daySlots(index, groups, date, settings, now) {
  const out = [];
  for (const start of slotStarts(settings)) {
    if (startMs(date, start) - now < settings.cutoffMs) continue; // слишком поздно записываться
    const classIds = groups.filter(g => freeRoom(index, g, date, start, settings) !== null).map(g => g.classId);
    if (classIds.length) out.push({ time: fromMin(start), classIds });
  }
  return out;
}

// дни подряд от from: { "YYYY-MM-DD": [слоты] }
function buildDays({ lessons, groups, from, days, settings, now }) {
  const index = busyIndex(lessons);
  const out = {};
  for (const date of dateRange(from, days)) out[date] = daySlots(index, groups, date, settings, now);
  return out;
}

const hasFree = days => Object.values(days).some(slots => slots.length > 0);

// Поиск первой недели со свободным временем. lessonsFor(from, to) отдаёт занятия за период
// (в проде — запрос к МойКласс, в тестах — массив), поэтому недели запрашиваются по одной и только пока нужно.
// Если свободного времени нет нигде — ближайшая неделя с nothingFree: true.
async function findSchedule({ lessonsFor, groups, today, settings, now, days, weeks }) {
  let first = null;
  for (let w = 0; w < weeks; w++) {
    const from = addDays(today, w * days), to = addDays(from, days - 1);
    const week = { from, to, weeksAhead: w, nothingFree: false,
      days: buildDays({ lessons: await lessonsFor(from, to), groups, from, days, settings, now }) };
    if (hasFree(week.days)) return week;
    if (!first) first = week;
  }
  return { ...first, nothingFree: true };
}

module.exports = { busyIndex, roomFree, freeRoom, daySlots, buildDays, hasFree, findSchedule };
