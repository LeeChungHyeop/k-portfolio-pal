// ─────────────────────────────────────────────────────────────────────────────
// 수익 분석 엔진 검증 — **읽기 전용**. DB 에 아무것도 쓰지 않는다.
//
//   npm run profit:verify
//
// 네 가지를 production 데이터로 확인한다:
//   1. seam reconciliation — 원장 replay(seam 당일까지) == 첫 유효 anchor 수량
//   2. 계좌별 timeline / 예수금 품질 분포 / 미관측 수입 상한 R
//   3. **bridge 항등식** — segment 손익 == Σ 일간 + Σ 기간외 갭 (오차 0 이어야 한다)
//   4. 실제 daily snapshot 과의 교차검증 (스냅샷은 계산에 쓰지 않는다)
//
// 네이버 시세를 실제로 조회하므로 네트워크가 필요하다.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS, type AccountId } from "../src/lib/kaw/constants";
import { replayDailyHoldings, type LedgerTransaction } from "../src/lib/kaw/ledger";
import {
  buildCoverageMap,
  resolvePerformanceStart,
  STRATEGY_START_DATES,
  type AccountCoverage,
} from "../src/lib/kaw/ledger-coverage";
import {
  buildAccountTimeline,
  reconcileSeam,
  ledgerHoldingsThrough,
  type AccountTimelineInput,
} from "../src/lib/kaw/holdings-timeline";
import {
  buildDerivedCash,
  flowEffectiveDate,
  type DerivedCashSeries,
} from "../src/lib/kaw/derived-cash";
import {
  tradingDatesOf,
  buildCashSeries,
  valuateAccountDays,
  aggregateScope,
  buildSegments,
  computeProfitAnalysis,
  gapProfit,
  type AccountDayValuation,
  type PeriodId,
} from "../src/lib/kaw/profit-analysis";
import { toPriceBarsByTicker } from "../src/lib/kaw/useHistoricalPrices";
import { parseNaverSiseJson, pickBarsInRange } from "../src/lib/kaw/kis-server";

