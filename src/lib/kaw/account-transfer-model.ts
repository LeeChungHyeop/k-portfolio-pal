// ─────────────────────────────────────────────────────────────────────────────
// 증권사 간 계좌 이전 자금 + 신규 체결의 **자금 영향 모델** — 순수 모듈 (Phase 4-A PoC)
//
// 풀려는 문제: 미래에셋 연금저축 → 한국투자 연금저축으로 옮긴 돈으로 한국투자에서 ETF 를
// 샀다. 이 매수를 원장에 반영할 때
//
//   (1) 이전 자금이 **신규 납입원금으로 이중 계산**되면 안 되고
//   (2) 자금 출처가 원장에 없어서 유도 예수금이 음수가 되면, 보수 모델(derived-cash.ts)이 그
//       결손을 "대기자금 이자 / 분배금 같은 **미관측 수입**"으로 흡수해 수익이 부풀려진다
//
// ## 핵심 사실 (derived-cash.ts)
//
//   derivedCash = Σ외부 입출금 − Σ매수 + Σ매도 − 보고된 비용
//
// 논리계좌(`pension`)는 증권사와 무관한 **하나의 현금 주머니**다. 그래서 증권사 간 이전은
// **내부 이동**이고 어떤 항에도 들어가지 않는다 — 원금(Σ외부 입출금)을 바꾸지 않는다.
// 이전 자금의 정체는 이미 원장에 있는 **미래에셋 매도 대금(또는 예수금)** 이다. 따라서
// 올바른 반영의 필요조건은
//
//   "이전 자금을 만든 미래에셋 쪽 이탈(전량 매도 체결 또는 실물 이전 증거)이 원장에 있다"
//
// 이다. 그것이 없으면 (a) 현금이 모자라 incomeLB 가 가짜로 생기고 (b) 미래에셋 보유분이
// 원장 재생에 그대로 남아 한국투자 보유와 **이중 계산**된다.
//
// ## 이 모듈이 하지 않는 것
//
//   · cashflow 를 만들거나 제안하지 않는다(`createsCashflow` 는 항상 false)
//   · 원금에 아무것도 더하지 않는다(`principalEffect` 는 항상 "none"; 외부 입금은 사용자가 따로 확인)
//   · 이전일·금액을 추정하지 않는다 — 비어 있으면 `missingEvidence` 로 요구한다
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildDerivedCash,
  type CashFlowInput,
  type CashTradeInput,
} from "./derived-cash";

export interface FundingModelInput {
  /** 외부 입출금(원금). 입금 +, 출금 − */
  flows: readonly CashFlowInput[];
  /** 이미 원장에 있는 거래(모든 증권사) */
  ledgerTrades: readonly CashTradeInput[];
  /** 이번에 반영하려는 후보(예: 한국투자 매수). 아직 원장에 없다 */
  candidates: readonly CashTradeInput[];
  /** 가격이 존재하는 거래일(오름차순). 후보 날짜가 빠져 있으면 모델이 보강한다 */
  tradingDates: readonly string[];
  /** 원장 재생 보유(후보 반영 전). ticker → 수량 */
  replayHoldingsBefore?: Readonly<Record<string, number>>;
  /** 후보가 바꾸는 보유. ticker → 증감 */
  candidateHoldingsDelta?: Readonly<Record<string, number>>;
  /** 증권사가 보고한 **현재** 보유(예: 한국투자 잔고 관측). 없으면 보유 대조를 하지 않는다 */
  observedHoldings?: Readonly<Record<string, number>> | null;
  /** 이 이하의 가짜 수입은 반올림 오차로 본다(원). 기본 1,000 */
  toleranceKrw?: number;
}

export type FundingVerdict =
  /** 후보를 반영해도 미관측 수입이 늘지 않고 보유도 맞다 */
  | "ok"
  /** 후보를 반영하면 가짜 미관측 수입이 생긴다 → 자금 출처(이탈 근거)가 원장에 없다 */
  | "funding_evidence_missing"
  /** 원장 재생 보유와 증권사 보고 보유가 다르다 */
  | "holdings_mismatch";

export interface HoldingsMismatch {
  ticker: string;
  replayAfter: number;
  observed: number;
}

