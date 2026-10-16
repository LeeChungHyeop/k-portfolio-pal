// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 체결내역 **미리보기 응답 조립** — 순수 모듈 (Phase 4-B)
//
// 서버 핸들러(kis-execution-server.ts)가 KIS 에서 읽은 행(ParsedCcldRow)과 DB 에서 읽은
// 원장·장부를 이 함수에 넣으면 화면이 그대로 그릴 수 있는 응답이 나온다. 이 모듈은 IO 가
// 없고, **어디에도 쓰지 않는다.**
//
// ## 응답에 담기지 않는 것
//   · 계좌번호 · 앱키 · 토큰 · KIS 응답 원문
//   · 주문번호 전체(끝 4자리만) — 같은 주문의 식별은 서버 안에서만 쓴다
//
// ## 승인(원장 반영)은 이 단계에서 열리지 않는다
//   `approval.enabled` 는 항상 false 이고, 막는 사유(`blockers`)를 전부 나열한다.
//   `신규 체결` 이어도 `approvable` 은 이 응답에서 false 다(Phase 4-C 전).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { effectiveTransaction, type LedgerTransaction, type TransactionCorrection } from "./ledger";
import type { BrokerAccountInstance } from "./broker-account";
import type { CashFlowInput, CashTradeInput } from "./derived-cash";
import {
  assessFundingImpact,
  priorBrokerResidual,
  type FundingImpact,
} from "./account-transfer-model";
import {
  KIS_LEDGER_SOURCE,
  previewKisExecutions,
  totalsOfPreview,
  type PreviewReason,
  type PreviewStatus,
} from "./kis-execution-preview";
import type { CcldFailureKind, CcldListState, CcldRowKind, CcldSummary, ParsedCcldRow } from "./kis-ccld-history";

// ── 응답 타입 (서버 ↔ 화면 공용) ─────────────────────────────────────────────

export interface ExecRowView {
  /** 화면 key. 같은 주문일 안에서 유일하다 */
  key: string;
  /** YYYY-MM-DD */
  orderDate: string | null;
  /** 주문번호 끝 4자리 — 전체 번호는 응답에 없다 */
  orderNoTail: string;
  ticker: string | null;
  name: string | null;
  side: "buy" | "sell" | "unknown";
  orderQty: number | null;
  filledQty: number | null;
  avgPrice: number | null;
  filledAmount: number | null;
  remainingQty: number | null;
  cancelled: boolean | null;
  kind: CcldRowKind;
  hasExecution: boolean;
}

export interface ExecEntryView {
  row: ExecRowView;
  status: PreviewStatus;
  label: string;
  reason: PreviewReason;
  notes: string[];
  /** 비교한 원장 행의 요약(중복 가능성·일치). 원장 행 id 는 싣지 않는다 */
  ledgerRef: { date: string; ticker: string; side: "buy" | "sell"; quantity: number; source: string } | null;
  /** 이 단계에서는 어떤 행도 승인할 수 없다 */
  approvable: false;
  /** 다음 단계(4-C)에서 승인 후보가 될 수 있는 행인가 */
  futureCandidate: boolean;
}

export interface ExecutedTotals {
  /** 체결수량 > 0 인 행 수 */
  rows: number;
  buyQty: number;
  buyAmount: number;
  sellQty: number;
  sellAmount: number;
}

export interface ApprovalBlocker {
  code:
    | "phase_not_enabled"
    | "query_incomplete"
    | "nothing_new"
    | "attribution_conflict"
    | "possible_duplicate"
    | "unverifiable"
    | "funding_evidence_missing"
    | "prior_broker_residual"
    | "transfer_mode_unconfirmed";
  message: string;
}

export interface ExecQueryInfo {
  start: string;
  end: string;
  windows: number;
  pagesRead: number;
  /** 모든 구간·페이지를 끝까지 읽었는가 */
  complete: boolean;
  /** 다음 페이지가 있다고 했는데 읽지 않았다 */
  unreadPages: boolean;
  listState: CcldListState;
  duplicateOrderKeys: number;
}

