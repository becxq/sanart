// GET  /cancel?t=...  (rewritten to /api/cancel) — page with the booking and a «Отменить» button.
//      GET never cancels: WhatsApp link previews open links too.
// POST /api/cancel {t} — cancels the trial record in МойКласс if it's not too late.
const c = require("../lib/core");

function page(info, state, t) {
  const head = info ? `<p><b>${c.esc(info.name)}</b><br>${c.esc(c.lessonText(info))}</p>` : "";
  const body = {
    ask: `${head}<p class="mute">Отменить можно не позже чем за ${c.cutoffText} до начала урока.</p>
      <button id="go">Отменить запись</button><p id="msg" class="err"></p>`,
    late: `${head}<p>До урока меньше ${c.cutoffText}, отменить запись уже нельзя. Пробный урок сгорает, если вы не придёте.</p>`,
    gone: `<p>Запись не найдена — возможно, она уже отменена. Если есть вопросы, напишите нам.</p>`,
    error: `<p>Не удалось загрузить запись. Обновите страницу чуть позже или напишите нам.</p>`,
  }[state];
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>sanart — отмена записи</title><style>
body{margin:0;background:#e8e8ea;color:#26262a;font-family:system-ui,sans-serif;line-height:1.5;border-top:8px solid #ffc21a}
@media (prefers-color-scheme:dark){body{background:#1d1d20;color:#f1f1f2}.card{background:#2a2a2e!important;border-color:#3f3f44!important}}
main{max-width:520px;margin:0 auto;padding:28px 18px}h1{font-size:26px;margin:0 0 16px}
.card{background:#f9f9f9;border:1px solid #cbcbd0;border-radius:24px;padding:18px}.mute{opacity:.7}.err{color:#d6455d}
button{width:100%;padding:15px;border:0;border-radius:999px;background:#ffc21a;color:#1f1f22;font:inherit;font-weight:800;font-size:17px;cursor:pointer}
button:disabled{opacity:.5}</style></head><body><main><h1>Отмена записи</h1><div class="card" id="box">${body}</div></main>
${state === "ask" ? `<script>
document.getElementById("go").onclick = async function(){
  this.disabled = true; this.textContent = "Отменяем…";
  try{
    const r = await fetch("/api/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t:${JSON.stringify(t)}})});
    const d = await r.json();
    if(r.ok) document.getElementById("box").innerHTML = "<p>Запись отменена. Если захотите прийти в другой день, запишитесь снова на сайте.</p>";
    else if(d.error==="late") document.getElementById("box").innerHTML = "<p>До урока меньше ${c.cutoffText}, отменить запись уже нельзя.</p>";
    else if(d.error==="gone") document.getElementById("box").innerHTML = "<p>Запись уже отменена.</p>";
    else throw 0;
  }catch(e){ this.disabled = false; this.textContent = "Отменить запись"; document.getElementById("msg").textContent = "Не получилось. Попробуйте ещё раз или напишите нам."; }
};
</script>` : ""}</body></html>`;
}

module.exports = async (req, res) => {
  const isPost = req.method === "POST";
  const t = isPost ? (await c.readBody(req)).t : new URL(req.url, "http://x").searchParams.get("t");
  const recordId = c.recordIdFromToken(t);

  let info = null, state;
  try {
    c.checkConfig();
    info = recordId ? await c.recordInfo(recordId) : null;
    state = !info ? "gone" : c.startMs(info.date, info.time) - Date.now() < c.cfg.cutoffMs ? "late" : "ask";
  } catch (e) { console.error(e.message); state = "error"; }

  if (!isPost) {
    res.statusCode = state === "gone" ? 404 : 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(page(info, state, t));
  }

  if (state === "error") return c.json(res, 502, { error: "crm" });
  if (state !== "ask") return c.json(res, 409, { error: state });
  try {
    if (!(await c.cancelRecord(info))) return c.json(res, 409, { error: "gone" });
  } catch (e) {
    console.error(e.message); return c.json(res, 502, c.errorInfo(e));
  }
  await Promise.all([
    info.phone ? c.safe(c.sendWhatsApp(info.phone, `${info.name}, ваша запись на пробный урок (${c.lessonText(info)}) отменена. Будем рады видеть вас в другой день!`)) : null,
    c.notifyAdmins(`Отмена пробного урока:\n${info.name}, ${info.phone}\n${c.lessonText(info)}`),
  ]);
  c.json(res, 200, { ok: true });
};
