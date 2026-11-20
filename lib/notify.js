// WhatsApp через GREEN-API и тексты всех сообщений.
// Если GREEN_URL / GREEN_ID / GREEN_TOKEN не заданы — сообщения молча не отправляются.
// Отправку дожидаемся до ответа (Vercel замораживает функцию после ответа), но ошибка WhatsApp запись не ломает.
const config = require("./config");
const { ruDate } = require("./time");
const sign = require("./sign");

// номер телефона → "77011234567@c.us"; id группы "...@g.us" остаётся как есть
const chatId = to => to.includes("@") ? to : String(to).replace(/\D/g, "") + "@c.us";

async function sendWhatsApp(to, text) {
  const g = config.get().green;
  if (!g || !to) return false;
  const r = await fetch(`${g.url}/waInstance${g.id}/sendMessage/${g.token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chatId(to), message: text }),
  });
  if (!r.ok) throw new Error(`WhatsApp ${r.status} ${(await r.text()).slice(0, 200)}`);
  return true;
}
// отправить и не упасть: ошибка только в лог
const safeSend = (to, text) => sendWhatsApp(to, text).catch(e => { console.error(e.message); return false; });
const notifyAdmins = text => Promise.all(config.get().admins.map(a => safeSend(a, text)));

// ---- тексты ----
// b: { title, date, time, recordId, name, phone, ig }
const lessonText = b => `${b.title ? b.title + ", " : ""}${ruDate(b.date)} в ${b.time}`;
const cutoffText = () => `${config.get().cutoffHours} ч`;
const cancelUrl = (base, recordId) => `${base}/cancel?t=${sign.cancelToken(recordId)}`;
const cancelRule = (b, base) => base
  ? `Отменить запись можно не позже чем за ${cutoffText()} до урока: ${cancelUrl(base, b.recordId)}\nПозже пробный урок сгорает.`
  : `Если планы изменятся, напишите нам не позже чем за ${cutoffText()} до урока, позже пробный урок сгорает.`;

const texts = {
  bookedClient: (b, base) => `${b.name}, вы записаны на пробный урок в SanArt: ${lessonText(b)}. Ждём вас!\n${cancelRule(b, base)}`,
  bookedAdmin: b => `Новая запись на пробный урок:\n${b.name}, ${b.phone}\n${lessonText(b)}${b.ig ? "\nИз Instagram: " + b.ig : ""}`,
  cancelledClient: b => `${b.name}, ваша запись на пробный урок (${lessonText(b)}) отменена. Будем рады видеть вас в другой день!`,
  cancelledAdmin: b => `Отмена пробного урока:\n${b.name}, ${b.phone}\n${lessonText(b)}`,
  reminder: (b, when, base) => `${b.name}, напоминаем: ${when} у вас пробный урок в SanArt — ${lessonText(b)}. Ждём вас!\n${cancelRule(b, base)}`,
  lead: l => `Не завершил запись на пробный урок (ушёл со страницы) — перезвоните:\n${l.name}, ${l.phone}${l.ig ? "\nInstagram: " + l.ig : ""}`,
};

module.exports = { sendWhatsApp, safeSend, notifyAdmins, lessonText, cutoffText, cancelUrl, cancelRule, texts, chatId };
