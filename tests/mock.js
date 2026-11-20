// Мок API МойКласс и GREEN-API на локальном порту для интеграционных тестов.
// Хранит всё в памяти (db), записывает каждый запрос (db.requests) и каждое сообщение WhatsApp (db.whatsapp).
const http = require("http");

const API_KEY = "test-key";

function freshDb() {
  return {
    token: "tok-1", tokensIssued: 0, seq: 1000,
    filials: [{ id: 1, status: "active", name: "Главный" }],
    rooms: [
      { id: 5, filialId: 1, status: "active", name: "Вокал" },
      { id: 6, filialId: 1, status: "active", name: "Гитара-1" },
      { id: 7, filialId: 1, status: "active", name: "Гитара-2" },
      { id: 9, filialId: 1, status: "archive", name: "Старый" },
    ],
    classes: [
      { id: 20, filialId: 1, status: "opened", name: "Вокал" },
      { id: 21, filialId: 1, status: "opened", name: "Гитара" },
      { id: 22, filialId: 1, status: "opened", name: "Фортепиано" },
    ],
    joinStatuses: [{ id: 2, name: "Учится" }, { id: 41075, name: "Записан" }, { id: 77, name: "Пробное" }],
    advSources: [{ id: 3, name: "Сайт" }],
    users: [], joins: [], lessons: [],
    requests: [], whatsapp: [],
    createDelayMs: 0,      // задержка POST /lessons (для гонки)
    requireTeacher: false, // POST /lessons без teacherIds → 400
  };
}