export interface FundingImpact {
  /** Σ외부 입출금 — 후보를 반영해도 **절대 바뀌지 않는다** */
  principalBefore: number;
  principalAfter: number;
  before: { finalDerived: number; totalIncomeLB: number };
  after: { finalDerived: number; totalIncomeLB: number };
  /** 후보 때문에 늘어난 "미관측 수입 하한" = 가짜 수입 위험 */
  phantomIncomeLB: number;
  /** 후보 반영 후 유도 예수금이 처음 음수가 되는 날 */
  firstShortfallDate: string | null;
  holdings: {
    replayAfter: Record<string, number>;
    mismatches: HoldingsMismatch[];
    /** 보고 보유가 후보 증감과 거의 같고 원장 재생이 그보다 훨씬 많다 = 이전 쪽 보유가 이탈 처리되지 않았다 */
    exitLegSuspected: boolean;
  } | null;
  verdict: FundingVerdict;
  /** 이 후보를 안전하게 반영하려면 더 필요한 증거 */
  missingEvidence: string[];
  /** 이 모듈은 cashflow 를 만들지 않는다 */
  createsCashflow: false;
  principalEffect: "none";
}

function addHoldings(
  base: Readonly<Record<string, number>>,
  delta: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [t, d] of Object.entries(delta)) out[t] = (out[t] ?? 0) + d;
  for (const t of Object.keys(out)) if (out[t] === 0) delete out[t];
  return out;
}

export function sumFlows(flows: readonly CashFlowInput[]): number {
  return flows.reduce((s, f) => s + f.amount, 0);
}

export function assessFundingImpact(input: FundingModelInput): FundingImpact {
  const tol = input.toleranceKrw ?? 1000;
  const dates = [...new Set([...input.tradingDates, ...input.candidates.map((c) => c.date)])].sort();
  const before = buildDerivedCash({ flows: input.flows, trades: input.ledgerTrades, tradingDates: dates });
  const after = buildDerivedCash({
    flows: input.flows,
    trades: [...input.ledgerTrades, ...input.candidates],
    tradingDates: dates,
  });
  const phantom = Math.max(0, after.totalIncomeLB - before.totalIncomeLB);

  // 후보가 만든 첫 결손일: 후보 없이는 없던 음수 구간
  let firstShortfallDate: string | null = null;
  for (const d of after.dates) {
    const a = after.byDate.get(d)?.derived ?? 0;
    const b = before.byDate.get(d)?.derived;
    if (a < 0 && (b === undefined || a < b - tol)) { firstShortfallDate = d; break; }
  }

  let holdings: FundingImpact["holdings"] = null;
  if (input.replayHoldingsBefore) {
    const replayAfter = addHoldings(input.replayHoldingsBefore, input.candidateHoldingsDelta ?? {});
    const mismatches: HoldingsMismatch[] = [];
    let exitLegSuspected = false;
    if (input.observedHoldings) {
      const tickers = new Set([...Object.keys(replayAfter), ...Object.keys(input.observedHoldings)]);
      for (const t of tickers) {
        const r = replayAfter[t] ?? 0;
        const o = input.observedHoldings[t] ?? 0;
        if (r !== o) mismatches.push({ ticker: t, replayAfter: r, observed: o });
      }
      // 보고 보유 == 후보 증감(= 새로 산 것뿐)인데 원장 재생에는 그 위에 이전 보유가 얹혀 있다
      const delta = input.candidateHoldingsDelta ?? {};
      const onlyNew = Object.keys(input.observedHoldings).every((t) => (input.observedHoldings![t] ?? 0) === (delta[t] ?? 0));
      const replayHasOld = Object.entries(input.replayHoldingsBefore).some(([, q]) => q > 0);
      exitLegSuspected = mismatches.length > 0 && onlyNew && replayHasOld;
    }
    holdings = { replayAfter, mismatches, exitLegSuspected };
  }

  const missingEvidence: string[] = [];
  if (phantom > tol || (holdings && holdings.exitLegSuspected)) {
    missingEvidence.push(
      "이전 전 증권사(미래에셋)의 이탈 근거: 보유분이 빠져나간 전량 매도 체결(수량·단가·일자) 또는 실물 이전 증거",
      "새 증권사(한국투자) 입고 일자와 금액(자금이 들어온 날)",
      "새 증권사 잔고 관측(보유수량·예수금)으로 위 둘의 합이 맞는지 대조",
    );
  }

  const verdict: FundingVerdict =
    phantom > tol ? "funding_evidence_missing" : holdings && holdings.mismatches.length > 0 ? "holdings_mismatch" : "ok";

  return {
    principalBefore: sumFlows(input.flows),
    principalAfter: sumFlows(input.flows),
    before: { finalDerived: before.finalDerived, totalIncomeLB: before.totalIncomeLB },
    after: { finalDerived: after.finalDerived, totalIncomeLB: after.totalIncomeLB },
    phantomIncomeLB: phantom,
    firstShortfallDate,
    holdings,
    verdict,
    missingEvidence,
    createsCashflow: false,
    principalEffect: "none",
  };
}

// ── 자금 출처 분류 — 사용자가 확인한 것만 효과를 가진다 ─────────────────────

