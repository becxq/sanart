// Shared logic for the sanart booking API on Vercel. Node 18+, no dependencies.
// Nothing is stored on the server: МойКласс is the database, cancel links are signed.
//
// Business rules (agreed with the studio):
//  - trial lessons only in the groups listed in MOYKLASS_CLASS_IDS (individual vocal / guitar)
//  - one trial lesson per phone number (a cancelled one gives the right back)
//  - booking and cancelling close BOOKING_CUTOFF_HOURS before the lesson; later the trial is lost
//  - the trial student takes a place in the lesson
//  - admin gets a WhatsApp on every booking, cancellation and unfinished form
//  - client gets a reminder the day before (Vercel Hobby runs cron once a day)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// local development: read .env if present (on Vercel, set variables in Project Settings)
try {
  const file = path.join(__dirname, "..", ".env");
  for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch { /* no .env: fine on Vercel */ }

const env = process.env;
const ids = s => (s || "").split(",").map(x => parseInt(x, 10)).filter(Number.isFinite);
const num = (s, d) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d; };
const cfg = {
  key: env.MOYKLASS_API_KEY,
  api: (env.MOYKLASS_API_URL || "https://api.moyklass.com") + "/v1/company",
  classIds: ids(env.MOYKLASS_CLASS_IDS),
  filialIds: ids(env.MOYKLASS_FILIAL_IDS),
  joinStatusId: parseInt(env.MOYKLASS_JOIN_STATUS_ID, 10) || 0,
  sourceId: parseInt(env.MOYKLASS_SOURCE_ID, 10) || 0,
  days: Math.min(parseInt(env.BOOKING_DAYS, 10) || 7, 31),
  cutoffMs: num(env.BOOKING_CUTOFF_HOURS, 3) * 3600e3,
  publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
  admins: (env.ADMIN_WHATSAPP || "").split(",").map(s => s.trim()).filter(Boolean),
  secret: env.SIGNING_SECRET || "",
  cronSecret: env.CRON_SECRET || "",
};
cfg.sourceIdIg = parseInt(env.MOYKLASS_SOURCE_ID_IG, 10) || cfg.sourceId;
const cutoffText = (cfg.cutoffMs / 3600e3) + " ч";
function checkConfig() {
  const missing = ["MOYKLASS_API_KEY", "SIGNING_SECRET"].filter(k => !env[k]);
  if (missing.length) throw new Error("Missing environment variables: " + missing.join(", "));
}

