// KIS 실계좌 read-only PoC 러너 (local server-only)
//
//   npm run kis:test-account
//
// 목적은 하나다: **신규 한국투자 연금저축(22) / IRP(29) 계좌가 KIS API 로 조회되는지** 확인.
// 주문(order-cash 등)은 호출하지 않으며, DB 에 아무것도 쓰지 않는다.
//
// `.dev.vars` 에서 읽는 값:
//   KIS_ACCOUNT_CANO                                (필수)
//   KIS_ACCOUNT_APP_KEY / KIS_ACCOUNT_APP_SECRET    (있으면 계좌 전용 credential)
//   KIS_APP_KEY / KIS_APP_SECRET                    (위가 없으면 기존 시세용 credential)
//
// 출력 원칙: CANO / AppKey / AppSecret / access token / URL / params / raw 응답은
// 절대 출력하지 않는다. 모든 문자열은 `redactKisSecrets()` 를 거친다.
import fs from "node:fs";
import path from "node:path";
import { getKisAccessToken } from "../src/lib/kaw/kis-server";
import {
  fetchPensionSavingsBalance,
  fetchIrpPresentBalance,
  fetchIrpDeposit,
  redactKisSecrets,
  PENSION_SAVINGS_PRODUCT_CODE,
  IRP_PRODUCT_CODE,
  type KisAccountCredentials,
  type KisAccountReadResult,
} from "../src/lib/kaw/kis-account-server";

const root = path.resolve(import.meta.dirname, "..");

/** .dev.vars 에서 필요한 키만 읽는다 (새 dependency 없이). */
function readDevVars(keys: readonly string[]): Record<string, string | undefined> {
  const file = path.join(root, ".dev.vars");
  const out: Record<string, string | undefined> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    if (!keys.includes(key)) continue;
    const value = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (value) out[key] = value;
  }
  return out;
}

const NEEDED = [
  "KIS_ACCOUNT_CANO",
  "KIS_ACCOUNT_APP_KEY",
  "KIS_ACCOUNT_APP_SECRET",
  "KIS_APP_KEY",
  "KIS_APP_SECRET",
] as const;

const env = readDevVars(NEEDED);
let secrets: string[] = [];
const redact = (v: unknown) => redactKisSecrets(v, secrets);

const fmtNum = (n: number | null) => (n === null ? "null (필드 없음/파싱 불가)" : String(n));

function printFailure(label: string, productCode: string, r: KisAccountReadResult) {
  console.log(`${label}: FAILED`);
  console.log(`  Product: ${productCode}`);
  console.log(`  HTTP status: ${r.httpStatus}`);
  console.log(`  rt_cd: ${r.rtCd ?? "-"}`);
  console.log(`  msg_cd: ${r.msgCd ?? "-"}`);
  console.log(`  msg1: ${r.msg1 ?? "-"}`);
  if (r.transportError) console.log(`  transport: ${redact(r.transportError)}`);
}

async function main() {
  console.log("[KIS Account Test]");
  console.log("");

  if (!env.KIS_ACCOUNT_CANO) {
    console.log("KIS_ACCOUNT_CANO 없음 — account API 를 호출하지 않고 중단합니다.");
    console.log("KIS_ACCOUNT_CANO 를 .dev.vars 에 추가한 뒤 npm run kis:test-account 실행 필요");
    process.exitCode = 1;
    return;
  }

  const accountCred = env.KIS_ACCOUNT_APP_KEY && env.KIS_ACCOUNT_APP_SECRET;
  const appKey = accountCred ? env.KIS_ACCOUNT_APP_KEY! : env.KIS_APP_KEY;
  const appSecret = accountCred ? env.KIS_ACCOUNT_APP_SECRET! : env.KIS_APP_SECRET;

  if (!appKey || !appSecret) {
    console.log("Credential source: none");
    console.log(
      "KIS_ACCOUNT_APP_KEY/KIS_ACCOUNT_APP_SECRET 또는 KIS_APP_KEY/KIS_APP_SECRET 를 "
      + ".dev.vars 에 추가한 뒤 npm run kis:test-account 실행 필요",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Credential source: ${accountCred ? "account-specific credentials" : "existing KIS credentials"}`);
  console.log("");

  const cred: KisAccountCredentials = { appKey, appSecret, cano: env.KIS_ACCOUNT_CANO };
  secrets = [cred.cano, cred.appKey, cred.appSecret];

  let token: string;
  try {
    // 로컬 PoC 이므로 KV 는 넘기지 않는다 (메모리 캐시만).
    token = await getKisAccessToken(cred.appKey, cred.appSecret);
    secrets = [...secrets, token];
  } catch (e) {
    console.log("Auth: FAILED");
    console.log(`  ${redactKisSecrets(e, [cred.cano, cred.appKey, cred.appSecret])}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Pension Savings (${PENSION_SAVINGS_PRODUCT_CODE})`);
  console.log("Auth: OK");
  const savings = await fetchPensionSavingsBalance(cred, token);
  if (savings.ok) {
    console.log("Balance API: OK");
    console.log(`Holdings: ${savings.holdingsCount}`);
    console.log(`Cash: ${fmtNum(savings.cash)}`);
    const summaryKeys = Object.keys(savings.summary);
    if (summaryKeys.length) {
      console.log(`Summary fields: ${summaryKeys.map((k) => `${k}=${fmtNum(savings.summary[k])}`).join(", ")}`);
    }
    console.log("Result: SUCCESS");
  } else {
    printFailure("Balance API", PENSION_SAVINGS_PRODUCT_CODE, savings);
    console.log("Result: FAILED");
  }
  console.log("");

  console.log(`IRP (${IRP_PRODUCT_CODE})`);
  const irp = await fetchIrpPresentBalance(cred, token);
  if (irp.ok) {
    console.log("Present Balance API: OK");
    console.log(`Holdings: ${irp.holdingsCount}`);
    const summaryKeys = Object.keys(irp.summary);
    if (summaryKeys.length) {
      console.log(`Summary fields: ${summaryKeys.map((k) => `${k}=${fmtNum(irp.summary[k])}`).join(", ")}`);
    }
  } else {
    printFailure("Present Balance API", IRP_PRODUCT_CODE, irp);
  }

  const deposit = await fetchIrpDeposit(cred, token);
  if (deposit.ok) {
    console.log("Deposit API: OK");
    console.log(`Cash: ${fmtNum(deposit.cash)}`);
  } else {
    printFailure("Deposit API", IRP_PRODUCT_CODE, deposit);
  }
  console.log(`Result: ${irp.ok && deposit.ok ? "SUCCESS" : "FAILED"}`);

  if (!(savings.ok && irp.ok && deposit.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.log("Unexpected error:");
  console.log(`  ${redact(e)}`);
  process.exitCode = 1;
});