export interface ExecImpactView {
  /** Σ외부 입출금 — 이 미리보기가 바꾸지 않는다 */
  principal: number | null;
  funding: FundingImpact | null;
  /** 이전 전 증권사 출처 원장 행을 재생해 남은 보유 */
  priorBrokerResidual: Record<string, number>;
  /** 한국투자 계좌가 활성으로 등록돼 있는가(이전이 일어났다고 사용자가 설정했는가) */
  newBrokerRegistered: boolean;
}

export type KisExecutionPreviewResponse =
  | {
      state: "ok";
      query: ExecQueryInfo;
      entries: ExecEntryView[];
      totals: {
        byStatus: Record<PreviewStatus, number>;
        executed: ExecutedTotals;
        zeroFillRows: number;
        /** `신규 체결`만의 매수 합계 */
        newBuyAmount: number;
        newBuyQty: number;
      };
      /** 조회 요약(output2)과 우리 합계의 대조. 비교할 수 없으면 null */
      apiCrossCheck: { matches: boolean; apiTotalFilledAmount: number; ourTotalFilledAmount: number } | null;
      impact: ExecImpactView;
      approval: { enabled: false; blockers: ApprovalBlocker[] };
    }
  | { state: "gate_blocked"; reason: string }
  | {
      state: "query_failed";
      failure: { kind: CcldFailureKind; httpStatus: number; rtCd: string | null; msgCd: string | null; msg1: string | null };
    }
  | { state: "ledger_unavailable" };

// ── 조립 입력 ───────────────────────────────────────────────────────────────

export interface ComposeInput {
  rows: readonly ParsedCcldRow[];
  summaries: ReadonlyArray<CcldSummary | null>;
  query: ExecQueryInfo;
  ledger: readonly LedgerTransaction[];
  corrections: ReadonlyMap<string, TransactionCorrection>;
  registry: readonly BrokerAccountInstance[];
  flows: readonly CashFlowInput[];
  accountType: AccountId;
  productCode: string;
  /** YYYY-MM-DD (KST) */
  today: string;
}

const ymdToIso = (v: string | null) => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
const tail4 = (v: string | null) => (v ? v.slice(-4) : "----");

/** 정정(overlay)을 적용한 유효 원장. 제외된 거래는 뺀다. 원본은 변형하지 않는다. */
export function effectiveLedger(
  ledger: readonly LedgerTransaction[],
  corrections: ReadonlyMap<string, TransactionCorrection>,
): LedgerTransaction[] {
  const out: LedgerTransaction[] = [];
  for (const t of ledger) {
    const e = effectiveTransaction(t, corrections.get(t.id));
    if (e.excluded) continue;
    out.push({ ...t, ticker: e.ticker, side: e.side, quantity: e.quantity, price: e.price, amount: e.amount, eventDate: e.eventDate });
  }
  return out;
}

function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const KIS_ACTIVE = (registry: readonly BrokerAccountInstance[], accountType: AccountId, productCode: string, today: string) =>
  registry.some(
    (i) => i.logicalAccountType === accountType && i.broker === "kis" && i.productCode === productCode &&
      i.activeFrom <= today && (i.activeTo === undefined || today < i.activeTo),
  );

