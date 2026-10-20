// ─────────────────────────────────────────────────────────────────────────────
// 계좌 상태 동기화 (broker_sync) — 순수 모듈 (Phase 4-D)
//
// 계좌 이전(미래에셋 → 한국투자)으로 앱의 "확정 보유내역"(마지막 리밸런싱 이력)과 "현재 예수금"이 실제와 어긋났다.
// 이것은 **리밸런싱이 아니라 증권사 이전에 따른 상태 정정**이다. 그래서 리밸런싱 이력(`history`)에 넣지 않고
// 별도 필드 `AccountState.brokerSyncs[]` 에 기록한다.
//
// ## 왜 history 에 넣지 않는가
//   history 를 읽는 모듈은 20여 곳이고 대부분이 "리밸런싱 기록"으로 읽는다(백테스트 · legacy 수익률 · 벤치마크 ·
//   납입 이관 · 차트). broker_sync 를 거기 넣으면 한 곳만 빠져도 가짜 리밸런싱 손익이 생긴다.
//   별도 필드에 두면 **빠뜨린 곳의 실패 방식이 '이전 값 유지'(안전)** 이고, "보유수량 근거"를 읽는 소수 지점만
//   `holdingsBasisOf()` 로 바꾸면 된다.
//
// ## 날짜를 섞지 않는다
//   holdingsEffectiveFrom   보유수량이 효력을 갖는 날 = 원장 마지막 거래일 = 한국투자 실제 체결일 (2026-10-14)
//   cash.stateAsOf          예수금을 **관측한** 증권사 기준일 (유효시점이 아니다)
//   cash.observedAt         우리가 조회한 시각
//   approvedAt              사용자가 승인한 시각
//   transfer.anchorDate     미래에셋 추정 매도의 회계 기준일 (2026-10-13, 실제 매도일 아님)
//   실제 현금 입고 일자는 모른다 — 기록하지 않는다.
//   관측 예수금을 '그 날의 실제 잔고'처럼 effective-dated 로 쓰지 않는다(`cash.effectiveFrom = null`).
//
// ## 하지 않는 것
//   · 거래원장 · cashflow(납입원금) · baseAmount · deposit · history 12건 · 기존 일별 스냅샷을 바꾸지 않는다
//   · 현금 보정 거래 · 신규 납입 · 배당/이자 수입을 만들지 않는다 (createsCashflow/createsTrade = false)
//   · 예수금 차이(74,194원)와 이전 대사 차이(335원)를 분류하지 않는다 — 원인 미확정으로 보존한다
//   · R(미관측 현금수입 상한)은 **수익으로 확정하지 않는다** — 모델이 허용하는 가능한 범위일 뿐이다
// ─────────────────────────────────────────────────────────────────────────────

import { replayFinalHoldings, type LedgerTransaction } from "./ledger";
import { cashAtClose, buildDerivedCash, type CashFlowInput } from "./derived-cash";
import type { TransferRecord } from "./account-transfer-record";
import { NEW_BROKER_LEDGER_SOURCE } from "./account-transfer-record";
import { reconcileTransfer, type ReconcileResult } from "./transfer-reconciliation";
import { weekdaysBetween } from "./kis-execution-compose";
import { canonicalJson, stableDigest } from "./rebalance-plan";
import {
  BROKER_SYNC_VERSION, asBrokerSyncs, holdingsAnchorsOf, holdingsBasisOf, syncAsHoldingsBasis,
  type BrokerSyncRecord, type CashBalanceObservation, type HoldingsBasis, type HistoryLike,
} from "./broker-sync-basis";

export { BROKER_SYNC_VERSION, asBrokerSyncs, holdingsAnchorsOf, holdingsBasisOf, syncAsHoldingsBasis };
export type { BrokerSyncRecord, CashBalanceObservation, HoldingsBasis };

export const BROKER_SYNC_AUDIT_ACTION = "broker_sync_apply";
/** 동기화로 바뀔 수 있는 계좌 문서 키. 이 밖의 키는 한 글자도 바뀌지 않아야 한다 */
export const BROKER_SYNC_MUTABLE_KEYS = ["liveQuantities", "rowHoldings", "cashBalance", "cashBalanceObservation", "brokerSyncs"] as const;

