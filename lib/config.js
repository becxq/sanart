// Настройки из переменных окружения.
// На Vercel они задаются в Project Settings → Environment Variables (после изменения нужен Redeploy).
// Локально (tools/, ручная проверка) дополнительно читается файл .env в корне проекта —
// он не попадает ни в git, ни в деплой. Описание всех переменных — в .env.example и README.md.
const fs = require("fs");
const path = require("path");

// ---- локальный .env (переменные окружения важнее файла) ----
function loadDotEnv(file = path.join(__dirname, "..", ".env")) {
  if (process.env.VERCEL || process.env.SANART_NO_DOTENV) return; // на Vercel и в тестах .env не читаем
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv();

// Ошибка настройки: какие переменные не заданы и что в них не так. Значения в текст не попадают.
class ConfigError extends Error {
  constructor(message, { missing = [], problems = [] } = {}) {
    super(message);
    this.missing = missing;
    this.problems = problems;
  }
}

const REQUIRED = ["MOYKLASS_API_KEY", "SIGNING_SECRET", "MOYKLASS_TRIAL_GROUPS"];

// "10:00" / "10" → минуты от полуночи
function parseClock(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m || +m[1] > 24 || +(m[2] || 0) > 59) return NaN;
  return +m[1] * 60 + +(m[2] || 0);
}

// "20:5;21:6,7;22" → [{classId:20, ids:[5]}, {classId:21, ids:[6,7]}, {classId:22, ids:[]}]
function parseGroupList(s, problems, name, what) {
  const groups = [];
  for (const part of String(s || "").split(";").map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?::\s*([\d\s,]*))?$/);
    if (!m) { problems.push(`${name}: не понял «${part}», ожидается группа или группа:${what},${what}`); continue; }
    const classId = +m[1];
    const ids = (m[2] || "").split(",").map(x => x.trim()).filter(Boolean).map(Number);
    if (groups.some(g => g.classId === classId)) problems.push(`${name}: группа ${classId} указана дважды`);
    else groups.push({ classId, ids: [...new Set(ids)] });
  }
  return groups;
}
// MOYKLASS_TRIAL_GROUPS: группа[:кабинет,кабинет]
const parseTrialGroups = (s, problems) =>
  parseGroupList(s, problems, "MOYKLASS_TRIAL_GROUPS", "кабинет").map(g => ({ classId: g.classId, roomIds: g.ids }));
// MOYKLASS_TRIAL_TEACHERS: группа:преподаватель,преподаватель
function parseTrialTeachers(s, problems) {
  const list = parseGroupList(s, problems, "MOYKLASS_TRIAL_TEACHERS", "преподаватель");
  for (const g of list) if (!g.ids.length) problems.push(`MOYKLASS_TRIAL_TEACHERS: для группы ${g.classId} не указаны преподаватели`);
  return list.map(g => ({ classId: g.classId, teacherIds: g.ids }));
}

function read(env) {
  const problems = [];
  const str = name => String(env[name] || "").trim();
  const int = (name, def, min, max) => {
    const s = str(name);
    if (!s) return def;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name}: нужно целое число от ${min} до ${max}`); return def; }
    return n;
  };
  const num = (name, def, min, max) => {
    const s = str(name);
    if (!s) return def;
    const n = Number(s.replace(",", "."));
    if (!Number.isFinite(n) || n < min || n > max) { problems.push(`${name}: нужно число от ${min} до ${max}`); return def; }
    return n;
  };
  const clock = (name, def) => {
    const s = str(name);
    if (!s) return parseClock(def);
    const m = parseClock(s);
    if (Number.isNaN(m)) { problems.push(`${name}: нужно время в формате ЧЧ:ММ`); return parseClock(def); }
    return m;
  };

  const cfg = {
    apiKey: str("MOYKLASS_API_KEY"),
    apiUrl: (str("MOYKLASS_API_URL") || "https://api.moyklass.com").replace(/\/+$/, "") + "/v1/company",
    signingSecret: str("SIGNING_SECRET"),
    trialGroups: parseTrialGroups(env.MOYKLASS_TRIAL_GROUPS, problems),
    trialTeachers: parseTrialTeachers(env.MOYKLASS_TRIAL_TEACHERS, problems),

    workStart: clock("WORK_START", "10:00"),
    workEnd: clock("WORK_END", "22:00"),
    trialMinutes: int("TRIAL_MINUTES", 45, 5, 240),
    slotStep: int("SLOT_STEP_MINUTES", 15, 5, 120),
    bookingDays: int("BOOKING_DAYS", 7, 1, 31),
    searchWeeks: int("SEARCH_WEEKS", 8, 1, 26),
    cutoffHours: num("BOOKING_CUTOFF_HOURS", 3, 0, 72),

    joinStatusId: int("MOYKLASS_JOIN_STATUS_ID", 0, 0, Number.MAX_SAFE_INTEGER),
    sourceId: int("MOYKLASS_SOURCE_ID", 0, 0, Number.MAX_SAFE_INTEGER),
    sourceIdIg: int("MOYKLASS_SOURCE_ID_IG", 0, 0, Number.MAX_SAFE_INTEGER),

    publicUrl: str("PUBLIC_URL").replace(/\/+$/, ""),
    green: str("GREEN_URL") && str("GREEN_ID") && str("GREEN_TOKEN")
      ? { url: str("GREEN_URL").replace(/\/+$/, ""), id: str("GREEN_ID"), token: str("GREEN_TOKEN") } : null,
    admins: str("ADMIN_WHATSAPP").split(",").map(s => s.trim()).filter(Boolean),
    cronSecret: str("CRON_SECRET"),
    reminderMode: str("REMINDER_MODE") || "daily",
  };
  cfg.sourceIdIg = cfg.sourceIdIg || cfg.sourceId;
  cfg.cutoffMs = cfg.cutoffHours * 3600e3;
  if (cfg.workEnd - cfg.workStart < cfg.trialMinutes) problems.push("WORK_START/WORK_END: рабочий день короче пробного урока");
  if (!["daily", "hourly"].includes(cfg.reminderMode)) problems.push("REMINDER_MODE: daily или hourly");
  if (str("MOYKLASS_TRIAL_GROUPS") && !cfg.trialGroups.length && !problems.length) problems.push("MOYKLASS_TRIAL_GROUPS: не указано ни одной группы");

  cfg.missing = REQUIRED.filter(k => !str(k));
  cfg.problems = problems;
  return cfg;
}

let cached = null;
// Настройки как есть (без проверки обязательных) — для tools/ и мест, где хватает части настроек.
const get = () => cached || (cached = read(process.env));
// Настройки для работы сайта: бросает ConfigError, если чего-то не хватает.
function check() {
  const cfg = get();
  if (cfg.missing.length || cfg.problems.length)
    throw new ConfigError("Ошибка настройки: " + [...cfg.missing.map(k => k + " не задана"), ...cfg.problems].join("; "),
      { missing: cfg.missing, problems: cfg.problems });
  return cfg;
}
const reset = () => { cached = null; }; // для тестов: перечитать окружение

module.exports = { get, check, reset, ConfigError, parseTrialGroups, parseTrialTeachers, parseClock, loadDotEnv, REQUIRED };
