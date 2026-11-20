// Клиент API МойКласс (https://api.moyklass.com/v1/company).
//  - токен: POST /auth/getToken {apiKey} → accessToken, заголовок x-access-token; при 401 — новый токен и один повтор;
//  - массивы в query — повторяющимися ключами (date=a&date=b), не через запятую;
//  - списки занятий — постранично, limit=500/offset;
//  - справочники (группы, филиалы, кабинеты, статусы) хранятся в памяти функции 10 минут.
const config = require("./config");

class MkError extends Error {
  constructor(method, path, status, text) {
    super(`МойКласс ${method} ${path} → ${status} ${String(text).slice(0, 300)}`);
    this.name = "MkError";
    this.status = status;
    this.detail = `${method} ${path} ${status} ${String(text).slice(0, 200)}`;
  }
}
class MkAuthError extends Error {
  constructor(status, text) { super(`МойКласс getToken → ${status} ${String(text).slice(0, 200)}`); this.name = "MkAuthError"; this.status = status; }
}

function settings() {
  const c = config.get();
  if (!c.apiKey) throw new config.ConfigError("MOYKLASS_API_KEY не задана", { missing: ["MOYKLASS_API_KEY"] });
  return c;
}

// {date: ["a","b"], limit: 5} → "date=a&date=b&limit=5"; пустые значения пропускаются
function buildQuery(query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
  }
  return qs.toString();
}

const RETRY_429 = [1000, 2000]; // паузы перед повторами при 429 (мс)
let token = null;        // живёт, пока экземпляр функции «тёплый»
let tokenPending = null; // один запрос токена на всех: параллельные запросы ждут его, а не просят свой
function getToken(c) {
  if (!tokenPending) tokenPending = fetchToken(c).finally(() => { tokenPending = null; });
  return tokenPending;
}
async function fetchToken(c) {
  const r = await fetch(c.apiUrl + "/auth/getToken", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: c.apiKey }),
  });
  const text = await r.text();
  if (!r.ok) throw new MkAuthError(r.status, text);
  try { token = JSON.parse(text).accessToken; } catch { token = null; }
  if (!token) throw new MkAuthError(r.status, "нет accessToken в ответе");
  return token;
}

