// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 실제 체결 → 거래원장 반영 계획 (Phase 4-C-2) — 순수 모듈
//
// 체결내역 미리보기에서 `신규 체결`로 분류된 행을 append-only 원장에 넣기 **전에**, 반영해도 안전한지
// 모든 조건으로 판정하고 사용자가 승인할 대상(계획 해시)과 DB 에 쓸 페이로드를 만든다.
// 아무것도 쓰지 않는다 — 쓰기는 서버 핸들러가 RPC(migration 012) 한 번으로 한다.
//
// ## 판정은 fail closed 다
//   하나라도 어긋나면 eligible=false 이고 이유를 전부 나열한다. 부분 반영 · 일부 허용은 없다.
//
// ## 하지 않는 것
//   · 이전금액을 신규 납입으로 만들지 않는다 — cashflow 를 만들지 않는다(원금 불변을 계획에 증명으로 싣는다)
//   · 수수료 · 세금 · 거래후잔고를 추정해 채우지 않는다 — 전부 null
//   · 원장 유도 예수금과 관측 예수금의 차이(74,194원)·이전금액과 매수금액의 차이(335원)를 보정하지 않는다
//   · 매도 체결은 반영하지 않는다(이번 단계는 매수만) — 같은 날 일중 순서 근거가 없다
//   · 체결 0주 주문 · 읽지 못한 행 · 확인 불가 행은 후보가 될 수 없다
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";
import { replayFinalHoldings } from "./ledger";
import type { CashFlowInput } from "./derived-cash";
import type { FundingImpact } from "./account-transfer-model";
import { priorBrokerResidual } from "./account-transfer-model";
import type { TransferRecord } from "./account-transfer-record";
import type { BalanceObservationSummary } from "./kis-balance-observation";
import {
  KIS_FINGERPRINT_VERSION,
  KIS_LEDGER_SOURCE,
  type LedgerCandidate,
  type PreviewEntry,
} from "./kis-execution-preview";
import { reconcileTransfer, type ReconcileResult } from "./transfer-reconciliation";
import { canonicalJson, stableDigest } from "./rebalance-plan";

export const KIS_APPLY_AUDIT_ACTION = "kis_execution_apply";
export const KIS_APPLY_SOURCE_KIND = "kis_api";
/** 한 번에 반영할 수 있는 최대 행 수 (RPC 도 같은 상한을 쓴다) */
export const KIS_APPLY_MAX_ROWS = 20;

export type ApplyBlockerCode =
  | "flag_off"
  | "query_incomplete"
  | "unverifiable_rows"
  | "attribution_conflict"
  | "possible_duplicate"
  | "api_cross_check_mismatch"
  | "nothing_new"
  | "already_applied"
  | "partially_applied"
  | "sell_not_supported"
  | "transfer_unconfirmed"
  | "prior_residual"
  | "funding_evidence_missing"
  | "observation_missing"
  | "observation_stale"
  | "observation_incomplete"
  | "holdings_mismatch"
  | "corrections_present"
  | "too_many_rows";

export interface ApplyBlocker {
  code: ApplyBlockerCode;
  message: string;
}

/** 화면에 보이는 행. 주문번호는 끝 4자리만 — 전체 번호는 응답에 없다 */
export interface ApplyRowView {
  ticker: string;
  etfName: string;
  side: "buy";
  tradeDate: string;
  quantity: number;
  price: number;
  amount: number;
  orderNoTail: string;
  /** 기존 원장과의 관계. 반영 대상은 항상 'none'(= 같은 주문이 원장에 없다) */
  duplicate: "none";
}

