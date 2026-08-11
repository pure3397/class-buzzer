const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const clients = new Set();

const state = {
  roomCode: "CLASS",
  phase: "lobby",
  material: {
    type: "note",
    title: "클래스 버저",
    content: "자료 링크나 짧은 문제 메모를 넣고 수업을 시작하세요.",
    page: 1,
  },
  settings: {
    playMode: "team",
    rankingLimit: 5,
    winnerCooldown: true,
  },
  buzzerOpen: false,
  firstBuzz: null,
  buzzQueue: [],
  cooldownStudentId: null,
  roundCooldownStudentId: null,
  lastAward: null,
  students: {},
  events: [],
};

const profanityHints = [
  "ㅅㅂ",
  "시발",
  "씨발",
  "병신",
  "ㅂㅅ",
  "존나",
  "꺼져",
  "개새",
  "fuck",
  "shit",
];

function now() {
  return new Date().toISOString();
}

function publicState() {
  return {
    ...state,
    students: Object.values(state.students).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.alias.localeCompare(b.alias, "ko");
    }),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function addEvent(message) {
  state.events.unshift({ id: crypto.randomUUID(), at: now(), message });
  state.events = state.events.slice(0, 8);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeAlias(alias) {
  return String(alias || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
}

function hasProfanity(alias) {
  const compact = alias.toLowerCase().replace(/\s+/g, "");
  return profanityHints.some((word) => compact.includes(word));
}

function getStudent(studentId) {
  if (!studentId || !state.students[studentId]) {
    return null;
  }
  return state.students[studentId];
}

function unitLabel() {
  return state.settings.playMode === "individual" ? "학생" : "팀";
}

function removeFromQueue(studentId) {
  state.buzzQueue = state.buzzQueue.filter((buzz) => buzz.studentId !== studentId);
  if (state.firstBuzz?.studentId === studentId) {
    state.firstBuzz = state.buzzQueue[0] || null;
    state.phase = state.firstBuzz ? "winner" : state.phase;
  }
}

function resetRound(phase = "material") {
  state.phase = phase;
  state.buzzerOpen = false;
  state.firstBuzz = null;
  state.buzzQueue = [];
  state.roundCooldownStudentId = null;
  for (const student of Object.values(state.students)) {
    student.buzzedAt = null;
  }
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/state") {
    return sendJson(res, 200, publicState());
  }

  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method !== "POST") {
    return sendJson(res, 404, { error: "Not found" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: "JSON을 읽을 수 없습니다." });
  }

  if (req.url === "/api/join") {
    const alias = normalizeAlias(body.alias);
    if (alias.length < 2) {
      return sendJson(res, 400, { error: "이름은 2글자 이상이어야 합니다." });
    }
    if (hasProfanity(alias)) {
      return sendJson(res, 400, { error: "다른 별칭을 사용해 주세요." });
    }
    const duplicate = Object.values(state.students).find(
      (student) => student.alias === alias && student.status !== "rejected"
    );
    if (duplicate) {
      return sendJson(res, 409, { error: "이미 사용 중인 이름입니다." });
    }

    const id = crypto.randomUUID();
    state.students[id] = {
      id,
      alias,
      status: "pending",
      score: 0,
      joinedAt: now(),
      buzzedAt: null,
    };
    addEvent(`${alias} 입장 승인 대기`);
    broadcast();
    return sendJson(res, 200, { studentId: id, state: publicState() });
  }

  if (req.url === "/api/student/buzz") {
    const student = getStudent(body.studentId);
    if (!student) return sendJson(res, 404, { error: "참가자를 찾을 수 없습니다." });
    if (student.status !== "approved") {
      return sendJson(res, 403, { error: "아직 승인되지 않았습니다." });
    }
    if (student.id === state.roundCooldownStudentId) {
      return sendJson(res, 403, { error: "이번 문제는 쉬어가는 차례입니다." });
    }
    if (!state.buzzerOpen) {
      return sendJson(res, 409, { error: "지금은 버저를 누를 수 없습니다." });
    }
    if (state.buzzQueue.some((buzz) => buzz.studentId === student.id)) {
      return sendJson(res, 409, { error: "이미 대기열에 들어갔습니다." });
    }

    const buzz = { studentId: student.id, alias: student.alias, at: now() };
    student.buzzedAt = buzz.at;
    state.buzzQueue.push(buzz);
    if (!state.firstBuzz) state.firstBuzz = buzz;
    state.phase = "winner";
    addEvent(`${student.alias} 버저 대기열 ${state.buzzQueue.length}번`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/material") {
    const type = ["note", "link", "pdf", "image"].includes(body.type) ? body.type : "note";
    state.material = {
      type,
      title: String(body.title || "문제 자료").trim().slice(0, 80),
      content: String(body.content || "").trim(),
      page: 1,
    };
    resetRound("material");
    state.lastAward = null;
    addEvent("문제 자료 화면으로 전환");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/material-page") {
    const requestedPage = Number.parseInt(body.page, 10);
    const delta = Number.parseInt(body.delta, 10);
    const nextPage = Number.isFinite(requestedPage)
      ? requestedPage
      : state.material.page + (Number.isFinite(delta) ? delta : 0);
    state.material.page = Math.max(1, nextPage);
    state.phase = "material";
    state.buzzerOpen = false;
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/settings") {
    const rankingLimit = Number.parseInt(body.rankingLimit, 10);
    state.settings.playMode = body.playMode === "individual" ? "individual" : "team";
    state.settings.rankingLimit = Number.isFinite(rankingLimit)
      ? Math.min(20, Math.max(1, rankingLimit))
      : state.settings.rankingLimit;
    state.settings.winnerCooldown = body.winnerCooldown === false ? false : body.winnerCooldown === "false" ? false : true;
    addEvent(`랭킹 표시 상위 ${state.settings.rankingLimit}명으로 설정`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/phase") {
    const phase = ["lobby", "material", "ready", "winner", "standings", "results"].includes(body.phase)
      ? body.phase
      : "lobby";
    state.phase = phase;
    if (phase !== "ready") state.buzzerOpen = false;
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/approve") {
    const student = getStudent(body.studentId);
    if (!student) return sendJson(res, 404, { error: "참가자를 찾을 수 없습니다." });
    student.status = "approved";
    addEvent(`${student.alias} 승인`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/bulk-status") {
    const ids = Array.isArray(body.studentIds) ? body.studentIds : [];
    const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : null;
    if (!status) return sendJson(res, 400, { error: "변경할 상태가 올바르지 않습니다." });

    let changed = 0;
    for (const id of ids) {
      const student = getStudent(id);
      if (!student || student.status !== "pending") continue;
      student.status = status;
      changed += 1;
    }
    addEvent(`${changed}명 ${status === "approved" ? "일괄 승인" : "일괄 거절"}`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/reject") {
    const student = getStudent(body.studentId);
    if (!student) return sendJson(res, 404, { error: "참가자를 찾을 수 없습니다." });
    student.status = "rejected";
    removeFromQueue(student.id);
    addEvent(`${student.alias} 거절`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/remove") {
    const student = getStudent(body.studentId);
    if (!student) return sendJson(res, 404, { error: "참가자를 찾을 수 없습니다." });
    student.status = "removed";
    removeFromQueue(student.id);
    addEvent(`${student.alias} 내보냄`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/open-buzzer") {
    state.phase = "ready";
    state.buzzerOpen = true;
    state.firstBuzz = null;
    state.buzzQueue = [];
    state.roundCooldownStudentId = state.settings.winnerCooldown ? state.cooldownStudentId : null;
    state.cooldownStudentId = null;
    for (const student of Object.values(state.students)) {
      student.buzzedAt = null;
    }
    addEvent("버저 열림");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/correct") {
    const winner = state.firstBuzz ? getStudent(state.firstBuzz.studentId) : null;
    if (!winner) return sendJson(res, 409, { error: `먼저 누른 ${unitLabel()}이 없습니다.` });
    winner.score += 10;
    state.lastAward = { studentId: winner.id, alias: winner.alias, score: winner.score, at: now() };
    state.cooldownStudentId = state.settings.winnerCooldown ? winner.id : null;
    addEvent(`${winner.alias} 정답 인정, 총 ${winner.score}점`);
    resetRound("standings");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/adjust-score") {
    const student = getStudent(body.studentId);
    if (!student) return sendJson(res, 404, { error: "참가자를 찾을 수 없습니다." });

    if (body.mode === "set") {
      const score = Number.parseInt(body.score, 10);
      if (!Number.isFinite(score)) {
        return sendJson(res, 400, { error: "점수는 숫자로 입력해 주세요." });
      }
      student.score = Math.max(0, score);
    } else {
      const delta = Number.parseInt(body.delta, 10);
      if (!Number.isFinite(delta)) {
        return sendJson(res, 400, { error: "조정할 점수가 올바르지 않습니다." });
      }
      student.score = Math.max(0, student.score + delta);
    }

    if (state.lastAward?.studentId === student.id) {
      state.lastAward.score = student.score;
    }
    addEvent(`${student.alias} 점수 수정, 총 ${student.score}점`);
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/incorrect") {
    if (state.firstBuzz) addEvent(`${state.firstBuzz.alias} 오답 처리`);
    if (state.firstBuzz) {
      state.buzzQueue = state.buzzQueue.filter((buzz) => buzz.studentId !== state.firstBuzz.studentId);
    }
    state.firstBuzz = state.buzzQueue[0] || null;
    state.buzzerOpen = true;
    state.phase = state.firstBuzz ? "winner" : "ready";
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/reset-round") {
    resetRound("material");
    state.lastAward = null;
    state.cooldownStudentId = null;
    addEvent("라운드 초기화");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/reset-game") {
    resetRound("lobby");
    state.lastAward = null;
    state.cooldownStudentId = null;
    for (const student of Object.values(state.students)) {
      student.score = 0;
      student.buzzedAt = null;
    }
    state.events = [];
    addEvent("게임 초기화");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  if (req.url === "/api/teacher/clear-students") {
    resetRound("lobby");
    state.lastAward = null;
    state.cooldownStudentId = null;
    state.students = {};
    state.events = [];
    addEvent("참가자 목록 초기화");
    broadcast();
    return sendJson(res, 200, { state: publicState() });
  }

  return sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fallback);
      });
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`클래스 버저 실행 중: http://localhost:${PORT}`);
});
