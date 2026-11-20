// HTML страницы отмены записи (/cancel?t=…). Кнопка шлёт POST /api/cancel — сам GET ничего не отменяет.
const { esc } = require("./http");
const { lessonText } = require("./notify");

function cancelPage({ state, info, token, cutoff }) {
  const head = info ? `<p><b>${esc(info.name)}</b><br>${esc(lessonText(info))}</p>` : "";
  const body = {
    ask: `${head}<p class="mute">Отменить можно не позже чем за ${esc(cutoff)} до начала урока.</p>
      <button id="go">Отменить запись</button><p id="msg" class="err" role="alert"></p>`,
    late: `${head}<p>До урока меньше ${esc(cutoff)}, отменить запись уже нельзя. Пробный урок сгорает, если вы не придёте.</p>`,
    gone: `<p>Запись не найдена — возможно, она уже отменена. Если есть вопросы, напишите нам.</p>`,
    error: `<p>Не удалось загрузить запись. Обновите страницу чуть позже или напишите нам.</p>`,
  }[state];
  const script = state !== "ask" ? "" : `<script>
const T = ${JSON.stringify(String(token)).replace(/</g, "\\u003c")};
const box = document.getElementById("box");
document.getElementById("go").onclick = async function () {
  this.disabled = true; this.textContent = "Отменяем…";
  try {
    const r = await fetch("/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: T }) });
    const d = await r.json();
    if (r.ok) box.innerHTML = "<p>Запись отменена. Если захотите прийти в другой день, запишитесь снова на сайте.</p>";
    else if (d.error === "late") box.innerHTML = "<p>До урока меньше ${esc(cutoff)}, отменить запись уже нельзя.</p>";
    else if (d.error === "gone") box.innerHTML = "<p>Запись уже отменена.</p>";
    else throw 0;
  } catch (e) {
    this.disabled = false; this.textContent = "Отменить запись";
    document.getElementById("msg").textContent = "Не получилось. Попробуйте ещё раз или напишите нам.";
  }
};
</script>`;
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>sanart — отмена записи</title><link rel="icon" href="/logo.png"><style>
body{margin:0;background:#e8e8ea;color:#26262a;font-family:system-ui,sans-serif;line-height:1.5;border-top:8px solid #ffc21a}
@media (prefers-color-scheme:dark){body{background:#1d1d20;color:#f1f1f2}.card{background:#2a2a2e!important;border-color:#3f3f44!important}}
main{max-width:520px;margin:0 auto;padding:28px 18px}h1{font-size:26px;margin:0 0 16px}
.card{background:#f9f9f9;border:1px solid #cbcbd0;border-radius:24px;padding:18px}.mute{opacity:.7}.err{color:#d6455d}
button{width:100%;padding:15px;border:0;border-radius:999px;background:#ffc21a;color:#1f1f22;font:inherit;font-weight:800;font-size:17px;cursor:pointer}
button:disabled{opacity:.5}</style></head><body><main><h1>Отмена записи</h1><div class="card" id="box">${body}</div></main>
${script}</body></html>`;
}

module.exports = { cancelPage };