function start() {
  let db = freshDb();
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : {};
    db.requests.push({ method: req.method, path: url.pathname, search: url.search, body });
    const send = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    const q = url.searchParams;
    const all = k => q.getAll(k).map(Number);

    // ---- GREEN-API ----
    const wa = url.pathname.match(/^\/waInstance(\w+)\/sendMessage\/(\w+)$/);
    if (wa) { db.whatsapp.push({ chatId: body.chatId, message: body.message }); return send(200, { idMessage: "m" + db.whatsapp.length }); }

    // ---- МойКласс ----
    const p = url.pathname.replace(/^\/v1\/company/, "");
    if (p === "/auth/getToken" && req.method === "POST") {
      if (body.apiKey !== API_KEY) return send(400, { code: "ApiKeyInvalid" });
      db.tokensIssued++;
      return send(200, { accessToken: db.token });
    }
    if (req.headers["x-access-token"] !== db.token) return send(401, { code: "Unauthorized" });
    if (db.tooMany > 0) { db.tooMany--; return send(429, { code: "TooManyRequests" }); } // лимит частоты

    const records = () => db.lessons.flatMap(l => l.records);
    const lessonOut = l => q.get("includeRecords") === "true" ? l : (({ records, ...rest }) => rest)(l);
    let m;

    if (req.method === "GET" && p === "/classes") return send(200, db.classes);
    if (req.method === "GET" && p === "/filials") return send(200, db.filials);
    if (req.method === "GET" && p === "/rooms") return send(200, db.rooms);
    if (req.method === "GET" && p === "/joinStatuses") return send(200, db.joinStatuses);
    if (req.method === "GET" && p === "/advSources") return send(200, db.advSources);

    if (req.method === "GET" && p === "/users") {
      let u = db.users;
      if (q.get("phone")) u = u.filter(x => x.phone.includes(q.get("phone")));
      if (q.getAll("userIds").length) u = u.filter(x => all("userIds").includes(x.id));
      return send(200, { users: u, stats: { totalItems: u.length } });
    }
    if (req.method === "POST" && p === "/users") {
      const u = { id: ++db.seq, name: body.name, phone: body.phone, advSourceId: body.advSourceId };
      db.users.push(u); return send(200, u);
    }
    if ((m = p.match(/^\/users\/(\d+)$/)) && req.method === "GET") {
      const u = db.users.find(x => x.id === +m[1]); return u ? send(200, u) : send(404, { code: "NotFound" });
    }
    if (req.method === "GET" && p === "/joins")
      return send(200, { joins: db.joins.filter(j => (!q.get("userId") || j.userId === +q.get("userId")) && (!q.get("classId") || j.classId === +q.get("classId"))) });
    if (req.method === "POST" && p === "/joins") { const j = { id: ++db.seq, ...body }; db.joins.push(j); return send(200, j); }

    if (req.method === "GET" && p === "/lessonRecords") {
      let r = records();
      if (q.getAll("userId").length) r = r.filter(x => all("userId").includes(x.userId));
      if (q.get("test") === "true") r = r.filter(x => x.test);
      return send(200, { lessonRecords: r.slice(0, +(q.get("limit") || 100)) });
    }
    if ((m = p.match(/^\/lessonRecords\/(\d+)$/))) {
      const l = db.lessons.find(x => x.records.some(r => r.id === +m[1]));
      if (!l) return send(404, { code: "NotFound" });
      if (req.method === "GET") return send(200, l.records.find(r => r.id === +m[1]));
      if (req.method === "DELETE") { l.records = l.records.filter(r => r.id !== +m[1]); return send(200, {}); }
    }

    if (req.method === "GET" && p === "/lessons") {
      let l = db.lessons;
      const dates = q.getAll("date");
      if (dates.length === 2) l = l.filter(x => x.date >= dates[0] && x.date <= dates[1]);
      if (dates.length === 1) l = l.filter(x => x.date === dates[0]);
      if (q.getAll("lessonId").length) l = l.filter(x => all("lessonId").includes(x.id));
      if (q.getAll("classId").length) l = l.filter(x => all("classId").includes(x.classId));
      if (q.has("statusId")) l = l.filter(x => x.status === +q.get("statusId"));
      const off = +(q.get("offset") || 0), lim = +(q.get("limit") || 100);
      return send(200, { lessons: l.slice(off, off + lim).map(lessonOut), stats: { totalItems: l.length } });
    }
    if (req.method === "POST" && p === "/lessons") {
      for (const k of ["date", "beginTime", "endTime", "filialId", "classId"]) if (!body[k]) return send(400, { code: "BadRequest", message: k + " required" });
      if (db.requireTeacher && !(body.teacherIds || []).length) return send(400, { code: "BadRequest", message: "teacherIds is required" });
      if (db.createDelayMs) await new Promise(r => setTimeout(r, db.createDelayMs));
      const id = ++db.seq;
      const lesson = { id, date: body.date, beginTime: body.beginTime, endTime: body.endTime, filialId: body.filialId,
        roomId: body.roomId || null, classId: body.classId, teacherIds: body.teacherIds || [], status: 0,
        maxStudents: body.maxStudents, topic: body.topic, comment: body.comment, records: [] };
      if (body.userId) lesson.records.push({ id: ++db.seq, userId: body.userId, lessonId: id, test: !!(body.lessonRecord || {}).test,
        skip: false, free: false, createdAt: new Date().toISOString() });
      db.lessons.push(lesson);
      return send(200, lesson);
    }
    if ((m = p.match(/^\/lessons\/(\d+)$/)) && req.method === "DELETE") {
      const before = db.lessons.length;
      db.lessons = db.lessons.filter(x => x.id !== +m[1]);
      return before === db.lessons.length ? send(404, { code: "NotFound" }) : send(200, {});
    }
    send(404, { code: "NoRoute", path: p });
  });

  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    get db() { return db; },
    reset() { db = freshDb(); return db; },
    // готовое занятие в расписании школы
    addLesson(l) {
      const lesson = { id: ++db.seq, status: 0, filialId: 1, teacherIds: [1], records: [], ...l };
      lesson.records = (l.records || []).map(r => ({ id: ++db.seq, lessonId: lesson.id, test: false, skip: false, createdAt: new Date(0).toISOString(), ...r }));
      db.lessons.push(lesson); return lesson;
    },
    addUser(u) { const user = { id: ++db.seq, ...u }; db.users.push(user); return user; },
    close: () => new Promise(r => server.close(r)),
  })));
}

module.exports = { start, API_KEY };
