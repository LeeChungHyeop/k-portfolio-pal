// ─────────────────────────────────────────────────────────────────────────────
// 계좌 이전 확정 기록 (Phase 4-C-1) — 순수 모듈
//
// "미래에셋 ETF 전량 매도 후 현금 이전"을 **사용자가 명시적으로 확정**한 사실을 남긴다.
// 원장 행도, cashflow 도 만들지 않는다. 이 기록이 하는 일은 셋뿐이다:
//
//   1. 이전 증권사 계좌(instance)와 새 증권사 계좌(instance)를 기준일과 함께 연결한다
//   2. 이전 증권사의 이탈 근거가 **추정 매도**(사용자 승인 가격 대용)인지, 실제 체결인지 구분해 보존한다
//   3. 누가 언제 무엇을 확인하고 승인했는지 남긴다 (append-only 이력)
//
// 저장 위치: 새 테이블을 만들지 않는다. 기존 append-only `kaw_ledger_audit`(migration 004) 한 행에
// `action = 'transfer_confirm'`, `target_type = 'import'`, `new_value = TransferRecord` 로 쌓는다.
// service_role 에는 SELECT/INSERT 만 있어서 **고치거나 지울 수 없다**(권한으로 강제).
//
// ## 하지 않는 것
//   · 추정 매도를 실제 체결로 바꾸지 않는다 — 원장 행은 그대로이고, 기록은 그 행을
//     `basis: "user_attested_estimate"` 로 **스냅샷**해서 가리킨다
//   · 입고 일자를 지어내지 않는다 — 모르면 null
//   · 원금(누적 납입원금)을 바꾸지 않는다 — `principalEffect: "none"`, `createsCashflow: false`
//   · 관측값과 원장 유도값의 차이를 이자·분배금·수수료·매도차익 등으로 분류하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import type { BrokerAccountInstance } from "./broker-account";
import { checkTransferEvidence, priorBrokerResidual } from "./account-transfer-model";
import type { LedgerTransaction } from "./ledger";
import { KIS_LEDGER_SOURCE } from "./kis-execution-preview";

export const TRANSFER_AUDIT_ACTION = "transfer_confirm";
export const TRANSFER_AUDIT_TARGET_TYPE = "import";
export const TRANSFER_RECORD_VERSION = 1;

/** 새 증권사(한국투자) 체결 출처 — 이 출처의 행은 '이전 증권사 이탈 근거'가 될 수 없다 */
export const NEW_BROKER_LEDGER_SOURCE = KIS_LEDGER_SOURCE;
/** 사용자가 승인한 **가격 대용 추정 매도**의 출처. 실제 체결이 아니다 */
export const ESTIMATED_EXIT_SOURCES: readonly string[] = ["user_attested_liquidation_price_proxy"];

export type ExitBasis = "user_attested_estimate" | "broker_execution";

export interface TransferExitEvidence {
  txId: string;
  ticker: string;
  etfName: string;
  side: "sell";
  quantity: number;
  price: number;
  amount: number;
  eventDate: string;
  /** 원장 행의 출처 그대로 */
  source: string;
  importBatchId: string | null;
  /** 날짜 근거 문구 그대로 — 추정이면 "exact-sale-date-unknown" 등이 들어 있다 */
  tradeDateEvidence: string;
  /** 추정(사용자 승인 가격 대용)인가, 실제 체결인가 */
  basis: ExitBasis;
}

export interface TransferRecord {
  version: typeof TRANSFER_RECORD_VERSION;
  kind: "sold_then_cash_transfer";
  logicalAccountType: AccountId;

  /** 새 증권사(한국투자) 계좌 instance */
  toInstanceId: string;
  toBroker: string;
  toProductCode: string | null;
  /** 이전 증권사 계좌 instance. 레지스트리에 등록돼 있지 않으면 null (broker/label 만 남는다) */
  fromInstanceId: string | null;
  fromBroker: string;
  fromLabel: string;

  /** 이전 회계 기준일 — 이전 증권사 쪽 이탈이 끝난 것으로 보는 날 (추정일 수 있다) */
  anchorDate: string;

