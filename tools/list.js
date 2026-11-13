// Local helper: prints groups, join statuses and client sources from МойКласс.
// Run from the project folder:  node tools/list.js   (reads MOYKLASS_API_KEY from .env)
const c = require("../lib/core");
(async () => {
  const show = async (title, p, line) => {
    try { const list = await c.mk("GET", p, {}); console.log(title); for (const x of list) console.log("  " + line(x)); }
    catch (e) { console.log(title + "\n  (не удалось получить: " + e.message + ")"); }
    console.log("");
  };
  await show("Группы (MOYKLASS_CLASS_IDS):", "/classes", g => `${g.id}\t${g.status}\tмест: ${g.maxStudents || "∞"}\t${g.name}`);
  await show("Статусы записи в группу (MOYKLASS_JOIN_STATUS_ID):", "/joinStatuses", s => `${s.id}\t${s.name}`);
  await show("Источники, откуда узнали (MOYKLASS_SOURCE_ID, MOYKLASS_SOURCE_ID_IG):", "/advSources", s => `${s.id}\t${s.name}`);
})();