function sb() {
  let url = "",
    key = "";
  for (const line of readFileSync(resolve(process.cwd(), ".dev.vars"), "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (!m) continue;
    if (m[1] === "SUPABASE_URL") url = m[2];
    if (m[1] === "SUPABASE_SERVICE_ROLE_KEY") key = m[2];
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
const n = (v: any) => (typeof v === "number" ? v : Number(v) || 0);
const krw = (v: number) => Math.round(v).toLocaleString();

const c = sb();
const { data: txRows } = await c
  .from("kaw_transaction_ledger")
  .select("*")
  .eq("family_code", "soye")
  .eq("profile", "hyeobi");
const transactions: LedgerTransaction[] = (txRows ?? []).map((r: any) => ({
  id: r.id,
  accountId: r.account_type,
  ticker: r.ticker,
  etfName: r.etf_name,
  side: r.side === "sell" ? "sell" : "buy",
  quantity: n(r.quantity),
  price: n(r.price),
  amount: n(r.amount),
  tradeDate: r.trade_date,
  settlementDate: r.settlement_date,
  inferredTradeDate: r.inferred_trade_date,
  eventDate: r.event_date,
  tradeDateEvidence: r.trade_date_evidence,
  fee: r.fee == null ? null : n(r.fee),
  tax: r.tax == null ? null : n(r.tax),
  postQuantity: null,
  source: r.source,
  sourceRow: r.source_row,
}));
const { data: dataRows } = await c
  .from("kaw_data")
  .select("account_type, data")
  .eq("family_code", "soye")
  .eq("profile", "hyeobi");
const accMap = new Map<string, any>();
for (const r of dataRows ?? []) accMap.set((r as any).account_type, (r as any).data ?? {});
const library = (accMap.get("_meta")?.assetLibrary ?? []) as any[];

// ── 가격: 원장 ticker + anchor ticker 전부
const tickers = new Set<string>(transactions.map((t) => t.ticker));
for (const id of ACCOUNT_IDS) {
  for (const h of accMap.get(id)?.history ?? []) {
    for (const nm of Object.values(h?.rowEtfSnap ?? {})) {
      const hit = library.find((a) => a?.defaultEtf === nm);
      if (hit?.ticker) tickers.add(hit.ticker);
    }
  }
}
const FROM = "2025-03-01"; // 계좌 개시일(2025-03-25) 이전부터 — derived cash 가 전 구간을 봐야 한다
const TO = new Date().toISOString().slice(0, 10);
console.log(`가격 조회: ${[...tickers].length}종목  ${FROM} ~ ${TO}`);
const seriesPayload: Record<string, { date: string; price: number; open: number }[]> = {};
for (const t of [...tickers].sort()) {
  const res = await fetch(
    `https://api.finance.naver.com/siseJson.naver?symbol=${t}&requestType=1` +
      `&startTime=${FROM.replaceAll("-", "")}&endTime=${TO.replaceAll("-", "")}&timeframe=day`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://finance.naver.com/",
      },
    },
  );
  const bars = pickBarsInRange(parseNaverSiseJson(await res.text()), FROM, TO);
  seriesPayload[t] = bars.map((b) => ({ date: b.date, price: b.close, open: b.open }));
}
const bars = toPriceBarsByTicker({ series: seriesPayload });
const tradingDates = tradingDatesOf(bars);
console.log(`거래일 ${tradingDates.length}일: ${tradingDates[0]} ~ ${tradingDates.at(-1)}\n`);

// ── coverage
const dailyByAccount = replayDailyHoldings(transactions);
const coverage0 = buildCoverageMap(
  ACCOUNT_IDS.map((id) => ({
    accountId: id,
    ledgerDates: transactions.filter((t) => t.accountId === id).map((t) => t.eventDate),
    cashflowDates: (accMap.get(id)?.cashflows ?? []).map((f: any) => String(f.date)),
    history: accMap.get(id)?.history ?? [],
  })),
);
const prevDay = (d: string) =>
  new Date(Date.parse(d + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
const coverages: AccountCoverage[] = [];
for (const id of ACCOUNT_IDS) {
  const before = ledgerHoldingsThrough(dailyByAccount[id] ?? [], prevDay(STRATEGY_START_DATES[id]));
  coverages.push(resolvePerformanceStart(coverage0[id], before, tradingDates));
}

console.log("── coverage ──");
for (const cv of coverages) {
  console.log(
    `  ${cv.accountId.padEnd(11)} 개시 ${cv.inception}  전략 ${cv.strategyStart}` +
      `  성과시작 ${cv.performanceStart}${cv.strategyStartIsTransition ? " (전환일 제외)" : ""}` +
      `  seam ${cv.seam}  cutoff ${cv.ledgerCutoff}`,
  );
}

// ── seam reconciliation
console.log("\n── seam reconciliation ──");
let seamBad = 0;
const timelineInputs: AccountTimelineInput[] = coverages.map((cv) => ({
  accountId: cv.accountId,
  coverage: cv,
  ledgerDays: dailyByAccount[cv.accountId] ?? [],
  history: accMap.get(cv.accountId)?.history ?? [],
}));
for (const ti of timelineInputs) {
  const r = reconcileSeam(ti, library);
  if (!r.ok) seamBad++;
  console.log(
    `  ${r.accountId.padEnd(11)} seam ${r.seam}  비교 ${r.compared}  불일치 ${r.mismatches.length}` +
      `${r.unresolved.length ? "  미해결 " + r.unresolved.join(",") : ""}  ${r.ok ? "OK" : "FAIL"}`,
  );
  for (const m of r.mismatches)
    console.log(`       ${m.ticker} ledger ${m.ledger} vs anchor ${m.anchor}`);
}
console.log(`  → seam 실패 계좌 ${seamBad}`);

// ── derived cash + valuation
const valuations: AccountDayValuation[] = [];
const incomeSources: { accountId: string; derived: DerivedCashSeries; cap: number | null }[] = [];
const allFlows: { accountId: string; date: string; amount: number }[] = [];
console.log("\n── 계좌별 timeline / cash ──");
for (const ti of timelineInputs) {
  const acc = accMap.get(ti.accountId) ?? {};
  const flows = (acc.cashflows ?? []).map((f: any) => ({
    date: String(f.date),
    amount: n(f.amount),
    timing: f.timing,
  }));
  const derived = buildDerivedCash({
    flows,
    trades: transactions
      .filter((t) => t.accountId === ti.accountId)
      .map((t) => ({
        date: t.eventDate,
        side: t.side,
        amount: t.amount,
        fee: t.fee,
        tax: t.tax,
      })),
    tradingDates,
  });
  const days = buildAccountTimeline(ti, library, tradingDates);
  const cash = buildCashSeries(
    { accountId: ti.accountId, coverage: ti.coverage, derived, flows, tradingDates },
    days,
    bars,
  );
  const vals = valuateAccountDays(days, cash, bars);
  valuations.push(...vals);

  // cap: cutoff 가 그 계좌의 마지막 활동이고 cutoff 이후 흐름이 없을 때만 유효
  const latestAnchor = ti.coverage.anchorDates.at(-1) ?? null;
  const flowsAfter = flows.filter((f: any) => f.date > (ti.coverage.ledgerCutoff ?? ""));
  const capValid =
    !!ti.coverage.ledgerCutoff &&
    latestAnchor !== null &&
    ti.coverage.ledgerCutoff >= latestAnchor &&
    flowsAfter.length === 0;
  let cap: number | null = null;
  if (capValid) {
    let model = 0;
    for (const d of derived.dates) {
      if (d > ti.coverage.ledgerCutoff!) break;
      model = derived.byDate.get(d)!.cash;
    }
    cap = n(acc.cashBalance) - model;
  }
  incomeSources.push({ accountId: ti.accountId, derived, cap });
  for (const f of flows) {
    const e = flowEffectiveDate(tradingDates, f);
    if (e && ti.coverage.performanceStart && e >= ti.coverage.performanceStart) {
      allFlows.push({ accountId: ti.accountId, date: e, amount: f.amount });
    }
  }
  const unusable = vals.filter((v) => !v.usable);
  const qCount = new Map<string, number>();
  for (const v of vals) qCount.set(v.cashQuality, (qCount.get(v.cashQuality) ?? 0) + 1);
  console.log(
    `  ${ti.accountId.padEnd(11)} 거래일 ${String(vals.length).padStart(3)}  평가불가 ${unusable.length}` +
      `  cash품질 ${[...qCount].map(([k, v]) => k + ":" + v).join(" ")}  cap ${cap === null ? "없음" : krw(cap)}`,
  );
  if (unusable.length) {
    console.log(
      `       불가 날짜 예: ${unusable
        .slice(0, 4)
        .map((u) => u.date + "(" + u.missing.join(",") + ")")
        .join(" ")}`,
    );
  }
}

// ── bridge 항등식 검증 (전체 scope, monthly)
console.log("\n── bridge 항등식: segment = Σ daily + Σ gap ──");
const scopeAll = [...ACCOUNT_IDS] as string[];
const scopeDays = aggregateScope(valuations, coverages, scopeAll);
console.log(
  `  전체 scope usable 거래일 ${scopeDays.length}일: ${scopeDays[0]?.date} ~ ${scopeDays.at(-1)?.date}`,
);
const flowPoints = allFlows.map((f) => ({ date: f.date, amount: f.amount }));
{
  const months = buildSegments(
    scopeDays.map((d) => d.date),
    "monthly",
  );
  const byDate = new Map(scopeDays.map((d) => [d.date, d]));
  let worst = 0;
  for (const seg of months) {
    const segF = flowPoints
      .filter((f) => f.date >= seg.openDate && f.date <= seg.closeDate)
      .reduce((s, f) => s + f.amount, 0);
    const segProfit = byDate.get(seg.closeDate)!.vClose - byDate.get(seg.openDate)!.vOpen - segF;
    let dailySum = 0,
      gapSum = 0;
    for (let i = 0; i < seg.dates.length; i++) {
      const d = byDate.get(seg.dates[i])!;
      const dF = flowPoints.filter((f) => f.date === d.date).reduce((s, f) => s + f.amount, 0);
      dailySum += d.vClose - d.vOpen - dF;
      if (i > 0) gapSum += gapProfit(byDate.get(seg.dates[i - 1])!, d);
    }
    const diff = segProfit - (dailySum + gapSum);
    worst = Math.max(worst, Math.abs(diff));
    console.log(
      `  ${seg.key}  월간 ${krw(segProfit).padStart(12)}` +
        `  = Σ일간 ${krw(dailySum).padStart(12)} + Σ갭 ${krw(gapSum).padStart(12)}` +
        `   오차 ${diff.toFixed(6)}`,
    );
  }
  console.log(`  → 최대 오차 ${worst.toFixed(6)} (0 이어야 정상)`);
}

// ── 수익률 sanity check — 분모가 자본 규모를 벗어나면 실패
{
  console.log("\n── 수익률 sanity check (분모 규모 / 분자 이중계산) ──");
  let bad = 0;
  for (const period of ["yearly", "monthly"] as PeriodId[]) {
    const res = computeProfitAnalysis({
      valuations,
      coverages,
      scopeAccountIds: scopeAll,
      period,
      flows: flowPoints,
      incomeSources,
    });
    for (const r of res) {
      const grossIn = flowPoints
        .filter((f) => f.date >= r.openDate && f.date <= r.closeDate && f.amount > 0)
        .reduce((s, f) => s + f.amount, 0);
      const lo = r.beginningTotal;
      const hi = r.beginningTotal + grossIn;
      const inRange = r.averageCapital >= lo - 1 && r.averageCapital <= hi + 1;
      const pctOk =
        r.returnPctLow === null ||
        Math.abs(r.returnPctLow - (r.knownProfit / r.averageCapital) * 100) < 1e-9;
      if (!inRange || !pctOk) bad++;
      console.log(
        `  ${period.padEnd(8)}${r.key.padEnd(9)}` +
          ` 분모 ${krw(r.averageCapital).padStart(13)}` +
          ` [${krw(lo)} ~ ${krw(hi)}] ${inRange ? "OK" : "*** 범위 밖"}` +
          `  수익률==손익/분모 ${pctOk ? "OK" : "*** 불일치"}`,
      );
    }
  }
  console.log(`  → 실패 ${bad}건 (0 이어야 정상)`);
}

// ── 실제 생성되는 기간 목록
for (const period of ["yearly", "monthly"] as PeriodId[]) {
  console.log(`\n── 전체 scope / ${period} ──`);
  const res = computeProfitAnalysis({
    valuations,
    coverages,
    scopeAccountIds: scopeAll,
    period,
    flows: flowPoints,
    incomeSources,
  });
  for (const r of res) {
    console.log(
      `  ${r.label.padEnd(22)} ${r.openDate}→${r.closeDate}` +
        `  기초 ${krw(r.beginningTotal).padStart(12)} 기말 ${krw(r.endingTotal).padStart(12)}` +
        `  흐름 ${krw(r.netCashflow).padStart(11)}  손익 ${krw(r.knownProfit).padStart(11)}` +
        `  ${r.returnPctLow === null ? "—" : r.returnPctLow.toFixed(2) + "%"}` +
        `${r.returnPctHigh !== null && Math.abs(r.returnPctHigh - (r.returnPctLow ?? 0)) > 0.005 ? "~" + r.returnPctHigh.toFixed(2) + "%" : ""}` +
        `  ${r.span}/${r.cashQuality}${r.exact ? "/exact" : ""}`,
    );
  }
}
{
  const daily = computeProfitAnalysis({
    valuations,
    coverages,
    scopeAccountIds: scopeAll,
    period: "daily",
    flows: flowPoints,
    incomeSources,
  });
  console.log(
    `\n── 전체 scope / daily: ${daily.length}개 구간 ` +
      `${daily[0]?.openDate} ~ ${daily.at(-1)?.closeDate} ──`,
  );
  for (const r of daily.slice(0, 3))
    console.log(
      `  ${r.openDate} 손익 ${krw(r.knownProfit).padStart(11)} ${r.returnPctLow?.toFixed(3)}%`,
    );
  console.log("  ...");
  for (const r of daily.slice(-3))
    console.log(
      `  ${r.openDate} 손익 ${krw(r.knownProfit).padStart(11)} ${r.returnPctLow?.toFixed(3)}%`,
    );
}

// ── 계좌별 연간
for (const id of ACCOUNT_IDS) {
  const res = computeProfitAnalysis({
    valuations,
    coverages,
    scopeAccountIds: [id],
    period: "yearly",
    flows: flowPoints.filter((f) =>
      allFlows.some((a) => a.accountId === id && a.date === f.date && a.amount === f.amount),
    ),
    incomeSources,
  });
  console.log(`\n── ${id} / yearly ──`);
  for (const r of res) {
    console.log(
      `  ${r.label.padEnd(22)} ${r.openDate}→${r.closeDate}  손익 ${krw(r.knownProfit).padStart(12)}` +
        `  ${r.returnPctLow?.toFixed(2)}%  ${r.span}/${r.cashQuality}${r.exact ? "/exact" : ""}`,
    );
  }
}

// ── 실제 snapshot 교차검증
const { data: snaps } = await c
  .from("kaw_daily_portfolio_snapshots")
  .select("snapshot_date, account_type, total_asset_value, cash_balance")
  .eq("family_code", "soye")
  .eq("profile", "hyeobi");
console.log("\n── 실제 daily snapshot 교차검증 (계산에는 쓰지 않는다) ──");
for (const s of (snaps ?? []).sort(
  (a: any, b: any) =>
    String(a.snapshot_date).localeCompare(String(b.snapshot_date)) ||
    String(a.account_type).localeCompare(String(b.account_type)),
)) {
  const v = valuations.find(
    (x) => x.date === (s as any).snapshot_date && x.accountId === (s as any).account_type,
  );
  if (!v?.usable) {
    console.log(`  ${(s as any).snapshot_date} ${(s as any).account_type.padEnd(11)} 평가 없음`);
    continue;
  }
  const diff = v.vClose - n((s as any).total_asset_value);
  const pct = n((s as any).total_asset_value) ? (diff / n((s as any).total_asset_value)) * 100 : 0;
  console.log(
    `  ${(s as any).snapshot_date} ${(s as any).account_type.padEnd(11)}` +
      ` 엔진 ${krw(v.vClose).padStart(12)}  스냅샷 ${krw(n((s as any).total_asset_value)).padStart(12)}` +
      `  차이 ${krw(diff).padStart(10)} (${pct.toFixed(3)}%)`,
  );
}