  /** 새 증권사로 들어온 현금. 일자는 모르면 null — 지어내지 않는다 */
  cashReceived: { amount: number; date: string | null; basis: "user_confirmed" };

  /** 이탈 근거로 지목한 원장 행의 스냅샷 */
  exitEvidence: TransferExitEvidence[];
  /** 이탈 근거 중 하나라도 추정이면 true. 추정 매도는 실제 체결이 아니다 */
  containsEstimates: boolean;

  /** 이 기록은 원금도 cashflow 도 만들지 않는다 */
  principalEffect: "none";
  createsCashflow: false;

  /** 확정 시점의 새 증권사 잔고 관측 (있어야 확정할 수 있다) */
  observation: { captureId: string; stateAsOf: string; observedAt: string };

  approval: { actor: string; at: string; note: string | null };
}

export interface TransferConfirmInput {
  toInstanceId: unknown;
  fromInstanceId?: unknown;
  fromBroker?: unknown;
  fromLabel?: unknown;
  anchorDate: unknown;
  cashReceived: { amount: unknown; date?: unknown } | null | undefined;
  exitTxIds: unknown;
  note?: unknown;
  /** 사용자가 이해하고 승인했다는 명시적 표시. true 가 아니면 아무것도 하지 않는다 */
  approved: unknown;
}

export interface TransferObservationRef {
  captureId: string;
  stateAsOf: string;
  observedAt: string;
}

export interface TransferValidationContext {
  registry: readonly BrokerAccountInstance[];
  /** 이 계좌(논리)의 유효 원장. 정정이 적용된 값이어야 한다 */
  ledger: readonly LedgerTransaction[];
  existing: readonly TransferRecord[];
  /** 새 증권사 instance 의 잔고 관측 (가장 최근 capture) */
  observation: TransferObservationRef | null;
  today: string;
  actor: string;
  nowIso: string;
}

export type TransferRejectCode =
  | "approval_required"
  | "bad_request"
  | "target_instance_invalid"
  | "source_instance_invalid"
  | "anchor_invalid"
  | "cash_invalid"
  | "exit_rows_invalid"
  | "residual_remains"
  | "already_confirmed"
  | "evidence_missing";

