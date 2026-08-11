const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const role = params.get("role") === "teacher" ? "teacher" : "student";
const baseUrl = window.location.origin;
let state = null;
let studentId = localStorage.getItem("class-buzzer-student-id") || "";
let lastError = "";
let localMaterialUrl = "";

const statusText = {
  pending: "승인 대기",
  approved: "참여 중",
  rejected: "거절됨",
  removed: "내보냄",
};

function isTeamMode() {
  return state?.settings?.playMode !== "individual";
}

function unitLabel() {
  return isTeamMode() ? "팀" : "학생";
}

function nameLabel() {
  return isTeamMode() ? "팀명" : "별칭";
}

function participantLabel() {
  return isTeamMode() ? "참가 팀" : "참가 학생";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };
  source.onerror = () => {
    lastError = "서버 연결을 다시 시도하고 있습니다.";
    render();
  };
}

function currentStudent() {
  return state?.students.find((student) => student.id === studentId);
}

function approvedStudents() {
  return state.students.filter((student) => student.status === "approved");
}

function pendingStudents() {
  return state.students.filter((student) => student.status === "pending");
}

function rankingLimit() {
  return Math.max(1, Number(state.settings?.rankingLimit || 5));
}

function rankingStudents(limit = rankingLimit()) {
  return approvedStudents().slice(0, limit);
}

function buzzQueue() {
  return Array.isArray(state.buzzQueue) ? state.buzzQueue : [];
}

function currentBuzz() {
  return state.firstBuzz || buzzQueue()[0] || null;
}

function queueIndexFor(studentId) {
  return buzzQueue().findIndex((buzz) => buzz.studentId === studentId);
}

function resultRows() {
  return approvedStudents().map((student, index) => ({
    rank: index + 1,
    alias: student.alias,
    score: student.score,
  }));
}

function resultText() {
  const rows = resultRows();
  const lines = [
    "클래스 버저 결과",
    `저장 시각: ${new Date().toLocaleString("ko-KR")}`,
    "",
    `순위\t${nameLabel()}\t점수`,
    ...rows.map((row) => `${row.rank}\t${row.alias}\t${row.score}`),
  ];
  return lines.join("\n");
}

function resultCsv() {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return [`순위,${nameLabel()},점수`, ...resultRows().map((row) => [row.rank, row.alias, row.score].map(quote).join(","))].join("\n");
}

function downloadTextFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printResultPdf() {
  const rows = resultRows();
  const printedAt = new Date().toLocaleString("ko-KR");
  const tableRows = rows
    .map(
      (row) => `
        <tr>
          <td>${row.rank}</td>
          <td>${escapeHtml(row.alias)}</td>
          <td>${row.score}</td>
        </tr>
      `
    )
    .join("");
  const printWindow = window.open("", "class-buzzer-results");
  if (!printWindow) {
    lastError = "팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.";
    render();
    return;
  }
  printWindow.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <title>클래스 버저 결과</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 32px;
            color: #151719;
            font-family: "Segoe UI", system-ui, sans-serif;
          }
          h1 { margin: 0; font-size: 34px; }
          p { margin: 8px 0 28px; color: #657381; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 14px 12px; border-bottom: 1px solid #d6dee6; text-align: left; font-size: 18px; }
          th { background: #f4f7f9; font-weight: 900; }
          td:first-child, td:last-child { width: 96px; font-weight: 900; }
          @media print {
            body { padding: 20mm; }
          }
        </style>
      </head>
      <body>
        <h1>클래스 버저 결과</h1>
        <p>${escapeHtml(printedAt)}</p>
        <table>
          <thead>
            <tr><th>순위</th><th>${nameLabel()}</th><th>점수</th></tr>
          </thead>
          <tbody>${tableRows || `<tr><td colspan="3">결과가 없습니다.</td></tr>`}</tbody>
        </table>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

const QR_VERSION = 4;
const QR_SIZE = 33;
const QR_DATA_CODEWORDS = 80;
const QR_EC_CODEWORDS = 20;

function makeQrSvg(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 78) {
    return `<div class="qr-fallback">${escapeHtml(text)}</div>`;
  }
  const data = makeQrCodewords(bytes);
  const ec = reedSolomon(data, QR_EC_CODEWORDS);
  const bits = [...data, ...ec].flatMap((byte) =>
    Array.from({ length: 8 }, (_, index) => ((byte >> (7 - index)) & 1) === 1)
  );
  const matrix = drawQrMatrix(bits);
  const quiet = 4;
  const size = QR_SIZE + quiet * 2;
  const cells = [];
  for (let y = 0; y < QR_SIZE; y += 1) {
    for (let x = 0; x < QR_SIZE; x += 1) {
      if (matrix[y][x]) {
        cells.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1" />`);
      }
    }
  }
  return `
    <svg class="qr-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${unitLabel()} 입장 QR 코드">
      <rect width="${size}" height="${size}" fill="#fff" />
      <g fill="#151719">${cells.join("")}</g>
    </svg>
  `;
}

function makeQrCodewords(bytes) {
  const bits = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  bytes.forEach((byte) => pushBits(byte, 8));
  const maxBits = QR_DATA_CODEWORDS * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < QR_DATA_CODEWORDS) {
    codewords.push(pads[padIndex % 2]);
    padIndex += 1;
  }
  return codewords;
}

