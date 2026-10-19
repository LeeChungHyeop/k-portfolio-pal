// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 잔고 → 결제 관측(settlement observation) 변환 (Phase 4-C-1) — 순수 모듈
//
// 이미 있는 `kaw_settlement_observation`(migration 005)과 `settlement-observation.ts` 의 capture 규칙을
// **그대로 재사용**한다. 새 테이블도 새 해시 규칙도 만들지 않는다.
//
//   · 관측은 증권사가 말한 상태다 — 우리가 계산한 값이 아니다
//   · 조회 시각(observedAt)과 증권사 기준일(stateAsOf)과 그 의미(observation_date)를 따로 보존한다
//   · 보유/예수금을 **조회하지 못했으면 기록하지 않는다**(0 으로 채우지 않는다)
//   · 0행 보유를 '전부 0주'로 단정하지 않는다 — source registry 가 생략 의미를 확정하기 전에는
//     보유를 null(미관측)로 둔다
//   · 원장·보유수량 설정·예수금 설정을 바꾸지 않는다. 읽기 전용 관측값을 한 행 쌓을 뿐이다
// ─────────────────────────────────────────────────────────────────────────────

import type { KisAccountObservation } from "./kis-account-observe";
import {
  CAPTURE_HASH_VERSION,
  captureId,
  capturePayloadHash,
  observationRowId,
  type CapturePartInput,
  type ObservationPart,
} from "./settlement-observation";
import { capabilitiesOf } from "./source-registry";

/** 연금저축(22) 잔고 조회의 source — 보유종목과 예수금을 한 번의 호출(TTTC8434R)로 준다 */
export const KIS_BALANCE_SOURCE_TYPE = "kis_inquire_balance";

export type BalancePartResult =
  | { ok: true; part: ObservationPart }
  | { ok: false; reason: "not_registered_instance" | "holdings_not_observed" | "cash_not_observed" | "wrong_product" };

export function observationToPart(obs: KisAccountObservation, actor: string, note: string | null = null): BalancePartResult {
  if (obs.productCode !== "22") return { ok: false, reason: "wrong_product" };
  // 레지스트리에 등록된 계좌만 기록한다. sentinel/미해결 id 로는 어느 계좌의 관측인지 주장할 수 없다.
  if (obs.instanceBasis !== "registry") return { ok: false, reason: "not_registered_instance" };
  if (obs.holdings.kind !== "observed") return { ok: false, reason: "holdings_not_observed" };
  if (obs.cash.kind !== "observed") return { ok: false, reason: "cash_not_observed" };

  const h = obs.holdings.value;
  const positionCount = Object.keys(h.positions).length;
  // 0행을 '전부 0주'로 단정하지 않는다: 확정된 경우(confirmed_zero)만 {} 로 둔다.
  const holdings: Record<string, number> | null =
    positionCount > 0 || h.emptyMeaning === "confirmed_zero" ? { ...h.positions } : null;

  const caps = capabilitiesOf(KIS_BALANCE_SOURCE_TYPE);
  const input: CapturePartInput = {
    sourceType: KIS_BALANCE_SOURCE_TYPE,
    stateAsOfBasis: "observation_date",
    settlementBasis: caps.settlementBasis,
    holdings,
    holdingsCompleteness: holdings === null ? "unknown" : h.completeness,
    cash: obs.cash.value,
  };
  const capId = captureId(obs.accountInstanceId, obs.stateAsOf, [input]);
  return {
    ok: true,
    part: {
      id: observationRowId(capId, KIS_BALANCE_SOURCE_TYPE),
      captureId: capId,
      accountType: obs.accountType,
      broker: obs.broker,
      brokerProductCode: obs.productCode,
      accountInstanceId: obs.accountInstanceId,
      accountRefFingerprint: null,
      observedAt: obs.observedAt,
      stateAsOf: obs.stateAsOf,
      ...input,
      stateAsOfBasis: "observation_date",
      capturePayloadHash: capturePayloadHash(obs.accountInstanceId, obs.stateAsOf, [input]),
      hashVersion: CAPTURE_HASH_VERSION,
      note,
      actor,
    },
  };
}

// ── DB 행 ↔ part ────────────────────────────────────────────────────────────

export function partToDbRow(p: ObservationPart, familyCode: string, profile: string): Record<string, unknown> {
  return {
    family_code: familyCode, profile,
    id: p.id, capture_id: p.captureId,
    account_type: p.accountType, broker: p.broker, broker_product_code: p.brokerProductCode ?? null,
    account_instance_id: p.accountInstanceId, account_ref_fingerprint: p.accountRefFingerprint ?? null,
    observed_at: p.observedAt, state_as_of: p.stateAsOf, state_as_of_basis: p.stateAsOfBasis,
    settlement_basis: p.settlementBasis, source_type: p.sourceType,
    holdings: p.holdings, holdings_completeness: p.holdingsCompleteness,
    cash: p.cash, acquisition_cost: p.acquisitionCost ?? null, account_total: p.accountTotal ?? null,
    capture_payload_hash: p.capturePayloadHash, hash_version: p.hashVersion,
    note: p.note ?? null, actor: p.actor,
  };
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown) => String(v ?? "").slice(0, 10);

export function dbRowToPart(r: Record<string, unknown>): ObservationPart {
  return {
    id: String(r.id), captureId: String(r.capture_id),
    accountType: r.account_type as ObservationPart["accountType"],
    broker: String(r.broker),
    brokerProductCode: (r.broker_product_code as string | null) ?? null,
    accountInstanceId: String(r.account_instance_id),
    accountRefFingerprint: (r.account_ref_fingerprint as string | null) ?? null,
    observedAt: new Date(String(r.observed_at)).toISOString(),
    stateAsOf: day(r.state_as_of),
    stateAsOfBasis: r.state_as_of_basis as ObservationPart["stateAsOfBasis"],
    settlementBasis: r.settlement_basis as ObservationPart["settlementBasis"],
    sourceType: String(r.source_type),
    holdings: r.holdings === null || r.holdings === undefined ? null : (r.holdings as Record<string, number>),
    holdingsCompleteness: r.holdings_completeness as ObservationPart["holdingsCompleteness"],
    cash: numOrNull(r.cash),
    acquisitionCost: (r.acquisition_cost as Record<string, number> | null) ?? null,
    accountTotal: numOrNull(r.account_total),
    capturePayloadHash: String(r.capture_payload_hash),
    hashVersion: Number(r.hash_version),
    note: (r.note as string | null) ?? null,
    actor: String(r.actor),
  };
}

/** 화면·응답용 요약. 계좌번호·토큰·원문은 없다 */
export interface BalanceObservationSummary {
  captureId: string;
  accountInstanceId: string;
  broker: string;
  sourceType: string;
  /** 우리가 조회한 시각 */
  observedAt: string;
  /** 증권사가 말하는 상태 기준일 (현재 잔고 = 조회일) */
  stateAsOf: string;
  stateAsOfBasis: ObservationPart["stateAsOfBasis"];
  holdings: Record<string, number> | null;
  holdingsCompleteness: ObservationPart["holdingsCompleteness"];
  cash: number | null;
  actor: string;
}

export function summarizeObservation(p: ObservationPart): BalanceObservationSummary {
  return {
    captureId: p.captureId, accountInstanceId: p.accountInstanceId, broker: p.broker, sourceType: p.sourceType,
    observedAt: p.observedAt, stateAsOf: p.stateAsOf, stateAsOfBasis: p.stateAsOfBasis,
    holdings: p.holdings, holdingsCompleteness: p.holdingsCompleteness, cash: p.cash, actor: p.actor,
  };
}