/**
 * 한국투자로 들어온 돈의 성격. **기본값이 없다** — 사용자가 고르기 전에는 어떤 효과도 계산하지
 * 않는다("확인되지 않은 흐름은 장부에 넣지 않는다", cashflow.ts).
 */
export type FundingSourceKind =
  /** 같은 사람의 다른 증권사 연금저축에서 옮겨온 돈 — 내부 이동. 원금 불변 */
  | "internal_transfer"
  /** 새로 납입한 돈 — 외부 입금. 원금이 그만큼 늘어난다 */
  | "external_deposit";

export interface FundingSourceEffect {
  kind: FundingSourceKind;
  /** 원금(Σ외부 입출금)에 더해지는 금액 */
  principalDelta: number;
  /** 내부 이동 대금이 어디서 와야 하는가 */
  requires: string;
}

export function effectOfFundingSource(kind: FundingSourceKind, amount: number): FundingSourceEffect {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("금액이 올바르지 않습니다");
  return kind === "internal_transfer"
    ? { kind, principalDelta: 0, requires: "이전 전 증권사의 이탈 근거(매도 체결 또는 실물 이전 증거)가 원장에 있어야 한다" }
    : { kind, principalDelta: amount, requires: "실제 새 납입임을 사용자가 확인해야 한다(cashflow 입금 확인 흐름)" };
}

// ── 이전 증거 점검 ──────────────────────────────────────────────────────────

export type TransferMode = "sold_then_cash_transfer" | "in_kind_transfer" | "unknown";

export interface TransferEvidence {
  mode: TransferMode;
  /** 이전 전 증권사 쪽 이탈 근거가 원장에 있는가 (매도 체결 행 또는 실물 이전 증거) */
  exitEvidenceInLedger: boolean;
  /** 새 증권사로 자금이 들어온 일자(YYYY-MM-DD)와 금액. 사용자가 확인한 값만 */
  cashReceived?: { date: string; amount: number; basis: "broker_statement" | "balance_observation" | "user_confirmed" } | null;
  /** 이전 후 새 증권사 잔고 관측이 있는가 */
  postTransferObservation: boolean;
}

export interface TransferEvidenceCheck {
  sufficient: boolean;
  missing: string[];
  createsCashflow: false;
  principalEffect: "none";
}

export function checkTransferEvidence(ev: TransferEvidence): TransferEvidenceCheck {
  const missing: string[] = [];
  if (ev.mode === "unknown") missing.push("이전 방식(매도 후 현금 이전 / 실물 이전)");
  if (!ev.exitEvidenceInLedger) missing.push("이전 전 증권사의 이탈 근거(매도 체결 또는 실물 이전 증거)");
  if (ev.mode === "sold_then_cash_transfer" && !ev.cashReceived) missing.push("새 증권사 입고 일자·금액");
  if (ev.cashReceived && (!/^\d{4}-\d{2}-\d{2}$/.test(ev.cashReceived.date) || !(ev.cashReceived.amount >= 0))) {
    missing.push("입고 일자·금액 형식");
  }
  if (!ev.postTransferObservation) missing.push("이전 후 새 증권사 잔고 관측");
  return { sufficient: missing.length === 0, missing, createsCashflow: false, principalEffect: "none" };
}

// ── 이전 전 증권사 보유가 이탈 처리되지 않고 남았는가 (증권사 잔고 조회 없이) ──────────

export interface ResidualTradeInput {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  source: string;
}

/**
 * **새 증권사 출처가 아닌** 원장 행만 재생해 남아 있는 보유(ticker → 수량)를 구한다.
 *
 * 계좌가 새 증권사로 옮겨 갔다면(레지스트리에 새 증권사 계좌가 활성) 이전 전 증권사의 보유는
 * 이탈(매도 체결 또는 실물 이전 증거)로 정리돼 있어야 한다. 양수로 남아 있다면 그 이탈
 * 근거가 원장에 **없다**는 뜻이고, 새 증권사 매수만 더하면 같은 보유가 이중 계산된다.
 *
 * 이 함수는 가상의 매도를 만들지 않는다 — 있는 그대로 남은 수량만 알려 준다.
 * (음수는 데이터 오류라 여기서 판정하지 않고 무시한다.)
 */
export function priorBrokerResidual(
  trades: readonly ResidualTradeInput[],
  newBrokerSource: string,
): Record<string, number> {
  const held: Record<string, number> = {};
  for (const t of trades) {
    if (t.source === newBrokerSource) continue;
    held[t.ticker] = (held[t.ticker] ?? 0) + (t.side === "buy" ? t.quantity : -t.quantity);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(held)) if (v > 0) out[k] = v;
  return out;
}