function makeGfTables() {
  const exp = new Array(512);
  const log = new Array(256);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  return { exp, log };
}

const QR_GF = makeGfTables();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF.exp[QR_GF.log[a] + QR_GF.log[b]];
}

function reedSolomon(data, degree) {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(generator.length + 1).fill(0);
    generator.forEach((coef, index) => {
      next[index] ^= coef;
      next[index + 1] ^= gfMul(coef, QR_GF.exp[i]);
    });
    generator = next;
  }
  const remainder = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const coef = remainder[i];
    if (!coef) continue;
    generator.forEach((genCoef, index) => {
      remainder[i + index] ^= gfMul(genCoef, coef);
    });
  }
  return remainder.slice(-degree);
}

function drawQrMatrix(bits) {
  const matrix = Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false));
  const reserved = Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false));
  const set = (x, y, dark, isReserved = true) => {
    if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) return;
    matrix[y][x] = dark;
    if (isReserved) reserved[y][x] = true;
  };
  const finder = (x, y) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        const inRing = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        set(xx, yy, inOuter && (inRing || inInner));
      }
    }
  };
  finder(0, 0);
  finder(QR_SIZE - 7, 0);
  finder(0, QR_SIZE - 7);
  for (let i = 8; i < QR_SIZE - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      set(26 + dx, 26 + dy, distance !== 1);
    }
  }
  set(8, 25, true);
  reserveFormatAreas(reserved);

  let bitIndex = 0;
  let upward = true;
  for (let x = QR_SIZE - 1; x > 0; x -= 2) {
    if (x === 6) x -= 1;
    for (let step = 0; step < QR_SIZE; step += 1) {
      const y = upward ? QR_SIZE - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const xx = x - dx;
        if (reserved[y][xx]) continue;
        const raw = bits[bitIndex] || false;
        const mask = (xx + y) % 2 === 0;
        matrix[y][xx] = raw !== mask;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  drawFormatBits(matrix);
  return matrix;
}

function reserveFormatAreas(reserved) {
  for (let i = 0; i <= 8; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = QR_SIZE - 8; i < QR_SIZE; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
}

function formatBits() {
  let data = 0b01000;
  let value = data << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= generator << (i - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function drawFormatBits(matrix) {
  const bits = formatBits();
  const bit = (index) => ((bits >> index) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) matrix[8][i] = bit(i);
  matrix[8][7] = bit(6);
  matrix[8][8] = bit(7);
  matrix[7][8] = bit(8);
  for (let i = 9; i < 15; i += 1) matrix[14 - i][8] = bit(i);
  for (let i = 0; i < 8; i += 1) matrix[QR_SIZE - 1 - i][8] = bit(i);
  for (let i = 8; i < 15; i += 1) matrix[8][QR_SIZE - 15 + i] = bit(i);
}

function materialPreview() {
  const material = state.material;
  if (material.type === "pdf") {
    const page = Math.max(1, Number(material.page || 1));
    const separator = material.content.includes("#") ? "&" : "#";
    return `<iframe src="${escapeHtml(`${material.content}${separator}page=${page}`)}" title="${escapeHtml(material.title)}"></iframe>`;
  }
  if (material.type === "link") {
    return `<iframe src="${escapeHtml(material.content)}" title="${escapeHtml(material.title)}"></iframe>`;
  }
  if (material.type === "image") {
    return `<img src="${escapeHtml(material.content)}" alt="${escapeHtml(material.title)}" />`;
  }
  return `
    <section class="material-note">
      <h2>${escapeHtml(material.title || "문제 메모")}</h2>
      <p>${escapeHtml(material.content || "문제 자료를 입력하세요.")}</p>
    </section>
  `;
}

function stageMarkup() {
  const joinUrl = `${baseUrl}/?role=student`;
  if (state.phase === "lobby") {
    return `
      <section class="lobby-stage">
        <div class="lobby-copy">
          <p class="stage-kicker">입장 준비</p>
          <h2 class="stage-title">클래스 버저</h2>
          <p class="stage-subtitle">${unitLabel()}은 QR을 찍고 ${nameLabel()}을 입력합니다. 교사가 승인한 ${unitLabel()}만 버저에 참여합니다.</p>
          <div class="room-code">방 코드 <span>${escapeHtml(state.roomCode)}</span></div>
          <div class="join-url">${escapeHtml(joinUrl)}</div>
          <div class="lobby-setting-note">정답 후 랭킹 표시: 상위 ${rankingLimit()}명</div>
          <div class="lobby-setting-note">정답 ${unitLabel()} 쿨다운: ${state.settings?.winnerCooldown === false ? "끔" : "켬"}</div>
        </div>
        <figure class="qr-card">
          ${makeQrSvg(joinUrl)}
          <figcaption>${unitLabel()} 입장 QR</figcaption>
        </figure>
      </section>
    `;
  }
  if (state.phase === "ready") {
    return `
      <section class="ready-stage">
        <div class="pulse-ring">BUZZ</div>
        <p class="stage-kicker">버저 열림</p>
        <h2 class="stage-title">지금 누르세요!</h2>
        <p class="stage-subtitle">누른 순서대로 대기열에 들어갑니다.</p>
      </section>
    `;
  }
  if (state.phase === "winner" && currentBuzz()) {
    const waitingCount = Math.max(0, buzzQueue().length - 1);
    return `
      <section class="winner-stage">
        <div class="winner-card">
          <span>현재 답변 순서</span>
          <strong>${escapeHtml(currentBuzz().alias)}</strong>
          <em>대기 ${waitingCount}명</em>
        </div>
      </section>
    `;
  }
  if (state.phase === "standings") {
    const rows = rankingStudents()
      .map(
        (student, index) => `
          <div class="ranking-row ${state.lastAward?.studentId === student.id ? "is-awarded" : ""}">
            <span class="ranking-place">${index + 1}</span>
            <strong>${escapeHtml(student.alias)}</strong>
            <span class="ranking-score">${student.score}</span>
          </div>
        `
      )
      .join("");
    return `
      <section class="standings-stage">
        <p class="stage-kicker">실시간 현황</p>
        <h2 class="stage-title">현재 랭킹</h2>
        ${
          state.lastAward
            ? `<p class="stage-subtitle">${escapeHtml(state.lastAward.alias)} +10, 현재 ${state.lastAward.score}점</p>`
            : ""
        }
        <div class="ranking-list">${rows || `<p class="empty">아직 승인된 ${unitLabel()}이 없습니다.</p>`}</div>
      </section>
    `;
  }
  if (state.phase === "results") {
    const scores = resultRows()
      .map(
        (row) => `
          <div class="score-row">
            <strong>${row.rank}. ${escapeHtml(row.alias)}</strong>
            <span class="score-badge">${row.score}</span>
          </div>
        `
      )
.join("");
    return `
      <section class="results-stage">
        <p class="stage-kicker">최종 결과</p>
        <h2 class="stage-title">점수표</h2>
        <div class="result-actions">
          <button class="dark-button" data-action="copy-results">결과 복사</button>
          <button class="ghost-button" data-action="download-csv">CSV 저장</button>
          <button class="success-button" data-action="print-results">PDF 저장</button>
        </div>
        <div class="result-list">${scores || `<p class="empty">아직 승인된 ${unitLabel()}이 없습니다.</p>`}</div>
      </section>
    `;
  }
  return `
    <section class="material-stage">
      <p class="stage-kicker">문제 자료</p>
      <div class="material-frame">${materialPreview()}</div>
    </section>
  `;
}

function studentListMarkup(students, actions = true) {
  if (!students.length) return `<p class="empty">목록이 비어 있습니다.</p>`;
  return students
    .map(
      (student) => `
        <article class="student-row">
          <header>
            <label class="student-checkline">
              ${
                actions && student.status === "pending"
                  ? `<input class="student-check" type="checkbox" data-pending-student="${student.id}" checked />`
                  : ""
              }
              <span class="alias">${escapeHtml(student.alias)}</span>
            </label>
            <span class="status">${statusText[student.status] || student.status}</span>
          </header>
          <div class="button-row">
            ${
              actions && student.status === "pending"
                ? `<button class="success-button" data-action="approve" data-id="${student.id}">승인</button>
                   <button class="danger-button" data-action="reject" data-id="${student.id}">거절</button>`
                : ""
            }
            ${
              actions && student.status === "approved"
                ? `<div class="score-tools">
                     <button class="ghost-button score-step" data-action="score-delta" data-id="${student.id}" data-delta="-10">-10</button>
                     <input class="score-input" data-score-input="${student.id}" type="number" min="0" step="10" value="${student.score}" aria-label="${escapeHtml(student.alias)} 점수" />
                     <button class="ghost-button score-step" data-action="score-delta" data-id="${student.id}" data-delta="10">+10</button>
                     <button class="dark-button score-save" data-action="score-set" data-id="${student.id}">저장</button>
                   </div>
                   <button class="ghost-button" data-action="remove" data-id="${student.id}">내보내기</button>`
                : ""
            }
          </div>
        </article>
      `
    )
    .join("");
}

function teacherMarkup() {
  const approved = approvedStudents();
  const pending = pendingStudents();
  return `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">B</div>
          <div>
            <h1>클래스 버저</h1>
            <p>전자칠판용 퀴즈 진행 패널</p>
          </div>
        </div>
        <nav class="mode-switch">
          <button class="ghost-button ${state.phase === "lobby" ? "is-active" : ""}" data-action="phase" data-phase="lobby">입장</button>
          <button class="ghost-button ${state.phase === "material" ? "is-active" : ""}" data-action="phase" data-phase="material">문제</button>
          <button class="pill-button" data-action="open-buzzer">버저 열기</button>
          <button class="ghost-button ${state.phase === "standings" ? "is-active" : ""}" data-action="phase" data-phase="standings">현황</button>
          <button class="ghost-button ${state.phase === "results" ? "is-active" : ""}" data-action="phase" data-phase="results">결과</button>
        </nav>
      </header>
      <section class="teacher-layout">
        <div class="stage">
          <div class="stage-inner">${stageMarkup()}</div>
        </div>
        <aside class="side-panel">
          <section class="panel-section">
            <h2>첫 화면 설정</h2>
            <form class="form-grid" id="settings-form">
              <label class="field-label" for="play-mode">진행 방식</label>
              <select class="select" id="play-mode" name="playMode">
                <option value="team" ${isTeamMode() ? "selected" : ""}>팀전</option>
                <option value="individual" ${isTeamMode() ? "" : "selected"}>개인전</option>
              </select>
              <label class="field-label" for="ranking-limit">정답 후 보여줄 랭킹 수</label>
              <input class="input" id="ranking-limit" name="rankingLimit" type="number" min="1" max="20" value="${rankingLimit()}" />
              <label class="toggle-line">
                <input type="checkbox" name="winnerCooldown" ${state.settings?.winnerCooldown === false ? "" : "checked"} />
                <span>방금 정답 ${unitLabel()}은 다음 문제 쉬기</span>
              </label>
              <button class="dark-button" type="submit">설정 저장</button>
            </form>
          </section>
          <section class="panel-section">
            <h2>문제 자료 연결</h2>
            <form class="form-grid" id="material-form">
              <select class="select" name="type">
                <option value="note" ${state.material.type === "note" ? "selected" : ""}>짧은 문제 메모</option>
                <option value="link" ${state.material.type === "link" ? "selected" : ""}>Canva 또는 웹 링크</option>
                <option value="pdf" ${state.material.type === "pdf" ? "selected" : ""}>PDF 링크</option>
                <option value="image" ${state.material.type === "image" ? "selected" : ""}>이미지 링크</option>
              </select>
              <input class="input" name="title" placeholder="자료 제목" value="${escapeHtml(state.material.title)}" />
              <textarea class="textarea" name="content" placeholder="링크 또는 짧은 문제 메모">${escapeHtml(state.material.content)}</textarea>
              <input class="input" type="file" name="file" accept="application/pdf,image/*" />
              <button class="dark-button" type="submit">문제 화면에 띄우기</button>
            </form>
            ${
              state.material.type === "pdf"
                ? `<div class="pdf-controls">
                    <button class="ghost-button" data-action="pdf-page" data-page="1">첫 페이지</button>
                    <button class="ghost-button" data-action="pdf-page" data-delta="-1">이전</button>
                    <input class="score-input" data-pdf-page-input type="number" min="1" value="${state.material.page || 1}" aria-label="PDF 페이지" />
                    <button class="ghost-button" data-action="pdf-page" data-delta="1">다음</button>
                    <button class="dark-button" data-action="pdf-page-set">이동</button>
                  </div>`
                : ""
            }
          </section>
          <section class="panel-section">
            <h2>버저 판정</h2>
            <div class="button-row">
              <button class="pill-button" data-action="open-buzzer">버저 열기</button>
              <button class="success-button" data-action="correct" ${currentBuzz() ? "" : "disabled"}>정답 인정 +10</button>
              <button class="danger-button" data-action="incorrect" ${currentBuzz() ? "" : "disabled"}>오답, 다음 ${unitLabel()}</button>
              <button class="ghost-button" data-action="phase" data-phase="material">다음 문제</button>
              <button class="ghost-button" data-action="reset-round">라운드 초기화</button>
            </div>
          </section>
          <section class="panel-section">
            <h2>승인 대기 <span>${pending.length}</span></h2>
            ${
              pending.length
                ? `<div class="bulk-toolbar">
                    <button class="ghost-button" data-action="pending-check-all">전체 선택</button>
                    <button class="ghost-button" data-action="pending-uncheck-all">선택 해제</button>
                    <button class="success-button" data-action="bulk-approve">선택 승인</button>
                    <button class="danger-button" data-action="bulk-reject">선택 거절</button>
                  </div>`
                : ""
            }
            ${studentListMarkup(pending)}
          </section>
          <section class="panel-section">
            <h2>${participantLabel()} <span>${approved.length}</span></h2>
            ${studentListMarkup(approved)}
          </section>
          <section class="panel-section">
            <button class="danger-button" data-action="reset-game">점수 초기화</button>
            <button class="ghost-button" data-action="clear-students">참가자 비우기</button>
          </section>
          <section class="panel-section">
            <h2>결과 저장</h2>
            <div class="button-row">
              <button class="dark-button" data-action="copy-results">결과 복사</button>
              <button class="ghost-button" data-action="download-csv">CSV 저장</button>
              <button class="success-button" data-action="print-results">PDF 저장</button>
            </div>
            ${lastError ? `<p class="status">${escapeHtml(lastError)}</p>` : ""}
          </section>
        </aside>
      </section>
    </main>
  `;
}

function studentMarkup() {
  const me = currentStudent();
  if (!me) {
    return `
      <main class="student-page">
        <section class="student-card">
          <h1>클래스 버저</h1>
          <p>${nameLabel()}을 입력하면 선생님 승인 뒤 버저에 참여할 수 있습니다.</p>
          <form class="form-grid" id="join-form">
            <input class="input" name="alias" maxlength="16" placeholder="${isTeamMode() ? "예: 번개팀, 3모둠" : "예: 하늘, 민재"}" required />
            <button class="pill-button" type="submit">입장 요청</button>
          </form>
          ${lastError ? `<p class="status">${escapeHtml(lastError)}</p>` : ""}
        </section>
      </main>
    `;
  }

  const isApproved = me.status === "approved";
  const myQueueIndex = queueIndexFor(me.id);
  const current = currentBuzz();
  const isCoolingDown = me.id === state.roundCooldownStudentId;
  const canBuzz = isApproved && state.buzzerOpen && myQueueIndex === -1 && !isCoolingDown;
  let message = "선생님 승인을 기다리고 있습니다.";
  if (me.status === "rejected") message = `입장이 승인되지 않았습니다. 다른 ${nameLabel()}으로 다시 요청해 주세요.`;
  if (me.status === "removed") message = "참여 목록에서 제외되었습니다.";
  if (isApproved && state.phase === "lobby") message = "입장 완료. 선생님이 시작할 때까지 기다려 주세요.";
  if (isApproved && state.phase === "material") message = "문제를 보고 기다려 주세요.";
  if (isApproved && state.phase === "standings") message = `실시간 현황을 확인해 주세요. 내 점수는 ${me.score}점입니다.`;
  if (isApproved && state.phase === "results") message = `퀴즈가 끝났습니다. 내 최종 점수는 ${me.score}점입니다.`;
  if (isCoolingDown) message = `방금 정답을 맞힌 ${unitLabel()}이라 이번 문제는 쉬어가요.`;
  if (canBuzz) message = "버저가 열렸습니다. 지금 누르세요!";
  if (myQueueIndex > 0) message = `대기열 ${myQueueIndex + 1}번입니다. 차례를 기다려 주세요.`;
  if (current?.studentId === me.id) message = "선택되었습니다. 답을 말해 주세요.";
  if (current && current.studentId !== me.id && myQueueIndex === -1 && !isCoolingDown) {
    message = `${current.alias} ${unitLabel()} 답변 중입니다. 누르면 대기열에 들어갑니다.`;
  }

  return `
    <main class="student-page">
      <section class="student-card">
        <h1>${escapeHtml(me.alias)}</h1>
        <p>내 점수: <strong>${me.score}</strong>점</p>
        <div class="student-status">${escapeHtml(message)}</div>
        <button class="buzzer-button" data-action="buzz" ${canBuzz ? "" : "disabled"}>BUZZ</button>
        ${
          me.status === "rejected" || me.status === "removed"
            ? `<button class="ghost-button" data-action="clear-student">${nameLabel()} 다시 입력</button>`
            : ""
        }
        ${lastError ? `<p class="status">${escapeHtml(lastError)}</p>` : ""}
      </section>
    </main>
  `;
}

function render() {
  if (!state) {
    app.innerHTML = `<main class="student-page"><section class="student-card"><h1>클래스 버저</h1><p>연결 중입니다.</p></section></main>`;
    return;
  }
  app.innerHTML = role === "teacher" ? teacherMarkup() : studentMarkup();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  lastError = "";
  const form = event.target;
  const formData = new FormData(form);
  try {
    if (form.id === "join-form") {
      const data = await api("/api/join", { alias: formData.get("alias") });
      studentId = data.studentId;
      localStorage.setItem("class-buzzer-student-id", studentId);
    }
    if (form.id === "material-form") {
      const file = formData.get("file");
      let type = formData.get("type");
      let content = formData.get("content");
      let title = formData.get("title");
      if (file && file.size) {
        if (localMaterialUrl) URL.revokeObjectURL(localMaterialUrl);
        localMaterialUrl = URL.createObjectURL(file);
        type = file.type.startsWith("image/") ? "image" : "pdf";
        content = localMaterialUrl;
        title = title || file.name;
      }
      await api("/api/teacher/material", {
        type,
        title,
        content,
      });
    }
    if (form.id === "settings-form") {
      await api("/api/teacher/settings", {
        playMode: formData.get("playMode"),
        rankingLimit: formData.get("rankingLimit"),
        winnerCooldown: formData.get("winnerCooldown") === "on",
      });
    }
  } catch (error) {
    lastError = error.message;
    render();
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  lastError = "";

  try {
    if (action === "phase") await api("/api/teacher/phase", { phase: button.dataset.phase });
    if (action === "approve") await api("/api/teacher/approve", { studentId: id });
    if (action === "reject") await api("/api/teacher/reject", { studentId: id });
    if (action === "pending-check-all" || action === "pending-uncheck-all") {
      document
        .querySelectorAll("[data-pending-student]")
        .forEach((input) => {
          input.checked = action === "pending-check-all";
        });
    }
    if (action === "bulk-approve" || action === "bulk-reject") {
      const studentIds = Array.from(document.querySelectorAll("[data-pending-student]:checked")).map(
        (input) => input.dataset.pendingStudent
      );
      await api("/api/teacher/bulk-status", {
        studentIds,
        status: action === "bulk-approve" ? "approved" : "rejected",
      });
    }
    if (action === "remove") await api("/api/teacher/remove", { studentId: id });
    if (action === "open-buzzer") await api("/api/teacher/open-buzzer");
    if (action === "correct") await api("/api/teacher/correct");
    if (action === "incorrect") await api("/api/teacher/incorrect");
    if (action === "reset-round") await api("/api/teacher/reset-round");
    if (action === "reset-game") await api("/api/teacher/reset-game");
    if (action === "clear-students") await api("/api/teacher/clear-students");
    if (action === "score-delta") {
      await api("/api/teacher/adjust-score", {
        studentId: id,
        delta: button.dataset.delta,
      });
    }
    if (action === "score-set") {
      const input = document.querySelector(`[data-score-input="${CSS.escape(id)}"]`);
      await api("/api/teacher/adjust-score", {
        studentId: id,
        mode: "set",
        score: input?.value,
      });
    }
    if (action === "pdf-page") {
      await api("/api/teacher/material-page", {
        page: button.dataset.page,
        delta: button.dataset.delta,
      });
    }
    if (action === "pdf-page-set") {
      const input = document.querySelector("[data-pdf-page-input]");
      await api("/api/teacher/material-page", {
        page: input?.value,
      });
    }
    if (action === "copy-results") {
      await navigator.clipboard.writeText(resultText());
      lastError = "결과를 클립보드에 복사했습니다.";
      render();
    }
    if (action === "download-csv") {
      downloadTextFile("class-buzzer-results.csv", `\uFEFF${resultCsv()}`, "text/csv;charset=utf-8");
    }
    if (action === "print-results") {
      printResultPdf();
    }
    if (action === "buzz") await api("/api/student/buzz", { studentId });
    if (action === "clear-student") {
      studentId = "";
      localStorage.removeItem("class-buzzer-student-id");
      render();
    }
  } catch (error) {
    lastError = error.message;
    render();
  }
});

render();
connectEvents();