// ---- WhatsApp via GREEN-API ----
const chatId = to => to.includes("@") ? to : to.replace(/\D/g, "") + "@c.us"; // phone, or a group id "...@g.us"
async function sendWhatsApp(to, text) {
  if (!env.GREEN_URL || !env.GREEN_ID || !env.GREEN_TOKEN) return; // not configured: skip
  const r = await fetch(`${env.GREEN_URL}/waInstance${env.GREEN_ID}/sendMessage/${env.GREEN_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chatId(to), message: text }),
  });
  if (!r.ok) throw new Error("WhatsApp " + r.status + " " + (await r.text()));
}
// On Vercel the function may be frozen right after the response, so messages are awaited before replying.
const safe = p => p.catch(e => console.error(e.message));
const notifyAdmins = text => Promise.all(cfg.admins.map(a => safe(sendWhatsApp(a, text))));

// ---- МойКласс API (token kept while the function instance is warm) ----
let token = null;
async function getToken() {
  const r = await fetch(cfg.api + "/auth/getToken", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: cfg.key }),
  });
  if (!r.ok) throw new Error("getToken " + r.status + " " + (await r.text()));
  token = (await r.json()).accessToken;
}
class MkError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function mk(method, p, { query, body } = {}, retry = true) {
  if (!token) await getToken();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x)); // arrays as repeated keys: date=a&date=b
    else qs.set(k, String(v));
  }
  const q = qs.toString();
  const r = await fetch(cfg.api + p + (q ? "?" + q : ""), {
    method, headers: { "Content-Type": "application/json", "x-access-token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { token = null; return mk(method, p, { query, body }, false); }
  const text = await r.text();
  if (!r.ok) throw new MkError(`МойКласс ${method} ${p} ${r.status} ${text.slice(0, 300)}`, r.status);
  try { return JSON.parse(text); } catch { return text; }
}

let classCache = { at: 0, map: null };
async function getClasses() {
  if (classCache.map && Date.now() - classCache.at < 10 * 60e3) return classCache.map;
  const list = await mk("GET", "/classes", { query: { classId: cfg.classIds, filialId: cfg.filialIds } });
  classCache = { at: Date.now(), map: new Map((Array.isArray(list) ? list : []).map(c => [c.id, c])) };
  return classCache.map;
}

// ---- time helpers (lesson dates/times are Almaty local, UTC+5) ----
const todayAlmaty = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const hm = t => String(t || "").slice(0, 5);
const startMs = (date, time) => Date.parse(`${date}T${hm(time)}:00+05:00`);
const ruDate = d => d.split("-").reverse().join(".");
const validPhone = p => /^\+7\d{10}$/.test(p || "");

function slotFromLesson(l, classes) {
  const cls = classes.get(l.classId);
  if (!cls) return null;                                          // group not in our list
  if (!cfg.classIds.length && cls.status !== "opened") return null; // auto mode: only groups with open enrolment
  if (l.status === 1) return null;                                // already held
  if (startMs(l.date, l.beginTime) - Date.now() < cfg.cutoffMs) return null; // too late to book
  const max = l.maxStudents || cls.maxStudents || 0;              // 0 = unlimited
  const taken = (l.records || []).filter(r => !r.skip).length;    // trial students count too
  return { lessonId: l.id, date: l.date, time: hm(l.beginTime), endTime: hm(l.endTime),
    title: cls.name || l.topic || "", free: !max || taken < max, max, taken };
}

async function fetchLessons(query) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const r = await mk("GET", "/lessons", { query: { ...query, includeRecords: true, limit: 500, offset } });
    const page = r.lessons || [];
    all.push(...page);
    if (page.length < 500) return all;
  }
}

async function loadSchedule() {
  const from = todayAlmaty(), to = addDays(from, cfg.days - 1);
  const [classes, lessons] = await Promise.all([
    getClasses(),
    fetchLessons({ date: [from, to], classId: cfg.classIds, filialId: cfg.filialIds, statusId: 0 }),
  ]);
  const days = {};
  for (let i = 0; i < cfg.days; i++) days[addDays(from, i)] = [];
  for (const l of lessons) {
    const s = slotFromLesson(l, classes);
    if (s && days[s.date]) days[s.date].push({ lessonId: s.lessonId, date: s.date, time: s.time, endTime: s.endTime, title: s.title, free: s.free });
  }
  for (const d in days) days[d].sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  return { today: from, days };
}

// ---- signed cancel links: no storage needed ----
const sign = id => crypto.createHmac("sha256", cfg.secret).update("cancel:" + id).digest("base64url").slice(0, 22);
const cancelToken = recordId => `${recordId}.${sign(recordId)}`;
function recordIdFromToken(t) {
  const m = String(t || "").match(/^(\d+)\.([A-Za-z0-9_-]{22})$/);
  if (!m) return 0;
  const a = Buffer.from(sign(m[1])), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? parseInt(m[1], 10) : 0;
}

// ---- booking ----
async function findUser(phone) {
  const digits = phone.slice(1);
  const found = await mk("GET", "/users", { query: { phone: digits, limit: 10 } });
  return (found.users || []).find(u => String(u.phone || "").replace(/\D/g, "") === digits) || null;
}
async function hasTrial(userId) {
  const r = await mk("GET", "/lessonRecords", { query: { userId: [userId], test: true, limit: 1 } });
  return (r.lessonRecords || []).length > 0;
}
let trialStatus = cfg.joinStatusId;
async function joinStatusId() {
  if (trialStatus) return trialStatus;
  const list = await mk("GET", "/joinStatuses", {});
  const s = (Array.isArray(list) ? list : []).find(x => /проб/i.test(x.name || ""));
  if (!s) throw new Error("No trial join status found in МойКласс. Set MOYKLASS_JOIN_STATUS_ID.");
  return (trialStatus = s.id);
}

async function book({ name, phone, lessonId, ig }) {
  const classes = await getClasses();
  const [lesson] = await fetchLessons({ lessonId: [lessonId] });
  const slot = lesson && slotFromLesson(lesson, classes);
  if (!slot || lesson.date > addDays(todayAlmaty(), cfg.days - 1)) return { code: 409, error: "gone" };
  if (!slot.free) return { code: 409, error: "taken" };

  const source = ig ? cfg.sourceIdIg : cfg.sourceId;
  const existing = await findUser(phone);
  let userId;
  if (existing) {
    userId = existing.id;
    if (await hasTrial(userId)) return { code: 409, error: "used" }; // one trial per number
    if ((lesson.records || []).some(r => r.userId === userId)) return { code: 409, error: "already" };
  } else {
    userId = (await mk("POST", "/users", { body: { name, phone: phone.slice(1), ...(source ? { advSourceId: source } : {}) } })).id;
  }

  // МойКласс only books a lesson for students who are in its group, so add them to the group first
  const note = `Пробный урок с сайта: ${ruDate(slot.date)} ${slot.time}${ig ? ", Instagram " + ig : ""}`;
  const j = await mk("GET", "/joins", { query: { userId, classId: lesson.classId } });
  if (!(j.joins || []).length)
    await mk("POST", "/joins", { body: { userId, classId: lesson.classId, statusId: await joinStatusId(),
      autoJoin: false, comment: note, ...(source ? { advSourceId: source } : {}) } });

  const record = await mk("POST", "/lessonRecords", { body: { userId, lessonId, test: true } });

  // Two people may book the last place at the same moment on different instances:
  // re-check, and if the lesson is now over capacity, the later record gives way.
  if (slot.max) {
    const [after] = await fetchLessons({ lessonId: [lessonId] });
    const active = (after && after.records || []).filter(r => !r.skip).sort((a, b) => a.id - b.id);
    if (active.length > slot.max && active.slice(slot.max).some(r => r.id === record.id)) {
      await mk("DELETE", `/lessonRecords/${record.id}`).catch(e => console.error(e.message));
      return { code: 409, error: "taken" };
    }
  }
  return { code: 200, booking: { recordId: record.id, date: slot.date, time: slot.time, title: slot.title, name, phone, ig } };
}

// ---- reading a record back (for cancel page and reminders) ----
async function recordInfo(recordId) {
  let rec;
  try { rec = await mk("GET", `/lessonRecords/${recordId}`, { query: { includeLesson: true } }); }
  catch (e) { if (e instanceof MkError && e.status === 404) return null; throw e; }
  const lesson = rec.lesson || (await fetchLessons({ lessonId: [rec.lessonId] }))[0];
  if (!lesson) return null;
  const [user, classes] = await Promise.all([mk("GET", `/users/${rec.userId}`).catch(() => null), getClasses()]);
  const cls = classes.get(lesson.classId);
  return { recordId, date: lesson.date, time: hm(lesson.beginTime), title: (cls && cls.name) || lesson.topic || "",
    name: (user && user.name) || "", phone: user && user.phone ? "+" + String(user.phone).replace(/\D/g, "") : "" };
}

// ---- messages ----
const lessonText = b => `${b.title ? b.title + ", " : ""}${ruDate(b.date)} в ${b.time}`;
const baseUrl = req => cfg.publicUrl || (req && req.headers.host ? `https://${req.headers.host}` : "");
const cancelRule = (b, req) => {
  const base = baseUrl(req);
  return base
    ? `Отменить запись можно не позже чем за ${cutoffText} до урока: ${base}/cancel?t=${cancelToken(b.recordId)}\nПозже пробный урок сгорает.`
    : `Если планы изменятся, напишите нам не позже чем за ${cutoffText} до урока, позже пробный урок сгорает.`;
};

// ---- HTTP helpers ----
function json(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;          // parsed by Vercel
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise(ok => {
    let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } });
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

module.exports = {
  cfg, checkConfig, cutoffText, mk, MkError, getClasses, fetchLessons, loadSchedule, book, recordInfo,
  recordIdFromToken, cancelToken, sendWhatsApp, notifyAdmins, safe, lessonText, cancelRule, baseUrl,
  todayAlmaty, addDays, startMs, hm, ruDate, validPhone, json, readBody, esc,
};