export type TransferValidation =
  | { ok: true; record: TransferRecord }
  | { ok: false; code: TransferRejectCode; message: string; detail?: unknown };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const realIso = (d: unknown): d is string => {
  if (typeof d !== "string" || !ISO.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
/** 계좌번호 같은 긴 숫자열은 저장하지 않는다 */
const safeText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max && !/\d{8,}/.test(v) ? v.trim() : null;

export function exitBasisOf(source: string): ExitBasis {
  return ESTIMATED_EXIT_SOURCES.includes(source) ? "user_attested_estimate" : "broker_execution";
}

export function exitEvidenceOf(t: LedgerTransaction): TransferExitEvidence {
  return {
    txId: t.id, ticker: t.ticker, etfName: t.etfName, side: "sell",
    quantity: t.quantity, price: t.price, amount: t.amount,
    eventDate: String(t.eventDate).slice(0, 10), source: t.source,
    importBatchId: t.importBatchId ?? null, tradeDateEvidence: String(t.tradeDateEvidence),
    basis: exitBasisOf(t.source),
  };
}

/**
 * 확정 요청을 검증하고 기록을 만든다. **쓰지 않는다** — 저장은 서버 핸들러가 한다.
 * 어느 하나라도 어긋나면 거부하고, 추측으로 채우지 않는다.
 */
export function validateTransferConfirm(input: TransferConfirmInput, ctx: TransferValidationContext): TransferValidation {
  const fail = (code: TransferRejectCode, message: string, detail?: unknown): TransferValidation => ({ ok: false, code, message, ...(detail === undefined ? {} : { detail }) });

  if (input.approved !== true) return fail("approval_required", "사용자의 명시적 승인(approved: true)이 없어 기록하지 않았습니다.");

  if (typeof input.toInstanceId !== "string" || !input.toInstanceId) return fail("bad_request", "새 증권사 계좌가 지정되지 않았습니다.");
  const to = ctx.registry.find((i) => i.id === input.toInstanceId);
  if (!to || to.broker !== "kis" || to.logicalAccountType !== "pension") {
    return fail("target_instance_invalid", "새 증권사 계좌는 등록된 한국투자 연금저축 계좌여야 합니다.");
  }

  // 이전 증권사: 등록된 instance 를 고르거나, 없으면 broker/label 을 직접 적는다 (계좌번호 금지)
  let fromInstanceId: string | null = null;
  let fromBroker: string | null;
  let fromLabel: string | null;
  if (typeof input.fromInstanceId === "string" && input.fromInstanceId) {
    const from = ctx.registry.find((i) => i.id === input.fromInstanceId);
    if (!from || from.id === to.id || from.logicalAccountType !== to.logicalAccountType) {
      return fail("source_instance_invalid", "이전 증권사 계좌는 같은 논리 계좌의 다른 등록 계좌여야 합니다.");
    }
    fromInstanceId = from.id; fromBroker = from.broker; fromLabel = from.label;
  } else {
    fromBroker = safeText(input.fromBroker, 40);
    fromLabel = safeText(input.fromLabel, 60);
    if (!fromBroker || !fromLabel) return fail("source_instance_invalid", "이전 증권사 이름과 표시 이름을 입력하세요(계좌번호는 입력하지 않습니다).");
  }

  if (!realIso(input.anchorDate) || input.anchorDate > ctx.today || input.anchorDate > to.activeFrom) {
    return fail("anchor_invalid", "이전 기준일은 실제 날짜여야 하고, 오늘 이전이며 새 계좌 시작일(또는 그 이전)이어야 합니다.");
  }

  const cr = input.cashReceived;
  const amount = cr && typeof cr.amount === "number" ? cr.amount : NaN;
  if (!cr || !Number.isInteger(amount) || amount <= 0 || amount > 1e12) return fail("cash_invalid", "이전 확인 금액은 0보다 큰 정수(원)여야 합니다.");
  const cashDate = cr.date === undefined || cr.date === null || cr.date === "" ? null : cr.date;
  if (cashDate !== null && (!realIso(cashDate) || cashDate > ctx.today)) return fail("cash_invalid", "입고 일자는 실제 날짜여야 합니다. 모르면 비워 두세요.");

  // 이탈 근거: 이 계좌의 이전 증권사 출처 매도 행이어야 한다 (새 증권사 출처 불가)
  if (!Array.isArray(input.exitTxIds) || input.exitTxIds.length === 0 || input.exitTxIds.some((x) => typeof x !== "string") ||
      new Set(input.exitTxIds as string[]).size !== input.exitTxIds.length) {
    return fail("exit_rows_invalid", "이탈 근거가 될 매도 거래를 하나 이상 중복 없이 지정하세요.");
  }
  const byId = new Map(ctx.ledger.map((t) => [t.id, t]));
  const exits: LedgerTransaction[] = [];
  for (const id of input.exitTxIds as string[]) {
    const t = byId.get(id);
    if (!t || t.accountId !== to.logicalAccountType || t.side !== "sell" || t.source === NEW_BROKER_LEDGER_SOURCE ||
        String(t.eventDate).slice(0, 10) > input.anchorDate) {
      return fail("exit_rows_invalid", "이탈 근거는 이전 증권사 출처의 매도 거래이며 이전 기준일 이전이어야 합니다.", { txId: id });
    }
    exits.push(t);
  }

  // 이전 증권사 출처 보유가 전부 정리돼 있어야 한다 (가상의 매도를 만들지 않는다)
  const residual = priorBrokerResidual(
    ctx.ledger.filter((t) => t.accountId === to.logicalAccountType).map((t) => ({ ticker: t.ticker, side: t.side, quantity: t.quantity, source: t.source })),
    NEW_BROKER_LEDGER_SOURCE,
  );
  if (Object.keys(residual).length > 0) {
    return fail("residual_remains", "이전 증권사 출처의 원장 보유가 아직 남아 있어 이전을 확정할 수 없습니다.", residual);
  }

  if (ctx.existing.some((r) => r.toInstanceId === to.id)) return fail("already_confirmed", "이 새 계좌의 이전은 이미 확정되어 있습니다(기록은 고치지 않습니다).");

  // '이전 후 관측'이어야 한다: 증권사 기준일이 이전 기준일보다 앞선 관측은 이전 후 잔고의 증거가 아니다.
  const observationAfterAnchor = ctx.observation !== null && ctx.observation.stateAsOf >= input.anchorDate;
  const evidence = checkTransferEvidence({
    mode: "sold_then_cash_transfer",
    exitEvidenceInLedger: exits.length > 0,
    cashReceived: { date: cashDate, amount, basis: "user_confirmed" },
    postTransferObservation: observationAfterAnchor,
  });
  if (!evidence.sufficient || !ctx.observation) return fail("evidence_missing", "이전 증거가 부족합니다.", evidence.missing);

  const exitEvidence = exits.map(exitEvidenceOf);
  const note = safeText(input.note, 200);
  return {
    ok: true,
    record: {
      version: TRANSFER_RECORD_VERSION,
      kind: "sold_then_cash_transfer",
      logicalAccountType: to.logicalAccountType,
      toInstanceId: to.id, toBroker: to.broker, toProductCode: to.productCode ?? null,
      fromInstanceId, fromBroker: fromBroker as string, fromLabel: fromLabel as string,
      anchorDate: input.anchorDate,
      cashReceived: { amount, date: cashDate, basis: "user_confirmed" },
      exitEvidence,
      containsEstimates: exitEvidence.some((e) => e.basis === "user_attested_estimate"),
      principalEffect: "none",
      createsCashflow: false,
      observation: { captureId: ctx.observation.captureId, stateAsOf: ctx.observation.stateAsOf, observedAt: ctx.observation.observedAt },
      approval: { actor: ctx.actor, at: ctx.nowIso, note },
    },
  };
}

/** 이전 증권사 이탈 근거 후보 — 화면에서 고르게 한다. 추정은 기본 선택, 실제 체결은 표시만 */
export function exitCandidatesOf(ledger: readonly LedgerTransaction[], toActiveFrom: string, windowDays = 14): TransferExitEvidence[] {
  const from = Date.parse(`${toActiveFrom}T00:00:00Z`) - windowDays * 86_400_000;
  return ledger
    .filter((t) => t.side === "sell" && t.source !== NEW_BROKER_LEDGER_SOURCE && Date.parse(`${String(t.eventDate).slice(0, 10)}T00:00:00Z`) >= from)
    .map(exitEvidenceOf);
}

/**
 * audit 행(new_value) → 기록. 모양이 어긋난 행은 버린다(고치지 않는다).
 * 같은 새 계좌(toInstanceId)의 이력이 여럿이면(동시 요청 경합) **가장 먼저 승인된 하나**만 유효로 본다 —
 * DB 에 유니크 제약이 없어(append-only audit) 읽는 쪽이 일관되게 하나로 해석한다.
 */
export function parseTransferRecords(rows: ReadonlyArray<{ new_value?: unknown }>): TransferRecord[] {
  const out: TransferRecord[] = [];
  for (const r of rows) {
    const v = r.new_value as Partial<TransferRecord> | null | undefined;
    if (!v || v.version !== TRANSFER_RECORD_VERSION || v.kind !== "sold_then_cash_transfer") continue;
    if (typeof v.toInstanceId !== "string" || typeof v.anchorDate !== "string" || !v.cashReceived || typeof v.cashReceived.amount !== "number") continue;
    if (!Array.isArray(v.exitEvidence) || !v.approval || typeof v.approval.actor !== "string") continue;
    out.push(v as TransferRecord);
  }
  out.sort((a, b) => String(a.approval.at).localeCompare(String(b.approval.at)));
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.toInstanceId) ? false : (seen.add(r.toInstanceId), true)));
}

/** 같은 새 계좌의 이력 행 수(중복 포함). 경합으로 둘 이상 생겼는지 확인하는 데만 쓴다 */
export function countTransferRowsFor(rows: ReadonlyArray<{ new_value?: unknown }>, toInstanceId: string): number {
  return rows.filter((r) => (r.new_value as { kind?: unknown; toInstanceId?: unknown } | null)?.kind === "sold_then_cash_transfer"
    && (r.new_value as { toInstanceId?: unknown }).toInstanceId === toInstanceId).length;
}