async function request(method, path, { query, body } = {}) {
  const c = settings();
  const q = buildQuery(query);
  const send = async () => fetch(c.apiUrl + path + (q ? "?" + q : ""), {
    method,
    headers: { "Content-Type": "application/json", "x-access-token": token || await getToken(c) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await send();
  if (r.status === 401) { token = null; r = await send(); } // токен истёк: один повтор с новым
  // МойКласс ограничивает частоту запросов (429): ждём Retry-After или 1 и 2 с, до двух повторов
  for (let i = 0; r.status === 429 && i < RETRY_429.length; i++) {
    const after = Number(r.headers.get("retry-after"));
    await new Promise(ok => setTimeout(ok, Number.isFinite(after) && after > 0 ? Math.min(after, 5) * 1000 : RETRY_429[i]));
    r = await send();
  }
  const text = await r.text();
  if (!r.ok) throw new MkError(method, path, r.status, text);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

const asList = (r, key) => Array.isArray(r) ? r : (r && Array.isArray(r[key]) ? r[key] : []);

// занятия с постраничной загрузкой; includeRecords — добавить записи учеников
async function lessons(query, { includeRecords = false } = {}) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const page = asList(await request("GET", "/lessons",
      { query: { ...query, ...(includeRecords ? { includeRecords: true } : {}), limit: 500, offset } }), "lessons");
    all.push(...page);
    if (page.length < 500) return all;
  }
}

// ---- справочники с кэшем ----
const TTL = 10 * 60e3;
const cache = new Map();
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const classes = () => cached("classes", async () => asList(await request("GET", "/classes"), "classes"));
const filials = () => cached("filials", async () => asList(await request("GET", "/filials"), "filials"));
const rooms = () => cached("rooms", async () => asList(await request("GET", "/rooms"), "rooms"));
const managers = () => cached("managers", async () => asList(await request("GET", "/managers"), "managers")); // сотрудники и преподаватели
const joinStatuses = () => cached("joinStatuses", async () => asList(await request("GET", "/joinStatuses"), "joinStatuses"));
const advSources = async () => asList(await request("GET", "/advSources"), "advSources");

const isActive = x => x.status === undefined || x.status === "active" || x.status === true || x.status === 1;

// Филиал, группы, кабинеты и преподаватели для пробных уроков по MOYKLASS_TRIAL_GROUPS и MOYKLASS_TRIAL_TEACHERS:
// { filialId, groups: [{ classId, name, roomIds, teacherIds }] } в порядке из настроек.
// teacherIds пуст — урок создаётся без преподавателя.
// Неизвестная группа, неактивный кабинет, неизвестный или уволенный преподаватель, не один активный филиал
// → ConfigError с пояснением.
async function trialSetup() {
  const cfg = config.check();
  const [cls, fil, rms, mgr] = await Promise.all([classes(), filials(), rooms(),
    cfg.trialTeachers.length ? managers() : []]);
  const problems = [];
  const active = fil.filter(isActive);
  if (active.length !== 1)
    throw new config.ConfigError(`Активных филиалов: ${active.length}, нужен ровно один`,
      { problems: [`В МойКласс ${active.length} активных филиалов (${active.map(f => f.id).join(", ") || "нет"}), сайт работает с одним`] });
  const filialId = active[0].id;
  const filialRooms = rms.filter(r => (!r.filialId || r.filialId === filialId));
  const activeRooms = filialRooms.filter(isActive).map(r => r.id);

  const groups = [];
  for (const g of cfg.trialGroups) {
    const c = cls.find(x => x.id === g.classId);
    if (!c) { problems.push(`MOYKLASS_TRIAL_GROUPS: группы ${g.classId} нет в МойКласс`); continue; }
    if (c.filialId && c.filialId !== filialId) problems.push(`MOYKLASS_TRIAL_GROUPS: группа ${g.classId} из другого филиала`);
    for (const r of g.roomIds) {
      const room = filialRooms.find(x => x.id === r);
      if (!room) problems.push(`MOYKLASS_TRIAL_GROUPS: кабинета ${r} (группа ${g.classId}) нет в филиале ${filialId}`);
      else if (!isActive(room)) problems.push(`MOYKLASS_TRIAL_GROUPS: кабинет ${r} «${room.name}» (группа ${g.classId}) не активен`);
    }
    const roomIds = g.roomIds.length ? g.roomIds : activeRooms;
    if (!roomIds.length) problems.push(`Для группы ${g.classId} нет ни одного активного кабинета`);
    const teacherIds = (cfg.trialTeachers.find(t => t.classId === g.classId) || { teacherIds: [] }).teacherIds;
    for (const id of teacherIds) {
      const t = mgr.find(x => x.id === id);
      if (!t) problems.push(`MOYKLASS_TRIAL_TEACHERS: преподавателя ${id} (группа ${g.classId}) нет в МойКласс`);
      else if (t.enabled === false || t.isWork === false || t.blocked === true)
        problems.push(`MOYKLASS_TRIAL_TEACHERS: преподаватель ${id} «${t.name}» (группа ${g.classId}) не работает или заблокирован`);
    }
    groups.push({ classId: g.classId, name: c.name || `Группа ${g.classId}`, roomIds, teacherIds });
  }
  for (const t of cfg.trialTeachers)
    if (!cfg.trialGroups.some(g => g.classId === t.classId))
      problems.push(`MOYKLASS_TRIAL_TEACHERS: группы ${t.classId} нет в MOYKLASS_TRIAL_GROUPS`);
  if (problems.length) throw new config.ConfigError("Ошибка в MOYKLASS_TRIAL_GROUPS", { problems });
  return { filialId, groups };
}

// статус записи в группу для пробного: MOYKLASS_JOIN_STATUS_ID или статус со словом «Проб»
async function trialJoinStatusId() {
  const id = config.get().joinStatusId;
  if (id) return id;
  const s = (await joinStatuses()).find(x => /проб/i.test(x.name || ""));
  if (!s) throw new config.ConfigError("Не найден статус записи для пробного",
    { problems: ["В МойКласс нет статуса записи в группу со словом «Проб» — задайте MOYKLASS_JOIN_STATUS_ID (список: node tools/list.js)"] });
  return s.id;
}

const _reset = () => { token = null; cache.clear(); }; // для тестов
const _setRetryDelays = (...ms) => RETRY_429.splice(0, RETRY_429.length, ...ms); // для тестов

module.exports = { request, lessons, classes, filials, rooms, managers, joinStatuses, advSources, trialSetup, trialJoinStatusId,
  buildQuery, asList, MkError, MkAuthError, _reset, _setRetryDelays };
