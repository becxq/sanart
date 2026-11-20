// Мелочи для функций api/*: ответы, чтение тела запроса, адрес сайта, ответ об ошибке.
const config = require("./config");

function json(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function html(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

const query = req => new URL(req.url || "/", "http://localhost").searchParams;

// Тело запроса как объект. Vercel обычно уже разобрал JSON в req.body; sendBeacon может прислать строку.
async function readBody(req) {
  const parse = s => { try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string" || Buffer.isBuffer(req.body)) return parse(String(req.body));
  if (typeof req.on !== "function") return {};
  return new Promise(ok => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => ok(parse(s)));
    req.on("error", () => ok({}));
  });
}

// адрес сайта для ссылок в сообщениях: PUBLIC_URL или домен, на который пришёл запрос
const baseUrl = req => config.get().publicUrl || (req && req.headers && req.headers.host ? `https://${req.headers.host}` : "");

// Ответ об ошибке: называет причину (какие переменные, какой запрос к МойКласс), но не раскрывает секреты.
function errorInfo(e) {
  const { MkError, MkAuthError } = require("./moyklass");
  if (e instanceof config.ConfigError)
    return { error: "config", missing: e.missing, problems: e.problems,
      hint: "Проверьте переменные в Vercel → Project Settings → Environment Variables и сделайте Redeploy" };
  if (e instanceof MkAuthError) return { error: "crm-auth", hint: "МойКласс не принял MOYKLASS_API_KEY" };
  if (e instanceof MkError) return { error: "crm", status: e.status, detail: e.detail };
  return { error: "server" };
}
const errorCode = e => (e && e.name === "MkError") || (e && e.name === "MkAuthError") ? 502 : 500;

// записать в лог и ответить ошибкой
function fail(res, e) {
  console.error(e && e.stack || e);
  json(res, errorCode(e), errorInfo(e), { "Cache-Control": "no-store" });
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

module.exports = { json, html, query, readBody, baseUrl, errorInfo, fail, esc };
