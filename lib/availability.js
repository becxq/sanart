// Расчёт свободного времени. Только чистые функции: на входе занятия, группы, настройки и «сейчас»,
// на выходе — слоты. Сеть здесь не используется, поэтому всё проверяется тестами (tests/availability.test.js).
//
// Правила:
//  - уроки идут параллельно в разных кабинетах; занятие занимает только свой кабинет (roomId),
//    занятие без кабинета занимает все кабинеты;
//  - занятие занимает и своих преподавателей (teacherIds) — в любом кабинете;
//  - кабинет (преподаватель) свободен на старте, если [старт, старт + TRIAL_MINUTES) не пересекается ни с одним
//    его занятием;
//  - инструмент (группа) доступен на старте, если свободен хотя бы один из его кабинетов и — если у группы
//    указаны преподаватели — хотя бы один из его преподавателей;
//  - время показывается, если доступен хотя бы один инструмент и до начала не меньше BOOKING_CUTOFF_HOURS;
//  - если в неделе нет свободного времени, смотрим следующую, до SEARCH_WEEKS недель.
const { toMin, fromMin, overlaps, slotStarts, startMs, addDays, dateRange } = require("./time");

// Занятость по датам: date → { all: [[начало, конец]] (занятия без кабинета),
//   rooms: Map(roomId → [[начало, конец]]), teachers: Map(teacherId → [[начало, конец]]) }
function busyIndex(lessons) {
  const index = new Map();
  const push = (map, key, iv) => { if (!map.has(key)) map.set(key, []); map.get(key).push(iv); };
  for (const l of lessons || []) {
    const s = toMin(l.beginTime), e = toMin(l.endTime);
    if (!l.date || Number.isNaN(s) || Number.isNaN(e)) continue;
    if (!index.has(l.date)) index.set(l.date, { all: [], rooms: new Map(), teachers: new Map() });
    const day = index.get(l.date);
    if (!l.roomId) day.all.push([s, e]);
    else push(day.rooms, l.roomId, [s, e]);
    for (const t of l.teacherIds || []) push(day.teachers, t, [s, e]);
  }
  return index;
}

const hit = (start, end) => ([s, e]) => overlaps(start, end, s, e);

function roomFree(index, date, roomId, start, end) {
  const day = index.get(date);
  return !day || (!day.all.some(hit(start, end)) && !(day.rooms.get(roomId) || []).some(hit(start, end)));
}
function teacherFree(index, date, teacherId, start, end) {
  const day = index.get(date);
  return !day || !(day.teachers.get(teacherId) || []).some(hit(start, end));
}

// Первый свободный кабинет и первый свободный преподаватель группы на этот старт (в порядке из настроек):
// { roomId, teacherId } (teacherId = null, если у группы нет преподавателей), или null, если места нет.
function freePlace(index, group, date, start, settings) {
  const end = start + settings.trialMinutes;
  if (start < settings.workStart || end > settings.workEnd) return null;
  const roomId = group.roomIds.find(r => roomFree(index, date, r, start, end));
  if (roomId === undefined) return null;
  const teachers = group.teacherIds || [];
  if (!teachers.length) return { roomId, teacherId: null };
  const teacherId = teachers.find(t => teacherFree(index, date, t, start, end));
  return teacherId === undefined ? null : { roomId, teacherId };
}

// слоты одного дня: [{ time: "10:00", classIds: [группы, доступные на этот старт] }]
function daySlots(index, groups, date, settings, now) {
  const out = [];
  for (const start of slotStarts(settings)) {
    if (startMs(date, start) - now < settings.cutoffMs) continue; // слишком поздно записываться
    const classIds = groups.filter(g => freePlace(index, g, date, start, settings)).map(g => g.classId);
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

module.exports = { busyIndex, roomFree, teacherFree, freePlace, daySlots, buildDays, hasFree, findSchedule };