export interface ApplyPlanView {
  /** 사용자가 승인하는 대상의 지문. 승인 직전 서버가 다시 계산해 같아야 한다 */
  planHash: string;
  batchId: string;
  rows: ApplyRowView[];
  totalQuantity: number;
  totalAmount: number;
  holdings: {
    /** 반영 전 원장 재생 보유(0주 생략) */
    before: Record<string, number>;
    /** 반영 후 예상 원장 재생 보유 */
    after: Record<string, number>;
    /** 한국투자 잔고 관측 보유 */
    observed: Record<string, number> | null;
    matches: boolean;
  };
  /** 누적 납입원금 — 반영이 cashflow 를 만들지 않으므로 같다 */
  principal: { before: number; after: number; unchanged: boolean };
  /** 차이의 크기만. 원인은 분류하지 않는다(transfer-reconciliation.ts) */
  reconciliation: ReconcileResult | null;
  observation: { captureId: string; stateAsOf: string; observedAt: string } | null;
  transfer: { anchorDate: string; amount: number; approvedAt: string; containsEstimates: boolean } | null;
}

/** RPC 로 보내는 페이로드. 가족 코드/프로필은 담지 않는다 — RPC 가 세션 값으로 채운다 */
export interface ApplyWrite {
  batch: {
    id: string; source_kind: string; source_label: string; source_checksum: string;
    inserted_count: number; skipped_count: number; verification: unknown;
  };
  rows: Array<Record<string, unknown>>;
  expect: { instance_id: string; holdings_after: Record<string, number>; plan_hash: string };
  /** audit 에 남길 승인 스냅샷 (actor/note 는 호출 시 채운다) */
  auditNewValue: Record<string, unknown>;
  auditPreviousValue: Record<string, unknown>;
}

export interface ApplyEvaluation {
  /** 안전 조건을 모두 만족한다(플래그와 무관) */
  eligible: boolean;
  flagEnabled: boolean;
  /** 지금 반영 버튼을 열 수 있다 = eligible && flagEnabled */
  enabled: boolean;
  /** 신규는 없고 이미 같은 주문이 원장에 있다 */
  alreadyApplied: boolean;
  blockers: ApplyBlocker[];
  plan: ApplyPlanView | null;
  /** 서버 전용 — 응답에 싣지 않는다 */
  write: ApplyWrite | null;
}

export interface ApplyEvalInput {
  flagEnabled: boolean;
  entries: readonly PreviewEntry[];
  query: { start: string; end: string; complete: boolean; unreadPages: boolean; listState: string; duplicateOrderKeys: number };
  apiCrossCheck: { matches: boolean } | null;
  registry: readonly BrokerAccountInstance[];
  /** 정정이 적용된 유효 원장 (모든 계좌) */
  ledger: readonly LedgerTransaction[];
  /** 이 계좌의 정정(overlay) 행이 하나라도 있는가 — 있으면 반영하지 않는다(SQL 재생이 overlay 를 모른다) */
  correctionsPresent: boolean;
  transfers: readonly TransferRecord[];
  observation: BalanceObservationSummary | null;
  flows: readonly CashFlowInput[];
  funding: FundingImpact | null;
  accountType: "pension";
  productCode: string;
  /** 반영 계획에 쓰는 배치 라벨용 */
  today: string;
}

const tail4 = (v: string) => v.slice(-4);
function mapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== 0).sort();
  const kb = Object.keys(b).filter((k) => b[k] !== 0).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** 후보 한 건의 원장 행 id. fingerprint 에서 결정적으로 나온다 */
export function kisLedgerRowId(fingerprint: string): string {
  return `kisx:${stableDigest(fingerprint).slice(0, 24)}`;
}

