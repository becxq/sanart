// Всё про дату и время. Школа работает по времени Алматы: UTC+5 круглый год, без перехода на летнее.
// Даты — строки "YYYY-MM-DD", время — минуты от полуночи (в API МойКласс — строки "HH:MM[:SS]").
const OFFSET_MS = 5 * 3600e3;
const DAY_MS = 864e5;

// "10:30" / "10:30:00" → 630
function toMin(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : NaN;
}
// 630 → "10:30"
const fromMin = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
  && new Date(Date.parse(s + "T00:00:00Z")).toISOString().slice(0, 10) === s;
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const dateRange = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

// сегодняшняя дата в Алматы
const today = (now = Date.now()) => new Date(now + OFFSET_MS).toISOString().slice(0, 10);
// момент начала урока (мс UTC) по дате и времени Алматы
const startMs = (date, time) => Date.parse(date + "T00:00:00Z") - OFFSET_MS + (typeof time === "number" ? time : toMin(time)) * 60e3;
// момент → {date, min} по Алматы
function almaty(ms) {
  const d = new Date(ms + OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// интервалы [aStart, aEnd) и [bStart, bEnd) пересекаются
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// старты пробного урока за день: от начала работы с шагом, урок целиком внутри рабочего дня
function slotStarts({ workStart, workEnd, trialMinutes, slotStep }) {
  const out = [];
  for (let s = workStart; s + trialMinutes <= workEnd; s += slotStep) out.push(s);
  return out;
}

// "2026-11-23" → "23.11.2026"
const ruDate = d => d.split("-").reverse().join(".");

module.exports = { OFFSET_MS, toMin, fromMin, isDate, addDays, dateRange, today, startMs, almaty, overlaps, slotStarts, ruDate };
