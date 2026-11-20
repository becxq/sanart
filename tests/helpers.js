// Общее для интеграционных тестов: окружение под мок и вызов функций api/* напрямую.
process.env.SANART_NO_DOTENV = "1"; // настоящий .env в тестах не читаем — никаких реальных запросов и WhatsApp
const mock = require("./mock");
const config = require("../lib/config");
const mk = require("../lib/moyklass");

const KEYS = /^(MOYKLASS_|GREEN_|SIGNING_|CRON_|WORK_|TRIAL_|SLOT_|BOOKING_|SEARCH_|REMINDER_|PUBLIC_|ADMIN_)/;

function setEnv(m, extra = {}) {
  for (const k of Object.keys(process.env)) if (KEYS.test(k)) delete process.env[k];
  Object.assign(process.env, {
    MOYKLASS_API_URL: m.url, MOYKLASS_API_KEY: mock.API_KEY, SIGNING_SECRET: "test-secret",
    MOYKLASS_TRIAL_GROUPS: "20:5;21:6,7;22", MOYKLASS_JOIN_STATUS_ID: "41075", MOYKLASS_SOURCE_ID: "3", MOYKLASS_SOURCE_ID_IG: "4",
    GREEN_URL: m.url, GREEN_ID: "111", GREEN_TOKEN: "tok", ADMIN_WHATSAPP: "77000000001,123-456@g.us",
    CRON_SECRET: "cron-secret", PUBLIC_URL: "https://book.example",
  }, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
  config.reset();
  mk._reset();
}

// вызвать обработчик Vercel как функцию: (req, res) → { status, headers, body, json }
async function call(handler, { method = "GET", url = "/", body, headers = {} } = {}) {
  const req = { method, url, headers: { host: "test.local", ...headers }, body };
  const res = {
    statusCode: 200, headers: {}, body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s || ""; },
  };
  await handler(req, res);
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

module.exports = { setEnv, call, mock };
