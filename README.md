# 클래스 버저

교실 TV나 전자칠판에 띄워 쓰는 실시간 퀴즈 버저 앱입니다. 팀별 태블릿 1대로 접속해 팀명을 입력하고, 교사가 승인한 팀만 버저에 참여합니다.

## 실행

```bash
npm start
```

또는:

```bash
node server.js
```

브라우저에서 아래 주소를 엽니다.

- 교사 화면: `http://localhost:3000/?role=teacher`
- 팀 화면: `http://localhost:3000/?role=student`

같은 와이파이에서 로컬로 쓸 때는 팀 태블릿에서 교사용 PC의 IP로 접속합니다.

```text
http://교사용PC_IP:3000/?role=student
```

## 주요 기능

- 팀전/개인전 전환
- 팀명 직접 입력 후 교사 승인
- 전체 선택, 선택 승인, 선택 거절
- 버저 큐: 오답 시 다음 팀에게 기회 이동
- 정답 팀 쿨다운: 방금 맞힌 팀은 다음 문제 쉬기
- 정답 인정 시 +10점
- 팀별 점수 직접 수정
- 실시간 랭킹 화면
- 결과 복사, CSV 저장, PDF 저장
- 앱 자체 QR 생성
- PDF/이미지/웹 링크/짧은 문제 메모 표시
- PDF 첫 페이지, 이전, 다음, 페이지 이동

## Render 배포

가장 쉬운 클라우드 운영은 Render Web Service 배포입니다.

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New` -> `Web Service`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. 설정값을 확인합니다.
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/api/state`
5. 배포 후 생성된 주소를 사용합니다.

예:

```text
https://class-buzzer.onrender.com/?role=teacher
https://class-buzzer.onrender.com/?role=student
```

## 운영 참고

현재 버전은 인메모리 방식입니다. 서버가 재시작되면 참가 팀과 점수는 초기화됩니다. 수업 종료 후에는 결과 화면에서 CSV 또는 PDF로 저장하세요.

Render 무료 Web Service는 일정 시간 접속이 없으면 잠들 수 있습니다. 수업 전에 교사 화면을 한 번 열어 서버를 깨워두면 좋습니다.