export function evaluateApplyPlan(input: ApplyEvalInput): ApplyEvaluation {
  const blockers: ApplyBlocker[] = [];
  const add = (code: ApplyBlockerCode, message: string) => blockers.push({ code, message });

  const entries = input.entries;
  const newEntries = entries.filter((e) => e.status === "new" && e.candidate);
  const matched = entries.filter((e) => e.status === "matches");

  // 1) 조회가 전체 기간 · 모든 페이지에 걸쳐 완료됐는가
  if (!input.query.complete || input.query.unreadPages) add("query_incomplete", "체결 조회가 전체 기간·모든 페이지에 걸쳐 완료되지 않았습니다.");
  if (input.query.listState === "list_absent") add("query_incomplete", "응답에 체결 목록이 없어 결과를 알 수 없습니다.");

  // 2) 읽지 못한 행 · 번호 중복 · 금액 불일치 등 확인 불가가 하나라도 있으면 막는다 (체결 여부를 모르는 행이 있다)
  const unverifiable = entries.filter((e) => e.status === "unverifiable").length;
  if (unverifiable > 0 || input.query.duplicateOrderKeys > 0) add("unverifiable_rows", `확인할 수 없는 체결 ${unverifiable}건이 있어 체결 전체를 신뢰할 수 없습니다.`);
  const conflicts = entries.filter((e) => e.status === "attribution_conflict").length;
  if (conflicts > 0) add("attribution_conflict", `계좌 귀속이 충돌하는 체결 ${conflicts}건이 있습니다.`);
  const dups = entries.filter((e) => e.status === "possible_duplicate").length;
  if (dups > 0) add("possible_duplicate", `기존 원장과 중복 가능성이 있는 체결 ${dups}건이 있습니다.`);
  if (input.apiCrossCheck && !input.apiCrossCheck.matches) add("api_cross_check_mismatch", "증권사 요약 체결금액과 행 합계가 일치하지 않습니다.");

  // 3) 후보 — 신규 체결만. 매도는 이번 단계에서 반영하지 않는다.
  if (newEntries.some((e) => e.candidate!.side !== "buy")) add("sell_not_supported", "매도 체결은 아직 원장에 반영하지 않습니다(같은 날 일중 순서 근거가 필요합니다).");
  if (newEntries.length > KIS_APPLY_MAX_ROWS) add("too_many_rows", `한 번에 반영할 수 있는 최대 ${KIS_APPLY_MAX_ROWS}건을 넘었습니다.`);

  const alreadyApplied = newEntries.length === 0 && matched.length > 0;
  if (newEntries.length === 0) {
    add(alreadyApplied ? "already_applied" : "nothing_new", alreadyApplied ? "이미 같은 주문이 원장에 반영돼 있습니다." : "반영할 신규 체결이 없습니다.");
  } else if (matched.length > 0) {
    // 일부만 이미 들어가 있다 — 원자 반영이라면 생기지 않는 상태. 사람이 확인해야 한다.
    add("partially_applied", "일부 체결만 이미 원장에 있습니다. 부분 반영 상태이므로 자동으로 이어서 반영하지 않습니다.");
  }

  // 4) 사용자가 확정한 계좌 이전(4-C-1)이 있어야 한다
  const instanceIds = [...new Set(newEntries.map((e) => e.candidate!.accountInstanceId))];
  const instanceId = instanceIds.length === 1 ? instanceIds[0] : null;
  if (newEntries.length > 0 && instanceIds.length > 1) add("attribution_conflict", "후보가 둘 이상의 계좌 instance 에 걸쳐 있습니다.");
  const transfer = instanceId ? input.transfers.find((t) => t.toInstanceId === instanceId) ?? null : null;
  if (newEntries.length > 0 && !transfer) add("transfer_unconfirmed", "사용자가 확정한 계좌 이전 기록이 없습니다(Phase 4-C-1).");

  // 5) 이전 증권사 보유가 원장에서 이탈 처리돼 있어야 한다
  const mine = input.ledger.filter((t) => t.accountId === input.accountType);
  const residual = priorBrokerResidual(
    mine.map((t) => ({ ticker: t.ticker, side: t.side, quantity: t.quantity, source: t.source })),
    KIS_LEDGER_SOURCE,
  );
  if (Object.keys(residual).length > 0) add("prior_residual", `이전 증권사 출처의 원장 보유가 남아 있습니다: ${Object.entries(residual).map(([k, v]) => `${k} ${v}주`).join(", ")}`);

  // 6) 자금 출처 — 반영해도 가짜 미관측 수입이 생기지 않아야 한다
  if (newEntries.length > 0 && (!input.funding || input.funding.verdict !== "ok")) {
    add("funding_evidence_missing", "자금 출처 근거가 부족해 반영하면 가짜 ‘미관측 수입’이 생깁니다.");
  }

  // 7) 정정(overlay)이 있으면 SQL 쪽 보유 재생이 이를 모르므로 반영하지 않는다
  if (input.correctionsPresent) add("corrections_present", "이 계좌에 거래 정정(overlay)이 있어 자동 반영하지 않습니다.");

  // 8) 반영 후 원장 재생 보유 == 한국투자 관측 보유
  const before = (replayFinalHoldings(mine).pension ?? {}) as Record<string, number>;
  const after: Record<string, number> = { ...before };
  for (const e of newEntries) {
    const c = e.candidate!;
    after[c.ticker] = (after[c.ticker] ?? 0) + (c.side === "buy" ? c.quantity : -c.quantity);
  }
  for (const k of Object.keys(after)) if (after[k] === 0) delete after[k];

  const obs = input.observation;
  const lastTradeDate = newEntries.map((e) => e.candidate!.tradeDate).sort().at(-1) ?? null;
  let observedHoldings: Record<string, number> | null = null;
  if (newEntries.length > 0) {
    if (!obs || obs.holdings === null) {
      add("observation_missing", "한국투자 잔고 관측(보유)이 기록돼 있지 않아 반영 후 보유를 대조할 수 없습니다.");
    } else {
      observedHoldings = obs.holdings;
      // 일부 행을 읽지 못한 관측(partial)은 보유 전체의 증거가 아니다. 'unknown' 은 증권사가 0주 종목을 생략하는지
      // 모른다는 뜻인데, 아래 비교가 **양방향 완전 일치**(원장에 있는데 관측에 없어도, 관측에 있는데 원장에 없어도 불일치)라
      // 생략 여부와 무관하게 안전하다 — 그래서 unknown 은 허용하고 partial 만 막는다.
      if (obs.holdingsCompleteness === "partial") add("observation_incomplete", "한국투자 잔고 관측의 보유 목록이 일부만 읽힌 자료(partial)라 증거로 쓸 수 없습니다. 잔고를 다시 관측하세요.");
      if (lastTradeDate && obs.stateAsOf < lastTradeDate) add("observation_stale", "관측 기준일이 마지막 체결일보다 앞서 있습니다. 잔고를 다시 관측하세요.");
      if (!mapsEqual(after, obs.holdings)) {
        add("holdings_mismatch", `반영 후 원장 재생 보유(${fmt(after)})가 한국투자 관측 보유(${fmt(obs.holdings)})와 다릅니다.`);
      }
    }
  }

  // 계획 — 반영 대상이 있을 때만 만든다
  let plan: ApplyPlanView | null = null;
  let write: ApplyWrite | null = null;
  if (newEntries.length > 0 && instanceId) {
    const cands = newEntries.map((e) => e.candidate!).sort((a, b) => a.sourceFingerprint.localeCompare(b.sourceFingerprint));
    const rowsView: ApplyRowView[] = cands.map((c) => ({
      ticker: c.ticker, etfName: c.etfName, side: "buy", tradeDate: c.tradeDate, quantity: c.quantity, price: c.price, amount: c.amount,
      orderNoTail: tail4(c.orderNo), duplicate: "none",
    }));
    const principal = input.flows.reduce((s, f) => s + f.amount, 0);
    const planCore = {
      instanceId,
      rows: cands.map((c) => [c.sourceFingerprint, c.ticker, c.side, c.quantity, c.price, c.amount, c.tradeDate]),
      holdingsBefore: before,
      holdingsAfter: after,
      observation: obs ? [obs.captureId, obs.stateAsOf] : null,
      transfer: transfer ? [transfer.toInstanceId, transfer.approval.at] : null,
      principal,
    };
    const planHash = `k1|${stableDigest(canonicalJson(planCore))}`;
    const batchId = `imp:${KIS_LEDGER_SOURCE}:${stableDigest(cands.map((c) => c.sourceFingerprint).join("\n")).slice(0, 24)}`;
    const totalQuantity = cands.reduce((s, c) => s + c.quantity, 0);
    const totalAmount = cands.reduce((s, c) => s + c.amount, 0);

    // 자금 대사 — 차이의 크기만 (원인 미확정). 이전 금액과 관측 예수금이 있을 때만
    const derivedCash = input.funding?.before.finalDerived;
    const reconciliation: ReconcileResult | null =
      transfer && obs && obs.cash !== null && derivedCash !== undefined
        ? reconcileTransfer({
            transferAmount: transfer.cashReceived.amount, kisBuyAmount: totalAmount, kisBuyAmountAlreadyInLedger: 0,
            ledgerDerivedCash: derivedCash, observedCash: obs.cash, principalBefore: principal, principalAfter: principal,
          })
        : null;

    plan = {
      planHash, batchId, rows: rowsView, totalQuantity, totalAmount,
      holdings: { before, after, observed: observedHoldings, matches: observedHoldings !== null && mapsEqual(after, observedHoldings) },
      principal: { before: principal, after: principal, unchanged: true },
      reconciliation,
      observation: obs ? { captureId: obs.captureId, stateAsOf: obs.stateAsOf, observedAt: obs.observedAt } : null,
      transfer: transfer ? { anchorDate: transfer.anchorDate, amount: transfer.cashReceived.amount, approvedAt: transfer.approval.at, containsEstimates: transfer.containsEstimates } : null,
    };

    write = {
      batch: {
        id: batchId,
        source_kind: KIS_APPLY_SOURCE_KIND,
        source_label: `한국투자 inquire-daily-ccld(TTTC0081R) ${input.query.start}~${input.query.end} · 연금저축 ${input.productCode}`,
        source_checksum: planHash,
        inserted_count: cands.length,
        skipped_count: 0,
        verification: {
          planHash, rows: rowsView, totalQuantity, totalAmount,
          holdingsBefore: before, holdingsAfter: after, observedHoldings,
          principal: { before: principal, after: principal },
          reconciliation: reconciliation?.lines.map((l) => ({ id: l.id, baseline: l.baseline, observed: l.observed, difference: l.difference, status: l.status })) ?? null,
          causeClassified: false,
        },
      },
      rows: cands.map((c) => ledgerInsertRow(c, batchId)),
      expect: { instance_id: instanceId, holdings_after: after, plan_hash: planHash },
      auditPreviousValue: { holdings: before },
      auditNewValue: {
        kind: "kis_execution_apply", version: 1, planHash, batchId,
        rows: rowsView, totalQuantity, totalAmount,
        holdingsAfter: after, observedHoldings,
        principal: { before: principal, after: principal, unchanged: true },
        transfer: plan.transfer, observation: plan.observation,
        unconfirmedDifferences: reconciliation?.lines.map((l) => ({ id: l.id, difference: l.difference, status: l.status })) ?? null,
        createsCashflow: false, feeTaxEstimated: false,
      },
    };
  }

  const eligible = blockers.length === 0;
  if (!input.flagEnabled) blockers.push({ code: "flag_off", message: "원장 반영 기능이 서버에서 켜져 있지 않습니다(KIS_LEDGER_APPLY_ENABLED)." });
  return { eligible, flagEnabled: input.flagEnabled, enabled: eligible && input.flagEnabled, alreadyApplied, blockers, plan, write };
}

const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}주`).join(", ") || "없음";

/** 후보 → kaw_transaction_ledger 행(가족/프로필 제외). 수수료·세금·거래후잔고는 null — 추정하지 않는다 */
export function ledgerInsertRow(c: LedgerCandidate, batchId: string): Record<string, unknown> {
  return {
    id: kisLedgerRowId(c.sourceFingerprint),
    account_type: c.accountId,
    ticker: c.ticker,
    etf_name: c.etfName,
    side: c.side,
    quantity: c.quantity,
    price: c.price,
    amount: c.amount,
    trade_date: c.tradeDate,
    settlement_date: null,
    inferred_trade_date: null,
    event_date: c.eventDate,
    trade_date_evidence: c.tradeDateEvidence,
    fee: null,
    tax: null,
    post_quantity: null,
    source: KIS_LEDGER_SOURCE,
    source_file: null,
    source_row: null,
    source_fingerprint: c.sourceFingerprint,
    fingerprint_version: KIS_FINGERPRINT_VERSION,
    import_batch_id: batchId,
  };
}
