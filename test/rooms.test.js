const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("teachers have isolated rooms and only their own key can control one", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const get = (url, key) => fetch(`${base}${url}`, {
    headers: key ? { "X-Teacher-Key": key } : {},
  });
  const post = (url, body = {}, key) => fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "X-Teacher-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        ready = (await get("/api/state")).ok;
        if (ready) break;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(ready, true, "server started");

    const createdRooms = await Promise.all(
      Array.from({ length: 12 }, async () => (await post("/api/rooms")).json())
    );
    assert.equal(new Set(createdRooms.map((room) => room.roomCode)).size, createdRooms.length);
    const [a, b] = createdRooms;
    assert.notEqual(a.roomCode, b.roomCode);
    assert.match(a.roomCode, /^[A-Z2-9]{6}$/);
    assert.equal((await get(`/api/teacher/session?room=${a.roomCode}`)).status, 403);
    assert.equal((await get(`/api/teacher/session?room=${a.roomCode}`, a.teacherKey)).status, 200);

    const joinedA = await (await post("/api/join", { roomCode: a.roomCode, alias: "별빛팀" })).json();
    const joinedB = await (await post("/api/join", { roomCode: b.roomCode, alias: "별빛팀" })).json();
    assert.ok(joinedA.studentId);
    assert.ok(joinedB.studentId);
    assert.equal((await post("/api/join", { roomCode: a.roomCode, alias: "별빛팀" })).status, 409);

    const approve = { roomCode: a.roomCode, studentId: joinedA.studentId };
    assert.equal((await post("/api/teacher/approve", approve, b.teacherKey)).status, 403);
    assert.equal((await post("/api/teacher/approve", approve, a.teacherKey)).status, 200);
    assert.equal((await post("/api/teacher/open-buzzer", { roomCode: a.roomCode }, a.teacherKey)).status, 200);
    assert.equal((await post("/api/student/buzz", approve)).status, 200);
    assert.equal((await post("/api/teacher/correct", { roomCode: a.roomCode }, a.teacherKey)).status, 200);

    const stateA = await (await get(`/api/state?room=${a.roomCode}`)).json();
    const stateB = await (await get(`/api/state?room=${b.roomCode}`)).json();
    assert.equal(stateA.students[0].score, 10);
    assert.equal(stateA.students[0].status, "approved");
    assert.equal(stateB.students[0].score, 0);
    assert.equal(stateB.students[0].status, "pending");
    assert.equal(stateB.phase, "lobby");
    assert.equal((await post("/api/student/buzz", { roomCode: b.roomCode, studentId: joinedA.studentId })).status, 404);
  } finally {
    child.kill();
  }
});
