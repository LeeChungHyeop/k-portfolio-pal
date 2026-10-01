// read-only 분석 경로 검증 스크립트 (앱 동작에 영향 없음, SELECT만 한다)
//
//   node scripts/verify-live-view.mjs [family_code] [profile]
//
// 1) kaw_data 의 원본 JSONB 를 직접 읽어 앱과 같은 알고리즘(Dashboard.getAccountEtfValues +
//    AccountPage 기준금액 계산)을 JS 로 재현한다.
// 2) 같은 내용을 kaw_portfolio_live_view 에서 읽는다.
// 3) 둘을 1원 단위로 대조한다. 어긋나면 어느 종목/어느 항목인지 찍는다.
//
// .dev.vars 의 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 쓴다(서버 전용 키 — 출력하지 않는다).
import fs from "node:fs";
import path from "node:path";

const ACCOUNTS = ["retirement", "isa", "pension", "irp"];
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
const { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY } = env;
if (!URL_ || !KEY) {
  console.error(".dev.vars 에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");
  process.exit(1);
}

async function rest(pathAndQuery) {
  const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const won = (n) => Math.round(n).toLocaleString("ko-KR");

// ── 1. 원본에서 직접 계산 (앱 알고리즘 재현) ────────────────────────────────
const raw = await rest(
  `kaw_data?select=profile,account_type,data,updated_at&family_code=eq.${FAMILY}` +
  `&profile=in.(${PROFILE},_shared)&order=updated_at.desc`,
);
// 같은 (profile, account_type) 이 여러 행이면 가장 최근 1행만 — view 와 같은 규칙
const latest = new Map();
for (const r of raw) {
  const k = `${r.profile}|${r.account_type}`;
  if (!latest.has(k)) latest.set(k, r);
}
const lib = latest.get("_shared|_assetLib")?.data?.assetLibrary
  ?? latest.get(`${PROFILE}|_meta`)?.data?.assetLibrary
  ?? [];

// 마이그레이션 적용 전에도 스크립트가 돌아가도록 — 캐시가 없으면 전부 snapshot 폴백으로 계산된다
let prices = {};
try {
  prices = Object.fromEntries(
    (await rest("kaw_live_prices?select=ticker,price,source,fetched_at")).map((r) => [r.ticker, r]),
  );
} catch (e) {
  console.log(`\n⚠ kaw_live_prices 조회 실패 — 마이그레이션 미적용으로 보입니다. snapshot 값으로 계산합니다.\n  ${e.message}`);
}

const expected = new Map(); // `${account}|${rowId}` → 계산 결과
const expectedAccounts = new Map();
for (const account of ACCOUNTS) {
  const acc = latest.get(`${PROFILE}|${account}`)?.data;
  if (!acc) continue;
  const hist = [...(acc.history ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const last = hist[hist.length - 1];
  if (!last) continue;
  const risk = acc.profile ?? "growth";
  const alloc = acc.profileAllocations?.[risk] ?? {};
  const rowIds = new Set((acc.profileRows?.[risk] ?? []).map((r) => r.id));

  const items = [];
  for (const [rowId, qty] of Object.entries(last.rowQuantitiesSnap ?? {})) {
    if (!(qty > 0)) continue;
    const etfName = last.rowEtfSnap?.[rowId] ?? rowId;
    const ticker = lib.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker ?? null;
    const cached = ticker ? prices[ticker.toUpperCase()] : undefined;
    const price = cached && Number(cached.price) > 0 ? Number(cached.price) : 0;
    const snapshot = last.rowHoldingsSnap?.[rowId] ?? 0;
    items.push({
      rowId, etfName, ticker, quantity: qty,
      price: price > 0 ? price : null,
      priceSource: price > 0 ? cached.source : "snapshot",
      marketValue: price > 0 ? Math.round(qty * price) : snapshot,
      targetWeightPct: alloc[rowId] ?? 0,
      inTargetProfile: rowIds.has(rowId),
    });
  }
  const pmv = items.reduce((s, i) => s + i.marketValue, 0);
  // 총자산 = ETF 평가액 + 실제 예수금(cashBalance). 월 납입액(deposit)은 더하지 않는다.
  const cash = acc.cashBalance ?? 0;
  const base = pmv + cash;
  expectedAccounts.set(account, {
    rebalanceDate: last.date, risk, deposit: acc.deposit ?? 0, cashBalance: cash,
    portfolioMarketValue: pmv, totalAssetValue: base, rebalanceBaseAmount: base, items,
  });
  for (const i of items) {
    expected.set(`${account}|${i.rowId}`, {
      ...i,
      portfolioMarketValue: pmv,
      cashBalance: cash,
      totalAssetValue: base,
      rebalanceBaseAmount: base,
      targetValue: Math.round(base * i.targetWeightPct / 100),
      rebalanceDiff: Math.round(base * i.targetWeightPct / 100) - i.marketValue,
      currentWeightPct: pmv > 0 ? i.marketValue / pmv * 100 : null,
    });
  }
}

// ── 2. view 에서 읽기 ──────────────────────────────────────────────────────
let viewRows = null;
try {
  viewRows = await rest(
    `kaw_portfolio_live_view?select=*&family_code=eq.${FAMILY}&profile=eq.${PROFILE}`,
  );
} catch (e) {
  console.log(`\n⚠ view 조회 실패 — 마이그레이션이 아직 적용되지 않은 것 같습니다.\n  ${e.message}\n`);
}

// ── 3. 출력 + 대조 ────────────────────────────────────────────────────────
console.log(`\nfamily_code=${FAMILY} / profile=${PROFILE}`);
for (const [account, a] of expectedAccounts) {
  console.log(`\n═══ ${account}  (투자성향 ${a.risk}, 최근 확정 리밸런싱 ${a.rebalanceDate}) ═══`);
  console.log(`  ETF 평가금액 ${won(a.portfolioMarketValue)}원`
    + `  +  실제 예수금 ${won(a.cashBalance)}원`
    + `  =  총자산(리밸런싱 기준금액) ${won(a.totalAssetValue)}원`
    + `   [이번 회차 불입액 ${won(a.deposit)}원 — 기준금액에 포함되지 않는 메타데이터]`);
  console.log("  ETF명 | ticker | 수량 | 현재가(출처) | 평가금액 | 평가비중 | 목표비중 | 목표금액 | 차액");
  for (const i of a.items) {
    const e = expected.get(`${account}|${i.rowId}`);
    console.log(`  ${i.etfName} | ${i.ticker ?? "-"} | ${i.quantity} | `
      + `${i.price ? won(i.price) : "-"}(${i.priceSource}) | ${won(i.marketValue)} | `
      + `${e.currentWeightPct?.toFixed(2)}% | ${i.targetWeightPct}% | ${won(e.targetValue)} | `
      + `${e.rebalanceDiff >= 0 ? "+" : ""}${won(e.rebalanceDiff)}`
      + `${i.inTargetProfile ? "" : "  ※성향에서 삭제된 보유분"}`);
  }
}

if (viewRows) {
  const FIELDS = [
    ["quantity", "보유수량"], ["price", "현재가"], ["market_value", "현재평가금액"],
    ["portfolio_market_value", "ETF평가금액합계"], ["cash_balance", "실제예수금"],
    ["total_asset_value", "총자산"], ["deposit", "불입액"],
    ["rebalance_base_amount", "리밸런싱기준금액"], ["target_weight_pct", "목표비중"],
    ["target_value", "목표금액"], ["rebalance_diff", "목표대비차액"],
  ];
  const problems = [];
  const seen = new Set();
  for (const r of viewRows) {
    const key = `${r.account_type}|${r.row_id}`;
    seen.add(key);
    const e = expected.get(key);
    if (!e) { problems.push(`view 에만 있는 행: ${key}`); continue; }
    if (r.rebalance_date !== expectedAccounts.get(r.account_type).rebalanceDate) {
      problems.push(`${key} rebalance_date: view ${r.rebalance_date} vs 기대 ${expectedAccounts.get(r.account_type).rebalanceDate}`);
    }
    if ((r.ticker ?? null) !== (e.ticker ?? null)) problems.push(`${key} ticker: view ${r.ticker} vs 기대 ${e.ticker}`);
    if (r.price_source !== e.priceSource) problems.push(`${key} price_source: view ${r.price_source} vs 기대 ${e.priceSource}`);
    if (r.in_target_profile !== e.inTargetProfile) problems.push(`${key} in_target_profile: view ${r.in_target_profile} vs 기대 ${e.inTargetProfile}`);
    const expectedVals = {
      quantity: e.quantity, price: e.price, market_value: e.marketValue,
      portfolio_market_value: e.portfolioMarketValue,
      cash_balance: e.cashBalance, total_asset_value: e.totalAssetValue,
      deposit: expectedAccounts.get(r.account_type).deposit,
      rebalance_base_amount: e.rebalanceBaseAmount, target_weight_pct: e.targetWeightPct,
      target_value: e.targetValue, rebalance_diff: e.rebalanceDiff,
    };
    for (const [col, label] of FIELDS) {
      if (!(col in r)) { problems.push(`view 에 ${col} 컬럼이 없습니다 — 002 마이그레이션 미적용`); continue; }
      const got = r[col] === null ? null : Number(r[col]);
      const want = expectedVals[col] === null ? null : Number(expectedVals[col]);
      if (got === null && want === null) continue;
      if (got === null || want === null || Math.abs(got - want) > 0.5) {
        problems.push(`${key} ${label}(${col}): view ${got} vs 기대 ${want}`);
      }
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) problems.push(`view 에 빠진 행: ${key}`);

  console.log(`\n─── view 대조 (${viewRows.length}행) ───`);
  if (!problems.length) console.log("  ✅ 모든 항목이 1원 단위까지 일치");
  else { console.log(`  ❌ 불일치 ${problems.length}건`); for (const p of problems) console.log(`   - ${p}`); }
  process.exitCode = problems.length ? 1 : 0;
}
