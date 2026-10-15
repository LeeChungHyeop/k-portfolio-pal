// 마스터 코드 해시 생성기 (로컬 전용 · 비상 복구용).
//   node scripts/auth/make-master-hash.mjs
//
// 언제 쓰나: 마스터 코드가 **미설정**인 가족이 PIN 을 잊어 앱에서 복구할 수 없을 때(비밀 질문도
// 꺼져 있다). 새 마스터 코드를 이 창에서 입력하면(표시되지 않음, 저장되지 않음) 해시만 출력한다.
// 그 해시를 Supabase SQL Editor 에서 아래처럼 한 행에 넣는다 — 운영 DB 변경이므로 본인이
// 확인하고 직접 실행한다:
//
//   update public.kaw_data
//      set data = jsonb_set(data, '{master_code_hash}', to_jsonb('<출력된 해시>'::text))
//    where family_code = '<가족 코드>' and profile = '_system' and account_type = '_family'
//      and (data ->> 'master_code_hash') is null;      -- 이미 설정된 가족은 건드리지 않는다
//
// 그다음 앱에서 그 마스터 코드로 PIN 을 재설정하고, 설정 → 보안에서 마스터 코드를 바꿉니다.
// 마스터 코드는 8자 이상이어야 하고 액세스 코드와 달라야 한다.
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

const a = await ask("새 마스터 코드(표시되지 않음):");
const b = await ask("한 번 더:");
rl.close();
if (a !== b) { console.error("두 입력이 다릅니다."); process.exit(1); }
if (a.trim().length < 8) { console.error("8자 이상으로 정하세요."); process.exit(1); }
console.log("\n해시(이 값만 SQL 에 사용):\n");
console.log(crypto.createHash("sha256").update(`master:${a}`).digest("hex"));
