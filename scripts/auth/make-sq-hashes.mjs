// 비밀 질문 새 정답 해시 생성기 (로컬 전용).
//   node scripts/auth/make-sq-hashes.mjs
// 질문 5개의 새 정답을 이 창에서 입력한다(입력은 화면에 표시되지 않고 어디에도 저장되지 않는다).
// 출력은 정답이 아니라 해시 JSON 한 줄이다 — Cloudflare secret 으로 등록한다:
//   npx wrangler secret put SECRET_QUESTION_ANSWER_HASHES   (프롬프트에 위 JSON 을 붙여넣기)
// 이 값을 소스·저장소·채팅에 남기지 않는다. 예전 정답은 공개 저장소에 노출됐으므로 **다른 값**을 쓴다.
import crypto from "node:crypto";
import readline from "node:readline";

const QUESTIONS = [
  "내가 가장 오래 자란 도시는?",
  "점심시간에 하는 운동은?",
  "우리집 도로명 주소는 OO로?",
  "소예가 태어난 시간은 몇시?",
  "지금 가장 갖고 싶은건?",
];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
const ask = (q) => new Promise((res) => { muted = false; rl.question(q + " ", (a) => { muted = false; process.stdout.write("\n"); res(a); }); muted = true; });

const hashes = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  process.stdout.write(`${i + 1}/5 ${QUESTIONS[i]}\n`);
  const a = (await ask("새 정답(표시되지 않음):")).trim();
  if (a.length < 6) { console.error("정답은 6자 이상으로 정하세요(짧은 답은 쉽게 추측됩니다)."); process.exit(1); }
  hashes.push(crypto.createHash("sha256").update(`sq:${i}:${a}`).digest("hex"));
}
rl.close();
console.log("\n아래 한 줄을 SECRET_QUESTION_ANSWER_HASHES secret 값으로 등록하세요:\n");
console.log(JSON.stringify(hashes));