export function composeExecutionPreview(input: ComposeInput): Extract<KisExecutionPreviewResponse, { state: "ok" }> {
  const eff = effectiveLedger(input.ledger, input.corrections);
  const preview = previewKisExecutions({
    rows: input.rows, ledger: eff, registry: input.registry, accountType: input.accountType, productCode: input.productCode,
  });
  const t = totalsOfPreview(preview);

  const seq = new Map<string, number>();
  const entries: ExecEntryView[] = preview.map((e) => {
    const r = e.parsed.row;
    const n = (seq.get(r.orderDate ?? "?") ?? 0) + 1;
    seq.set(r.orderDate ?? "?", n);
    const ref = e.ledgerRef ? eff.find((x) => x.id === e.ledgerRef) : undefined;
    return {
      row: {
        key: `${r.orderDate ?? "?"}#${n}`,
        orderDate: ymdToIso(r.orderDate),
        orderNoTail: tail4(r.orderNo),
        ticker: r.ticker, name: r.name,
        side: r.sideCode === "02" ? "buy" : r.sideCode === "01" ? "sell" : "unknown",
        orderQty: r.orderQty, filledQty: r.filledQty, avgPrice: r.avgPrice, filledAmount: r.filledAmount,
        remainingQty: r.remainingQty, cancelled: r.cancelled, kind: e.parsed.kind, hasExecution: e.parsed.hasExecution,
      },
      status: e.status, label: e.label, reason: e.reason, notes: e.notes,
      ledgerRef: ref
        ? { date: String(ref.eventDate).slice(0, 10), ticker: ref.ticker, side: ref.side, quantity: ref.quantity, source: ref.source }
        : null,
      approvable: false,
      futureCandidate: e.status === "new",
    };
  });

  // 체결수량 > 0 인 행만 합산한다 — 0주 주문은 매수 실적이 아니다.
  const executed: ExecutedTotals = { rows: 0, buyQty: 0, buyAmount: 0, sellQty: 0, sellAmount: 0 };
  for (const p of input.rows) {
    if (!p.hasExecution) continue;
    const r = p.row;
    executed.rows++;
    if (r.sideCode === "02") { executed.buyQty += r.filledQty as number; executed.buyAmount += r.filledAmount as number; }
    if (r.sideCode === "01") { executed.sellQty += r.filledQty as number; executed.sellAmount += r.filledAmount as number; }
  }
  const zeroFillRows = input.rows.filter((p) => !p.hasExecution).length;

  // 조회 요약(output2)과 대조 — 모든 페이지의 요약이 있고 끝까지 읽었을 때만
  let apiCrossCheck: Extract<KisExecutionPreviewResponse, { state: "ok" }>["apiCrossCheck"] = null;
  const sums = input.summaries;
  if (input.query.complete && sums.length > 0 && sums.every((s) => s && s.totalFilledAmount !== null)) {
    const api = sums.reduce((s, x) => s + (x!.totalFilledAmount as number), 0);
    const ours = executed.buyAmount + executed.sellAmount;
    apiCrossCheck = { matches: api === ours, apiTotalFilledAmount: api, ourTotalFilledAmount: ours };
  }

  // ── 영향(읽기 전용) ────────────────────────────────────────────────────────
  const mine = eff.filter((x) => x.accountId === input.accountType);
  const ledgerTrades: CashTradeInput[] = mine.map((x) => ({
    date: String(x.eventDate).slice(0, 10), side: x.side, amount: x.amount, fee: x.fee, tax: x.tax,
  }));
  const candidates = preview.filter((e) => e.status === "new" && e.candidate).map((e) => e.candidate!);
  const candidateTrades: CashTradeInput[] = candidates.map((c) => ({ date: c.tradeDate, side: c.side, amount: c.amount, fee: null, tax: null }));
  const principal = input.flows.reduce((s, f) => s + f.amount, 0);

  const allDates = [...input.flows.map((f) => f.date), ...ledgerTrades.map((x) => x.date), ...candidateTrades.map((x) => x.date)].sort();
  let funding: FundingImpact | null = null;
  if (candidateTrades.length > 0 && allDates.length > 0) {
    const replay: Record<string, number> = {};
    for (const x of mine) replay[x.ticker] = (replay[x.ticker] ?? 0) + (x.side === "buy" ? x.quantity : -x.quantity);
    for (const k of Object.keys(replay)) if (replay[k] === 0) delete replay[k];
    const delta: Record<string, number> = {};
    for (const c of candidates) delta[c.ticker] = (delta[c.ticker] ?? 0) + (c.side === "buy" ? c.quantity : -c.quantity);
    funding = assessFundingImpact({
      flows: input.flows, ledgerTrades, candidates: candidateTrades,
      tradingDates: weekdaysBetween(allDates[0], input.today > allDates.at(-1)! ? input.today : allDates.at(-1)!),
      replayHoldingsBefore: replay, candidateHoldingsDelta: delta, observedHoldings: null,
    });
  }

  const newBrokerRegistered = KIS_ACTIVE(input.registry, input.accountType, input.productCode, input.today);
  const residual = priorBrokerResidual(
    mine.map((x) => ({ ticker: x.ticker, side: x.side, quantity: x.quantity, source: x.source })),
    KIS_LEDGER_SOURCE,
  );
  const hasResidual = newBrokerRegistered && Object.keys(residual).length > 0;

  // ── 승인 차단 사유 (이 단계에서는 항상 닫혀 있다) ───────────────────────────
  const blockers: ApprovalBlocker[] = [
    { code: "phase_not_enabled", message: "원장 반영 기능은 아직 열리지 않았습니다(Phase 4-C). 이 화면은 조회·미리보기 전용입니다." },
  ];
  if (!input.query.complete) {
    blockers.push({
      code: "query_incomplete",
      message: input.query.unreadPages
        ? "다음 페이지가 있으나 읽지 않아 목록이 일부입니다."
        : "조회가 끝까지 완료되지 않았습니다.",
    });
  }
  if (t.byStatus.new === 0) blockers.push({ code: "nothing_new", message: "반영할 신규 체결이 없습니다." });
  if (t.byStatus.attribution_conflict > 0) blockers.push({ code: "attribution_conflict", message: `계좌 귀속이 충돌하는 체결 ${t.byStatus.attribution_conflict}건이 있습니다.` });
  if (t.byStatus.possible_duplicate > 0) blockers.push({ code: "possible_duplicate", message: `기존 원장과 중복 가능성이 있는 체결 ${t.byStatus.possible_duplicate}건이 있습니다.` });
  if (t.byStatus.unverifiable > 0) blockers.push({ code: "unverifiable", message: `확인할 수 없는 체결 ${t.byStatus.unverifiable}건이 있습니다.` });
  if (funding && funding.verdict === "funding_evidence_missing") {
    blockers.push({
      code: "funding_evidence_missing",
      message: "자금 출처 근거가 원장에 없습니다. 이 체결만 반영하면 유도 예수금이 부족해져 가짜 '미관측 수입'이 생깁니다.",
    });
  }
  if (hasResidual) {
    blockers.push({
      code: "prior_broker_residual",
      message: "이전 증권사 출처의 원장 보유가 이탈 처리되지 않고 남아 있습니다. 이 체결만 반영하면 같은 보유가 이중 계산됩니다.",
    });
  }
  // 이전 방식은 사용자가 확인하기 전까지 가정하지 않는다. 이 단계에는 확인 수단이 없다.
  if (newBrokerRegistered) {
    blockers.push({
      code: "transfer_mode_unconfirmed",
      message: "이전 방식(매도 후 현금 이전 / 실물 이전)이 확인되지 않았습니다. 확인 전에는 어떤 방식도 가정하지 않습니다.",
    });
  }

  return {
    state: "ok",
    query: input.query,
    entries,
    totals: {
      byStatus: t.byStatus, executed, zeroFillRows,
      newBuyAmount: t.newBuyAmount, newBuyQty: t.newBuyQty,
    },
    apiCrossCheck,
    impact: { principal: input.flows.length ? principal : null, funding, priorBrokerResidual: residual, newBrokerRegistered },
    approval: { enabled: false, blockers },
  };
}
