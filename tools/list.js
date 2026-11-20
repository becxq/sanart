// Справочники МойКласс для настройки переменных окружения.
// Запуск из папки проекта:  node tools/list.js   (MOYKLASS_API_KEY берётся из .env)
const mk = require("../lib/moyklass");

async function show(title, load, line) {
  console.log(title);
  try { for (const x of await load()) console.log("  " + line(x)); }
  catch (e) { console.log("  (не удалось получить: " + e.message + ")"); }
  console.log("");
}

(async () => {
  await show("Группы — инструменты для MOYKLASS_TRIAL_GROUPS (id, статус, название):", mk.classes,
    g => `${g.id}\t${g.status}\t${g.name}`);
  await show("Филиалы (сайт работает с единственным активным):", mk.filials,
    f => `${f.id}\t${f.status ?? ""}\t${f.name}`);
  await show("Кабинеты — roomId для MOYKLASS_TRIAL_GROUPS (id, статус, название):", mk.rooms,
    r => `${r.id}\t${r.status ?? ""}\t${r.name}${r.filialId ? "\tфилиал " + r.filialId : ""}`);
  await show("Сотрудники — преподаватели для MOYKLASS_TRIAL_TEACHERS (id, работает, имя):", mk.managers,
    t => `${t.id}\t${t.isWork === false || t.enabled === false ? "не работает" : "работает"}\t${t.name}`);
  await show("Статусы записи в группу (MOYKLASS_JOIN_STATUS_ID):", mk.joinStatuses, s => `${s.id}\t${s.name}`);
  await show("Источники «откуда узнали» (MOYKLASS_SOURCE_ID, MOYKLASS_SOURCE_ID_IG):", mk.advSources, s => `${s.id}\t${s.name}`);
  console.log("Пример: MOYKLASS_TRIAL_GROUPS=163997:33466;164076:33469,33467;230182");
  console.log("        MOYKLASS_TRIAL_TEACHERS=164076:157384,229935;163997:242295;230182:242295");
})();