// ── 계획 · 판정 ─────────────────────────────────────────────────────────────

export type SyncBlockerCode =
  | "flag_off" | "balance_unavailable" | "balance_stale" | "transfer_unconfirmed" | "ledger_not_covering"
  | "holdings_mismatch" | "corrections_present" | "unmapped_ticker" | "unresolved_row" | "ambiguous_row"
  | "history_newer" | "already_synced" | "invalid_cash" | "account_inactive";

export interface SyncBlocker { code: SyncBlockerCode; message: string }

export interface LibraryEntry { defaultEtf: string; ticker?: string }

export interface SyncBalance {
  holdings: Record<string, number>;
  cash: number;
  stateAsOf: string;
  observedAt: string;
  source: "kis_live_read" | "stored_observation";
  captureId: string | null;
}

export interface SyncEvalInput {
  flagEnabled: boolean;
  /** 계좌 문서(kaw_data.data) — 읽기 전용으로만 쓴다 */
  doc: Record<string, unknown>;
  revision: number;
  library: readonly LibraryEntry[];
  /** 정정이 적용된 이 계좌(pension)의 유효 원장 */
  ledger: readonly LedgerTransaction[];
  correctionsPresent: boolean;
  transfers: readonly TransferRecord[];
  /** 증권사 잔고 — 방금 읽은 값이거나 저장된 관측. 없으면 null */
  balance: SyncBalance | null;
  balanceFailure?: string | null;
  flows: readonly CashFlowInput[];
  /** 이 계좌의 기존 일별 스냅샷 날짜들 (읽기 전용) */
  snapshotDates: readonly string[];
  /** KST 오늘 YYYY-MM-DD */
  today: string;
  /** 사용자가 '오래된 관측 사용'을 별도로 승인했는가 */
  staleObservationApproved: boolean;
}

export interface SyncRowView {
  rowId: string;
  etfName: string;
  ticker: string | null;
  quantityBefore: number;
  quantityAfter: number;
}

export interface SyncPlanView {
  planHash: string;
  recordId: string;
  holdingsEffectiveFrom: string;
  rows: SyncRowView[];
  cash: { before: number | null; after: number; stateAsOf: string; observedAt: string; source: SyncBalance["source"]; fresh: boolean };
  principal: { amount: number; unchanged: true };
  /** 바뀌지 않는 것들 */
  untouched: { historyCount: number; cashflowCount: number; baseAmount: number | null };
  reconciliation: ReconcileResult | null;
  incomeRangeUpper: number | null;
  affectedSnapshotDates: string[];
  transfer: { anchorDate: string; amount: number };
}

export interface SyncWrite {
  /** 새 계좌 문서 전체 (변경 키 5개만 다르다) */
  newData: Record<string, unknown>;
  record: BrokerSyncRecord;
  expect: {
    account_type: "pension";
    expected_revision: number;
    instance_id: string;
    holdings_by_ticker: Record<string, number>;
    live_quantities: Record<string, number>;
    cash_amount: number;
    record_id: string;
  };
}

export interface SyncEvaluation {
  eligible: boolean;
  flagEnabled: boolean;
  enabled: boolean;
  alreadySynced: boolean;
  needsStaleApproval: boolean;
  blockers: SyncBlocker[];
  plan: SyncPlanView | null;
  write: SyncWrite | null;
}

const numRecord = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = Number(x) || 0;
  return out;
};
const strRecord = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  return out;
};
const nonZero = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
const mapsEqual = (a: Record<string, number>, b: Record<string, number>) => canonicalJson(nonZero(a)) === canonicalJson(nonZero(b));
const fmtMap = (m: Record<string, number>) => Object.entries(nonZero(m)).map(([k, v]) => `${k} ${v}주`).join(", ") || "없음";

