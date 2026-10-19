// ─────────────────────────────────────────────────────────────────────────────
// 계좌 이전 상태 조립 (Phase 4-C-1) — 순수 함수 + 서버/화면 공용 타입
//
// DB 에서 읽은 값(원장 · 레지스트리 · cashflow · 이전 기록 · 최근 관측)을 화면이 쓸 상태로 만든다.
// 아무것도 쓰지 않는다. 원금(Σcashflow)은 읽기만 하고, 이전 기록이 있어도 바뀌지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";
import { buildDerivedCash, type CashFlowInput } from "./derived-cash";
import { priorBrokerResidual } from "./account-transfer-model";
import {
  NEW_BROKER_LEDGER_SOURCE,
  exitCandidatesOf,
  type TransferExitEvidence,
  type TransferRecord,
} from "./account-transfer-record";
import type { BalanceObservationSummary } from "./kis-balance-observation";
import { weekdaysBetween } from "./kis-execution-compose";

export interface TransferChecklistItem {
  id: "target_registered" | "prior_exit_in_ledger" | "observation_recorded" | "transfer_confirmed";
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ExitCandidateView extends TransferExitEvidence {
  /** 추정(사용자 승인 가격 대용) 매도는 기본으로 선택해 둔다. 실제 체결은 선택하지 않는다 */
  defaultSelected: boolean;
}

export type TransferStateResponse =
  | { state: "no_target" }
  | {
      state: "ok";
      target: { instanceId: string; label: string; activeFrom: string; productCode: string | null };
      fromCandidates: Array<{ id: string; label: string; broker: string; activeFrom: string; activeTo?: string }>;
      exitCandidates: ExitCandidateView[];
      records: TransferRecord[];
      observation: BalanceObservationSummary | null;
      ledger: {
        /** 현재 원장 기준 유도 예수금(finalDerived) */
        derivedCash: number;
        /** 누적 납입원금 = Σ외부 입출금. 이전 기록이 바꾸지 않는다 */
        principal: number;
        /** 한국투자 출처 매수 중 이미 원장에 있는 금액 (지금은 0) */
        kisBuyAmountInLedger: number;
        /** 이전 증권사 출처 보유 중 이탈 처리되지 않고 남은 수량 */
        priorBrokerResidual: Record<string, number>;
      };
      checklist: TransferChecklistItem[];
      canObserve: boolean;
      canConfirm: boolean;
    };

export interface TransferStateInput {
  registry: readonly BrokerAccountInstance[];
  /** 정정이 적용된 이 계좌(pension)의 유효 원장 */
  ledger: readonly LedgerTransaction[];
  flows: readonly CashFlowInput[];
  records: readonly TransferRecord[];
  observation: BalanceObservationSummary | null;
  today: string;
}

/** 이 계좌의 새 증권사(한국투자 연금저축 22) 대상 instance. 여럿이면 가장 최근에 시작한 것 */
export function transferTargetOf(registry: readonly BrokerAccountInstance[]): BrokerAccountInstance | null {
  const mine = registry
    .filter((i) => i.broker === "kis" && i.productCode === "22" && i.logicalAccountType === "pension")
    .sort((a, b) => b.activeFrom.localeCompare(a.activeFrom));
  return mine[0] ?? null;
}

export function composeTransferState(input: TransferStateInput): TransferStateResponse {
  const target = transferTargetOf(input.registry);
  if (!target) return { state: "no_target" };

  const ledger = input.ledger.filter((t) => t.accountId === "pension");
  const tradeInputs = ledger.map((t) => ({
    date: String(t.eventDate).slice(0, 10), side: t.side, amount: t.amount, fee: t.fee, tax: t.tax,
  }));
  const allDates = [...input.flows.map((f) => f.date), ...tradeInputs.map((t) => t.date)].sort();
  const tradingDates = allDates.length
    ? weekdaysBetween(allDates[0], input.today > allDates.at(-1)! ? input.today : allDates.at(-1)!)
    : [];
  const derived = buildDerivedCash({ flows: input.flows, trades: tradeInputs, tradingDates });
  const principal = input.flows.reduce((s, f) => s + f.amount, 0);

  const residual = priorBrokerResidual(
    ledger.map((t) => ({ ticker: t.ticker, side: t.side, quantity: t.quantity, source: t.source })),
    NEW_BROKER_LEDGER_SOURCE,
  );
  const kisBuyAmountInLedger = ledger
    .filter((t) => t.source === NEW_BROKER_LEDGER_SOURCE && t.side === "buy")
    .reduce((s, t) => s + t.amount, 0);

  const records = input.records.filter((r) => r.toInstanceId === target.id);
  const exitCandidates: ExitCandidateView[] = exitCandidatesOf(ledger, target.activeFrom).map((e) => ({
    ...e, defaultSelected: e.basis === "user_attested_estimate",
  }));
  const observation = input.observation && input.observation.accountInstanceId === target.id ? input.observation : null;

  const hasExit = Object.keys(residual).length === 0 && exitCandidates.length > 0;
  const checklist: TransferChecklistItem[] = [
    { id: "target_registered", label: "새 증권사(한국투자 연금저축) 계좌가 등록돼 있다", ok: true, detail: `${target.label} · ${target.activeFrom} 시작` },
    {
      id: "prior_exit_in_ledger", label: "이전 증권사 보유가 원장에서 이탈 처리돼 있다", ok: hasExit,
      detail: Object.keys(residual).length > 0
        ? `남은 보유: ${Object.entries(residual).map(([k, v]) => `${k} ${v}주`).join(", ")}`
        : exitCandidates.length === 0 ? "이탈 근거로 쓸 매도 거래가 없습니다" : undefined,
    },
    { id: "observation_recorded", label: "새 증권사 잔고 관측이 기록돼 있다", ok: observation !== null, detail: observation ? `${observation.stateAsOf} 기준` : "아직 기록되지 않았습니다" },
    { id: "transfer_confirmed", label: "계좌 이전(매도 후 현금 이전)이 확정돼 있다", ok: records.length > 0 },
  ];

  return {
    state: "ok",
    target: { instanceId: target.id, label: target.label, activeFrom: target.activeFrom, productCode: target.productCode ?? null },
    fromCandidates: input.registry
      .filter((i) => i.logicalAccountType === "pension" && i.id !== target.id)
      .map((i) => ({ id: i.id, label: i.label, broker: i.broker, activeFrom: i.activeFrom, ...(i.activeTo ? { activeTo: i.activeTo } : {}) })),
    exitCandidates,
    records,
    observation,
    ledger: { derivedCash: derived.finalDerived, principal, kisBuyAmountInLedger, priorBrokerResidual: residual },
    checklist,
    canObserve: true,
    canConfirm: records.length === 0 && hasExit && observation !== null,
  };
}
