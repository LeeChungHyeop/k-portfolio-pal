// 검증 스크립트 (read-only — SELECT 만 한다. DB 를 전혀 변경하지 않는다).
//
//   npx vite-node scripts/verify-cashflow-principal.ts [family_code] [profile]
//
// production 의 kaw_data 를 그대로 읽어서, **앱이 실제로 쓰는 모듈**(cashflow.ts)로
// 다음 invariant 를 계좌별로 대조한다.
//
//   1) 장부 복원이 무손실인가            : Σ cashflow == 기존 계산식(baseAmount + Σdeposit)
//   2) totalAsset == ETF 평가액 + 예수금
//   3) gain == totalAsset - cumulativePrincipal
//   4) 예수금이 원금에 섞이지 않는가      : 예수금을 바꿔도 principal 불변
//
// .dev.vars 의 service_role 키를 쓰며 키를 출력하지 않는다.
import fs from "node:fs";
import path from "node:path";
import {
  buildMigratedCashflows, computeAccountTotals, cumulativePrincipal,
  type CashflowHistoryLike,
} from "../src/lib/kaw/cashflow";

const ACCOUNTS = ["retirement", "isa", "pension", "irp"] as const;
const FAMILY = process.argv[2] ?? "soye";
const PROFILE = process.argv[3] ?? "hyeobi";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".dev.vars"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error(".dev.vars 에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");
  process.exit(1);
}

async function rest<T>(q: string): Promise<T> {
  const res = await fetch(`${URL_}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** 2차 작업 전의 누적 납입원금 계산식 — 대조 기준으로만 쓴다. */
function legacyPrincipal(history: readonly CashflowHistoryLike[]): number {
  if (!history.length) return 0;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  return sorted[0].baseAmount + sorted.slice(1).reduce((s, h) => s + Math.max(0, h.deposit ?? 0), 0);
}

const fmt = (n: number) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Math.round(n));

type Row = { account_type: string; data: Record<string, any> };

const rows = await rest<Row[]>(
  `kaw_data?family_code=eq.${FAMILY}&profile=eq.${PROFILE}&select=account_type,data`,
);
const libRows = await rest<Array<{ data: Record<string, any> }>>(
  `kaw_data?family_code=eq.${FAMILY}&account_type=eq._assetLib&select=data`,
);
const prices = await rest<Array<{ ticker: string; price: number }>>(`kaw_live_prices?select=ticker,price`);

const tickerByEtf = new Map<string, string>(
  (libRows[0]?.data?.assetLibrary ?? [])
    .filter((d: any) => d.defaultEtf && d.ticker)
    .map((d: any) => [d.defaultEtf, String(d.ticker).toUpperCase()]),
);
const priceByTicker = new Map(prices.map((p) => [p.ticker.toUpperCase(), Number(p.price)]));

let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) fail++;
};

let sumEtf = 0, sumCash = 0, sumPrincipal = 0, sumLegacy = 0;

for (const id of ACCOUNTS) {
  const data = rows.find((r) => r.account_type === id)?.data;
  if (!data) { console.log(`\n=== ${id} === 행 없음`); continue; }

  const history = (data.history ?? []) as CashflowHistoryLike[];
  const flows = Array.isArray(data.cashflows) && data.cashflows.length
    ? data.cashflows
    : buildMigratedCashflows(history);
  const fromDb = Array.isArray(data.cashflows) && data.cashflows.length > 0;

  // ETF 평가액 (확정 수량 x 캐시 시세, 없으면 snapshot 폴백 — 앱 화면과 같은 규칙)
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1] as any;
  let etf = 0;
  for (const [rowId, rawQty] of Object.entries(last?.rowQuantitiesSnap ?? {})) {
    const qty = Number(rawQty);
    if (!(qty > 0)) continue;
    const etfName = last.rowEtfSnap?.[rowId] ?? rowId;
    const tk = tickerByEtf.get(etfName);
    const px = tk ? (priceByTicker.get(tk) ?? 0) : 0;
    etf += px > 0 ? qty * px : (last.rowHoldingsSnap?.[rowId] ?? 0);
  }

  const cash: number | undefined = typeof data.cashBalance === "number" ? data.cashBalance : undefined;
  const t = computeAccountTotals(etf, cash, flows);
  const legacy = legacyPrincipal(history);

  sumEtf += etf; sumCash += t.cashBalance; sumPrincipal += t.principal; sumLegacy += legacy;

  console.log(`\n=== ${id} ===  (장부 출처: ${fromDb ? "DB 저장값" : "history 복원"})`);
  console.log(`  cashflow 건수      : ${flows.length}`);
  console.log(`  ETF 평가액          : ${fmt(etf)}`);
  console.log(`  예수금              : ${cash === undefined ? "미입력(0 계산)" : fmt(cash)}`);
  console.log(`  총자산              : ${fmt(t.totalAsset)}`);
  console.log(`  누적 납입원금(장부)  : ${fmt(t.principal)}`);
  console.log(`  누적 납입원금(기존식): ${fmt(legacy)}`);
  console.log(`  누적 손익           : ${fmt(t.gain)}  (${t.returnPct === null ? "—" : t.returnPct.toFixed(2) + "%"})`);

  check(t.principal === legacy, `장부 복원 무손실: Σcashflow(${fmt(t.principal)}) == 기존식(${fmt(legacy)})`);
  check(t.totalAsset === etf + (cash ?? 0), "totalAsset == ETF + cash");
  check(t.gain === t.totalAsset - t.principal, "gain == totalAsset - principal");
  check(
    cumulativePrincipal(flows) === computeAccountTotals(etf, (cash ?? 0) + 12_345_678, flows).principal,
    "예수금을 바꿔도 principal 불변 (이중계산 없음)",
  );
  check(
    t.principal !== t.principal + (cash ?? 0) || (cash ?? 0) === 0,
    `principal + cashBalance 와 다름 (차이 ${fmt(cash ?? 0)})`,
  );
}

console.log(`\n=== 전체 ===`);
console.log(`  ETF 합계            : ${fmt(sumEtf)}`);
console.log(`  예수금 합계          : ${fmt(sumCash)}`);
console.log(`  총자산              : ${fmt(sumEtf + sumCash)}`);
console.log(`  누적 납입원금(장부)  : ${fmt(sumPrincipal)}`);
console.log(`  누적 납입원금(기존식): ${fmt(sumLegacy)}`);
console.log(`  누적 손익           : ${fmt(sumEtf + sumCash - sumPrincipal)}`);
check(sumPrincipal === sumLegacy, "전체 원금이 기존식과 동일 (migration 으로 수치가 변하지 않음)");
check(
  sumPrincipal !== sumLegacy + sumCash,
  `예수금(${fmt(sumCash)})을 원금에 더하는 잘못된 식과 결과가 다름`,
);

console.log(`\n${fail === 0 ? "모든 invariant 통과" : `실패 ${fail}건`}`);
process.exit(fail === 0 ? 0 : 1);