/** 계좌 문서에서 행 id → ETF명을 모은다. 현재 행 정의(assetRows · profileRows)와 마지막 이력의 이름 */
export function rowNamesOf(doc: Record<string, unknown>): { names: Record<string, string>; labels: Record<string, string>; assets: Record<string, string> } {
  const names: Record<string, string> = {}, labels: Record<string, string> = {}, assets: Record<string, string> = {};
  const hist = (Array.isArray(doc.history) ? doc.history : []) as HistoryLike[];
  for (const h of [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    Object.assign(names, strRecord(h.rowEtfSnap));
    Object.assign(labels, strRecord(h.rowLabelSnap));
    Object.assign(assets, strRecord(h.rowAssetSnap));
  }
  const put = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r?.id !== "string") continue;
      if (typeof r.etfName === "string") names[r.id] = r.etfName;
      if (typeof r.assetId === "string") assets[r.id] = r.assetId;
    }
  };
  put(doc.assetRows);
  if (doc.profileRows && typeof doc.profileRows === "object") for (const rows of Object.values(doc.profileRows as Record<string, unknown>)) put(rows);
  return { names, labels, assets };
}

export function evaluateBrokerSync(input: SyncEvalInput): SyncEvaluation {
  const blockers: SyncBlocker[] = [];
  const add = (code: SyncBlockerCode, message: string) => blockers.push({ code, message });
  const doc = input.doc;
  const history = (Array.isArray(doc.history) ? doc.history : []) as HistoryLike[];
  const existing = asBrokerSyncs(doc.brokerSyncs);

  if (doc.active === false) add("account_inactive", "비활성 계좌입니다.");

  // 1) 이전 확정(4-C-1) · 원장 상태
  const pension = input.ledger.filter((t) => t.accountId === "pension");
  const transfer = [...input.transfers].sort((a, b) => b.approval.at.localeCompare(a.approval.at))[0] ?? null;
  if (!transfer) add("transfer_unconfirmed", "사용자가 확정한 계좌 이전 기록이 없습니다(Phase 4-C-1).");
  const kisRows = pension.filter((t) => t.source === NEW_BROKER_LEDGER_SOURCE);
  const cutoff = pension.map((t) => String(t.eventDate).slice(0, 10)).sort().at(-1) ?? null;
  if (!cutoff || (transfer && cutoff < transfer.anchorDate) || kisRows.length === 0) {
    add("ledger_not_covering", "원장에 한국투자 실제 체결이 반영돼 있지 않아 보유수량의 근거가 없습니다(Phase 4-C-2 먼저).");
  }
  if (input.correctionsPresent) add("corrections_present", "이 계좌에 거래 정정(overlay)이 있어 자동 동기화하지 않습니다.");

  // 2) 증권사 잔고(보유 · 예수금)
  const bal = input.balance;
  if (!bal) {
    add("balance_unavailable", input.balanceFailure
      ? `한국투자 잔고를 읽지 못했고 저장된 관측도 없습니다(${input.balanceFailure}).`
      : "한국투자 잔고 관측이 없습니다.");
  } else if (!Number.isFinite(bal.cash) || bal.cash < 0 || !Number.isInteger(bal.cash)) {
    add("invalid_cash", "예수금 값이 올바르지 않습니다.");
  }
  const fresh = !!bal && bal.stateAsOf === input.today;
  const needsStaleApproval = !!bal && !fresh;
  if (needsStaleApproval && !input.staleObservationApproved) {
    add("balance_stale", `증권사 잔고의 기준일(${bal!.stateAsOf})이 오늘(${input.today})이 아닙니다 — 현재 시점의 잔고가 아닙니다. 오래된 관측을 쓰려면 별도 승인이 필요합니다.`);
  }

  // 3) 원장 재생 == 증권사 보유 (양방향 완전 일치)
  const replay = (replayFinalHoldings(pension).pension ?? {}) as Record<string, number>;
  if (bal && !mapsEqual(replay, bal.holdings)) {
    add("holdings_mismatch", `원장 재생 보유(${fmtMap(replay)})가 한국투자 잔고(${fmtMap(bal.holdings)})와 다릅니다.`);
  }

  // 4) 이력이 동기화 효력일보다 늦으면 이력이 이미 더 최신 근거다
  if (cutoff && history.some((h) => String(h.date) > cutoff)) {
    add("history_newer", "동기화 효력일보다 늦은 리밸런싱 이력이 있어 이력이 이미 더 최신 근거입니다.");
  }

  // 5) 행 매핑 — 조용히 버리지 않는다(fail closed)
  const { names, labels, assets } = rowNamesOf(doc);
  const live = numRecord(doc.liveQuantities);
  const tickerOf = (etf: string | undefined) => (etf ? input.library.find((l) => l.defaultEtf === etf && l.ticker)?.ticker?.toUpperCase() ?? null : null);
  const rowIds = [...new Set([...Object.keys(live), ...Object.keys(numRecord(doc.rowHoldings))])];
  const rowTicker: Record<string, string | null> = {};
  for (const id of rowIds) rowTicker[id] = tickerOf(names[id]);
  for (const id of rowIds) {
    if (rowTicker[id] === null && (live[id] ?? 0) > 0) add("unresolved_row", `보유 중인 행(${names[id] ?? id})의 종목코드를 찾지 못했습니다.`);
  }
  const byTicker: Record<string, string[]> = {};
  for (const id of rowIds) if (rowTicker[id]) (byTicker[rowTicker[id]!] ??= []).push(id);
  const newQty: Record<string, number> = {};
  for (const id of rowIds) newQty[id] = 0;
  for (const [ticker, qty] of Object.entries(replay)) {
    if (qty === 0) continue;
    const rows = byTicker[ticker.toUpperCase()] ?? [];
    if (rows.length === 0) { add("unmapped_ticker", `원장 보유 종목 ${ticker} 에 해당하는 계좌 행이 없습니다.`); continue; }
    const holding = rows.filter((r) => (live[r] ?? 0) > 0);
    if (rows.length > 1 && holding.length !== 1) { add("ambiguous_row", `종목 ${ticker} 가 여러 행에 걸쳐 있어 어느 행에 반영할지 정할 수 없습니다.`); continue; }
    newQty[holding[0] ?? rows[0]] = qty;
  }

  // 6) 새 값 — 변경 키 5개만
  const acquisition: Record<string, number> = {};
  for (const id of rowIds) acquisition[id] = 0;
  for (const t of kisRows) {
    if (t.side !== "buy") continue;
    const rows = byTicker[t.ticker.toUpperCase()] ?? [];
    const target = rows.find((r) => newQty[r] > 0) ?? rows[0];
    if (target) acquisition[target] = (acquisition[target] ?? 0) + t.amount;
  }

  const principal = input.flows.reduce((s, f) => s + f.amount, 0);
  const rowEtfSnap: Record<string, string> = {}, rowLabelSnap: Record<string, string> = {}, rowAssetSnap: Record<string, string> = {};
  for (const id of rowIds) {
    rowEtfSnap[id] = names[id] ?? id;
    rowLabelSnap[id] = labels[id] ?? names[id] ?? id;
    rowAssetSnap[id] = assets[id] ?? id;
  }

  // 7) 자금 대사 — 차이의 크기만. 분류하지 않는다
  let reconciliation: ReconcileResult | null = null;
  let incomeRangeUpper: number | null = null;
  if (bal && transfer) {
    const kisBuy = kisRows.filter((t) => t.side === "buy").reduce((s, t) => s + t.amount, 0);
    const trades = pension.map((t) => ({ date: String(t.eventDate).slice(0, 10), side: t.side, amount: t.amount, fee: t.fee, tax: t.tax }));
    const dates = [...input.flows.map((f) => f.date), ...trades.map((t) => t.date)].sort();
    const td = dates.length ? weekdaysBetween(dates[0], input.today > dates.at(-1)! ? input.today : dates.at(-1)!) : [];
    const derived = buildDerivedCash({ flows: input.flows, trades, tradingDates: td });
    reconciliation = reconcileTransfer({
      transferAmount: transfer.cashReceived.amount, kisBuyAmount: kisBuy, kisBuyAmountAlreadyInLedger: kisBuy,
      ledgerDerivedCash: derived.finalDerived, observedCash: bal.cash, principalBefore: principal, principalAfter: principal,
    });
    // R = 관측 예수금 − 모델 현금(컷오프). 음수면 0 — 앱 성과분석의 정의와 같다(ProfitAnalysisSection)
    if (cutoff) incomeRangeUpper = Math.max(0, bal.cash - cashAtClose(derived, cutoff));
  }

  const affected = cutoff ? input.snapshotDates.filter((d) => d >= cutoff).sort() : [];

  // 8) 기록 · 해시
  // 해시 = 사용자가 승인하는 '무엇이 어떻게 바뀌는가'. 승인 플래그(오래된 관측 허용)는 상태가 아니라 승인 행위라 넣지 않는다.
  // 계좌 문서의 revision 도 넣지 않는다(화면을 열기만 해도 올라간다) — 대신 바뀔 값의 '현재값'을 넣어, 그 사이 사용자가
  // 수량·예수금을 고치면 해시가 달라진다. 저장 시점의 충돌은 DB 의 revision CAS 가 따로 막는다.
  const core = {
    effectiveFrom: cutoff, newQty: nonZero(newQty), rowIds: [...rowIds].sort(),
    cash: bal ? [bal.cash, bal.stateAsOf, bal.source, fresh] : null, replay: nonZero(replay),
    liveBefore: nonZero(live), cashBefore: typeof doc.cashBalance === "number" ? doc.cashBalance : null,
    rowHoldingsBefore: nonZero(numRecord(doc.rowHoldings)),
    hist: history.map((h) => h.id).sort(), syncs: existing.map((x) => x.id).sort(),
    transfer: transfer ? transfer.approval.at : null, ledger: [pension.length, kisRows.length],
  };
  const planHash = `s1|${stableDigest(canonicalJson(core))}`;
  // 기록 id 는 '같은 상태의 재동기화'를 감지하는 용도 — 현재값(before)과 기존 기록은 넣지 않는다
  const recordId = `bsync:${stableDigest(canonicalJson({
    effectiveFrom: cutoff, newQty: nonZero(newQty), cash: bal ? [bal.cash, bal.stateAsOf] : null, replay: nonZero(replay),
    transfer: transfer ? transfer.approval.at : null, ledger: [pension.length, kisRows.length],
  })).slice(0, 24)}`;
  if (existing.some((s) => s.id === recordId)) add("already_synced", "같은 상태의 동기화가 이미 기록돼 있습니다.");

  const eligible = blockers.every((b) => b.code === "flag_off");
  const alreadySynced = blockers.some((b) => b.code === "already_synced");
  const canPlan = !!bal && !!transfer && !!cutoff && !blockers.some((b) => ["holdings_mismatch", "unmapped_ticker", "unresolved_row", "ambiguous_row", "ledger_not_covering", "invalid_cash"].includes(b.code));

  let plan: SyncPlanView | null = null;
  let write: SyncWrite | null = null;
  if (canPlan && bal && transfer && cutoff) {
    const cashBefore = typeof doc.cashBalance === "number" ? doc.cashBalance : null;
    plan = {
      planHash, recordId, holdingsEffectiveFrom: cutoff,
      rows: rowIds.map((id) => ({ rowId: id, etfName: names[id] ?? id, ticker: rowTicker[id], quantityBefore: live[id] ?? 0, quantityAfter: newQty[id] ?? 0 })),
      cash: { before: cashBefore, after: bal.cash, stateAsOf: bal.stateAsOf, observedAt: bal.observedAt, source: bal.source, fresh },
      principal: { amount: principal, unchanged: true },
      untouched: { historyCount: history.length, cashflowCount: Array.isArray(doc.cashflows) ? doc.cashflows.length : 0, baseAmount: typeof doc.baseAmount === "number" ? doc.baseAmount : null },
      reconciliation, incomeRangeUpper, affectedSnapshotDates: affected,
      transfer: { anchorDate: transfer.anchorDate, amount: transfer.cashReceived.amount },
    };
    const record: BrokerSyncRecord = {
      id: recordId, kind: "broker_sync", version: BROKER_SYNC_VERSION, accountType: "pension",
      holdingsEffectiveFrom: cutoff, holdingsBasis: "ledger_replay_verified_by_broker_balance",
      quantities: newQty, rowEtfSnap, rowLabelSnap, rowAssetSnap, rowHoldingsSnap: acquisition, rowHoldingsBasis: "ledger_acquisition_amount",
      holdingsByTicker: nonZero(replay),
      cash: { amount: bal.cash, basis: "broker_observation", source: bal.source, stateAsOf: bal.stateAsOf, observedAt: bal.observedAt, fresh, effectiveFrom: null, captureId: bal.captureId },
      approvedAt: "", approvedBy: "", staleObservationApproved: needsStaleApproval && input.staleObservationApproved,
      transfer: { toInstanceId: transfer.toInstanceId, anchorDate: transfer.anchorDate, approvedAt: transfer.approval.at, containsEstimates: transfer.containsEstimates },
      ledger: { cutoff, rowCount: pension.length, kisRowCount: kisRows.length },
      principal: { amount: principal },
      unconfirmedDifferences: reconciliation?.lines.map((l) => ({ id: l.id, difference: l.difference, status: l.status })) ?? [],
      incomeRangeUpper: { amount: incomeRangeUpper, meaning: "model_possible_range_not_confirmed_income" },
      affectedSnapshots: affected.length ? { dates: affected, reason: "computed_from_pre_transfer_holdings_and_cash", preserved: true } : null,
      notRebalance: true, createsCashflow: false, createsTrade: false, changesBaseAmount: false, planHash,
    };
    const newData: Record<string, unknown> = {
      ...doc,
      liveQuantities: newQty,
      rowHoldings: acquisition,
      cashBalance: bal.cash,
      cashBalanceObservation: { stateAsOf: bal.stateAsOf, observedAt: bal.observedAt, source: bal.source, basis: "broker_observation", effectiveFrom: null, syncId: recordId } satisfies CashBalanceObservation,
      brokerSyncs: [...existing, record],
    };
    write = {
      newData, record,
      expect: {
        account_type: "pension", expected_revision: input.revision, instance_id: transfer.toInstanceId,
        holdings_by_ticker: nonZero(replay), live_quantities: newQty, cash_amount: bal.cash, record_id: recordId,
      },
    };
  }

  if (!input.flagEnabled) blockers.push({ code: "flag_off", message: "계좌 동기화 기능이 서버에서 켜져 있지 않습니다(KIS_ACCOUNT_SYNC_ENABLED)." });
  return { eligible, flagEnabled: input.flagEnabled, enabled: eligible && input.flagEnabled, alreadySynced, needsStaleApproval, blockers, plan, write };
}

/** 승인 시각 · 승인자를 채워 최종 기록으로 만든다 (newData 의 마지막 brokerSyncs 항목도 같이 바꾼다) */
export function finalizeSyncWrite(w: SyncWrite, approvedAt: string, approvedBy: string): SyncWrite {
  const record: BrokerSyncRecord = { ...w.record, approvedAt, approvedBy };
  const list = (w.newData.brokerSyncs as BrokerSyncRecord[]).slice(0, -1);
  return { ...w, record, newData: { ...w.newData, brokerSyncs: [...list, record] } };
}

/** 변경된 키가 허용 목록 안에 있는지 — 허용 밖 키가 하나라도 바뀌면 그 이름을 돌려준다 */
export function disallowedChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const allowed = new Set<string>(BROKER_SYNC_MUTABLE_KEYS);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const bad: string[] = [];
  for (const k of keys) {
    if (allowed.has(k)) continue;
    if (canonicalJson(before[k]) !== canonicalJson(after[k])) bad.push(k);
  }
  return bad;
}
