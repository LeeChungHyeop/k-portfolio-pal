// 초기 설정 코드 해시 생성기 (로컬 전용).
//   node scripts/auth/make-setup-hash.mjs [가족 코드]
//
// 언제 쓰나: **아무 프로필도 PIN 이 없는** 새 가족(처음 배포·DB 초기화·코드 변경)의 첫 PIN 을
// 등록할 때. 액세스 코드는 공개값이라 그것만으로는 첫 PIN 을 등록할 수 없다.
//
// 1) 이 스크립트에서 설정 코드를 입력한다(표시되지 않음, 저장되지 않음) → 해시 한 줄을 출력한다.
// 2) 해시를 Cloudflare secret 으로 등록한다:
//      npx wrangler secret put FAMILY_SETUP_CODE_HASH      (프롬프트에 해시를 붙여넣기)
// 3) 앱에서 프로필을 고르고 같은 설정 코드를 입력해 첫 PIN 을 등록한다.
// 4) 등록이 끝나면 secret 을 지워도 된다: npx wrangler secret delete FAMILY_SETUP_CODE_HASH
//    (이미 PIN 이 있는 가족에는 쓰이지 않는다.)
//
// 설정 코드는 8자 이상으로 정하고, 소스·저장소·채팅에 남기지 않는다.
import crypto from "node:crypto";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
const ask = (q) => new Promise((res) => {
  process.stdout.write(q + " ");
  muted = true;
  rl.question("", (a) => { muted = false; process.stdout.write("\n"); res(a); });
});

// 해시는 가족 코드(= 앱의 액세스 코드 값)에 묶인다. 인자로 주거나 여기서 입력한다(공개값이라 표시됨).
const familyCode = (process.argv[2] ?? (await new Promise((res) => {
  muted = false; rl.question("가족 코드(액세스 코드 값): ", (v) => res(v));
}))).trim();
if (!familyCode) { console.error("가족 코드가 필요합니다."); process.exit(1); }
const a = await ask("초기 설정 코드(표시되지 않음):");
const b = await ask("한 번 더:");
rl.close();
if (a !== b) { console.error("두 입력이 다릅니다."); process.exit(1); }
if (a.trim().length < 8) { console.error("8자 이상으로 정하세요."); process.exit(1); }
console.log("\n아래 해시를 FAMILY_SETUP_CODE_HASH secret 으로 등록하세요:\n");
console.log(crypto.createHash("sha256").update(`setup:${familyCode}:${a.trim()}`).digest("hex"));
