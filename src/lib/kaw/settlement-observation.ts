// ─────────────────────────────────────────────────────────────────────────────
// 결제 관측(settlement observation) — 순수 모듈
//
// ## 세 날짜를 섞지 않는다
//
//   observed_at        우리가 조회한 시각            (사실)
//   state_as_of        증권사가 말하는 상태 기준일    (사실)
//   state_as_of_basis  그 기준일이 무엇인가           broker_reported_date | observation_date
//
// **추정 날짜를 이 테이블에 넣지 않는다.** 결제 전이가 언제 일어났는지는 관측 **시퀀스**
// 에서 나오는 결론이고(reconcile.ts), 관측 행에 쓰면 추정이 사실로 굳는다.
// 실례: 한국투자 IRP 현재잔고를 2026-10-09 에 조회했다면 state_as_of 는 2026-10-09 다.
// 결제일로 추정되는 2026-10-07 로 소급하지 않는다.
//
// ## capture — holdings 와 cash 를 잘못 짝짓지 않는다
//
// IRP 는 holdings(TTTC2202R)와 cash(TTTC0506R)가 **다른 API 호출**이고, 같은 날 여러 번
// 조회할 수 있다. `state_as_of` 만으로 묶으면 오전 holdings 와 오후 cash 가 섞인다.
//
// 그래서 **capture 단위 해시**를 쓴다: 한 refresh 에서 나온 part 들을 묶어 해시하고,
// 그것으로 capture_id 를 만든다.
//   · 같은 refresh 를 두 번 → 같은 capture_id → capture 전체 dedupe
//   · 한 part 라도 값이 변함 → 다른 capture_id → capture 전체 신규
// holdings 값이 같을 때 행이 중복 저장되는 것은 **의도된 비용**이다 — 저장 몇 행 대신
// "이 cash 와 이 holdings 가 같은 순간의 것"이라는 모호함을 완전히 없앤다.
//
// `observed_at` 은 해시에 넣지 않는다 — 넣으면 조회할 때마다 행이 쌓여 폴링 로그가 된다.
//
// ## partial capture
//
// 두 호출 중 하나만 성공해도 capture 를 만든다. 축별로 없는 것은 **unobserved** 다.
// 재시도에서 둘 다 성공하면 해시가 달라져 별 capture 가 생기고, 이전 partial capture
// 는 **삭제하지 않는다**(append-only. void 만 가능).
//
// ## append-only 의 정정 경로
//
// 필드 단위 correction overlay 를 만들지 않는다 — 관측값의 일부를 고치면 그 숫자의
// provenance 가 사라진다. 잘못 입력했으면 **올바른 값으로 새 observation** 을 넣고
// 틀린 것에 void 행을 단다(`replacedBy` 로 연결). 되돌리기는 void 행 삭제다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { canonicalJson, stableDigest } from "./rebalance-plan";
import {
  capabilitiesOf,
  effectiveHoldingsOmission,
  type HoldingsCompleteness,
  type SettlementBasis,
  type StateAsOfSemantics,
} from "./source-registry";

export const CAPTURE_HASH_VERSION = 1;

/** `kaw_settlement_observation` 1행. 한 조회(part) 의 결과다. */
export interface ObservationPart {
  id: string;
  captureId: string;

  accountType: AccountId;
  broker: string;
  brokerProductCode?: string | null;
  accountInstanceId: string;
  accountRefFingerprint?: string | null;

  /** 조회 시각 (ISO). **해시에 들어가지 않는다** */
  observedAt: string;
  /** 증권사가 말하는 상태 기준일 */
  stateAsOf: string;
  stateAsOfBasis: StateAsOfSemantics;
  settlementBasis: SettlementBasis;
  sourceType: string;

  /** ticker → 수량. 보고하지 않으면 **null** — 0 으로 채우지 않는다 */
  holdings: Record<string, number> | null;
  holdingsCompleteness: HoldingsCompleteness;
  cash: number | null;
  acquisitionCost?: Record<string, number> | null;
  accountTotal?: number | null;

  capturePayloadHash: string;
  hashVersion: number;
  note?: string | null;
  actor: string;
}

/** void overlay 1행. 잘못된 관측을 계산에서 제외한다(삭제가 아니다). */
export interface ObservationVoid {
  observationId: string;
  /** 사유 없는 void 를 만들지 않는다 */
  reason: string;
  replacedBy?: string | null;
}

/** 같은 refresh 에서 나온 part 들의 묶음. DB 테이블이 아니라 **파생 그룹**이다. */
export interface Capture {
  captureId: string;
  accountType: AccountId;
  accountInstanceId: string;
  accountRefFingerprint?: string | null;
  stateAsOf: string;
  /** 그룹 안에서 가장 이른 조회 시각 */
  observedAt: string;
  parts: ObservationPart[];
}

// ── capture 해시 / id ──────────────────────────────────────────────────────

/** 해시에 들어가는 part 의 경제적 내용. observedAt / id / captureId 는 제외다. */
interface CanonicalPart {
  sourceType: string;
  stateAsOfBasis: StateAsOfSemantics;
  settlementBasis: SettlementBasis;
  holdings: Record<string, number> | null;
  holdingsCompleteness: HoldingsCompleteness;
  cash: number | null;
  acquisitionCost: Record<string, number> | null;
  accountTotal: number | null;
}

/** ticker 키 정렬. null 과 빈 객체를 **다르게** 유지한다. */
function normalizeMap(m: Record<string, number> | null | undefined): Record<string, number> | null {
  if (m === null || m === undefined) return null;
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

export type CapturePartInput = Pick<
  ObservationPart,
  | "sourceType"
  | "stateAsOfBasis"
  | "settlementBasis"
  | "holdings"
  | "holdingsCompleteness"
  | "cash"
> &
  Partial<Pick<ObservationPart, "acquisitionCost" | "accountTotal">>;

export interface CaptureCanonicalPayload {
  accountInstanceId: string;
  stateAsOf: string;
  parts: CanonicalPart[];
}

/** capture 전체의 canonical payload. part 는 sourceType 오름차순으로 고정한다. */
export function captureCanonicalPayload(
  accountInstanceId: string,
  stateAsOf: string,
  parts: readonly CapturePartInput[],
): CaptureCanonicalPayload {
  const canonical: CanonicalPart[] = parts
    .map((p) => ({
      sourceType: p.sourceType,
      stateAsOfBasis: p.stateAsOfBasis,
      settlementBasis: p.settlementBasis,
      holdings: normalizeMap(p.holdings),
      holdingsCompleteness: p.holdingsCompleteness,
      cash: p.cash === undefined ? null : p.cash,
      acquisitionCost: normalizeMap(p.acquisitionCost),
      accountTotal: p.accountTotal === undefined ? null : p.accountTotal,
    }))
    .sort((a, b) => a.sourceType.localeCompare(b.sourceType));
  return { accountInstanceId, stateAsOf, parts: canonical };
}

export function capturePayloadHash(
  accountInstanceId: string,
  stateAsOf: string,
  parts: readonly CapturePartInput[],
  version: number = CAPTURE_HASH_VERSION,
): string {
  const payload = captureCanonicalPayload(accountInstanceId, stateAsOf, parts);
  return `c${version}|${stableDigest(canonicalJson(payload))}`;
}

export function captureHashVersionOf(hash: string | undefined): number | null {
  const m = /^c(\d+)\|/.exec(hash ?? "");
  return m ? Number(m[1]) : null;
}

/** `cap:<instance>:<stateAsOf>:<hash12>` — 내용에서 결정적으로 나온다. */
export function captureId(
  accountInstanceId: string,
  stateAsOf: string,
  parts: readonly CapturePartInput[],
  version: number = CAPTURE_HASH_VERSION,
): string {
  const hash = capturePayloadHash(accountInstanceId, stateAsOf, parts, version);
  const digest = hash.slice(hash.indexOf("|") + 1);
  return `cap:${accountInstanceId}:${stateAsOf}:${digest.slice(0, 12)}`;
}

/** `obs:<captureId>:<sourceType>` — 한 capture 안에서 source 는 유일하다. */
export function observationRowId(capId: string, sourceType: string): string {
  return `obs:${capId}:${sourceType}`;
}

// ── part → capture 그룹 ───────────────────────────────────────────────────

/** void 된 part 는 그룹에서 **제외한다**. 모든 part 가 void 면 capture 자체가 사라진다. */
export function groupCaptures(
  parts: readonly ObservationPart[],
  voids: readonly ObservationVoid[] = [],
): Capture[] {
  const voided = new Set(voids.map((v) => v.observationId));
  const byCapture = new Map<string, ObservationPart[]>();
  for (const p of parts) {
    if (voided.has(p.id)) continue;
    const list = byCapture.get(p.captureId);
    if (list) list.push(p);
    else byCapture.set(p.captureId, [p]);
  }
  const out: Capture[] = [];
  for (const [capId, list] of byCapture) {
    const sorted = [...list].sort((a, b) => a.sourceType.localeCompare(b.sourceType));
    const first = sorted[0];
    out.push({
      captureId: capId,
      accountType: first.accountType,
      accountInstanceId: first.accountInstanceId,
      accountRefFingerprint: first.accountRefFingerprint ?? null,
      stateAsOf: first.stateAsOf,
      observedAt: sorted.reduce((min, p) => (p.observedAt < min ? p.observedAt : min), first.observedAt),
      parts: sorted,
    });
  }
  return out;
}

// ── capture 안의 축 추출 ──────────────────────────────────────────────────

export type AxisValue<T> =
  | { kind: "value"; value: T; sourceType: string }
  /** 이 capture 에는 그 축이 없다 */
  | { kind: "absent" }
  /** 한 capture 안의 part 들이 서로 다른 값을 말한다 — fail closed */
  | { kind: "conflict"; values: T[] };

/**
 * capture 의 holdings. **자동 reconciliation 가능한 source 만** 본다
 * (`autoReconcile: false` 인 broker_historical_balance 등은 제외 — D6).
 */
export function holdingsOf(capture: Capture): AxisValue<Record<string, number>> {
  const candidates = capture.parts.filter(
    (p) => p.holdings !== null && capabilitiesOf(p.sourceType).autoReconcile,
  );
  if (!candidates.length) return { kind: "absent" };
  const first = candidates[0];
  const firstJson = canonicalJson(normalizeMap(first.holdings));
  const differing = candidates.filter((p) => canonicalJson(normalizeMap(p.holdings)) !== firstJson);
  if (differing.length) {
    return { kind: "conflict", values: candidates.map((p) => p.holdings as Record<string, number>) };
  }
  return { kind: "value", value: first.holdings as Record<string, number>, sourceType: first.sourceType };
}

/** capture 의 cash. 규칙은 holdings 와 같다. */
export function cashOf(capture: Capture): AxisValue<number> {
  const candidates = capture.parts.filter(
    (p) => p.cash !== null && capabilitiesOf(p.sourceType).autoReconcile,
  );
  if (!candidates.length) return { kind: "absent" };
  const first = candidates[0];
  const differing = candidates.filter((p) => p.cash !== first.cash);
  if (differing.length) return { kind: "conflict", values: candidates.map((p) => p.cash as number) };
  return { kind: "value", value: first.cash as number, sourceType: first.sourceType };
}

/** holdings+cash 2 / holdings only 1 / cash only 0 / 둘 다 없음 -1 */
export function completenessRank(capture: Capture): number {
  const h = holdingsOf(capture).kind === "value";
  const c = cashOf(capture).kind === "value";
  if (h && c) return 2;
  if (h) return 1;
  if (c) return 0;
  return -1;
}

/**
 * capture 선택 정렬 (앞이 더 우선).
 *
 *   1  stateAsOf        desc   ← **더 늦은 날짜의 상태가 더 이른 날짜를 대체한다**
 *   2  completenessRank desc   ← 완전성은 **같은 stateAsOf 안에서만** tie-break 이다
 *   3  observedAt       desc
 *   4  captureId        asc    ← 최종 결정성
 *
 * 1 이 primary 인 이유: 날짜를 넘어 "더 완전한 것"을 고르면 cash 가 딸려 있다는 이유로
 * **오래된 holdings** 를 쓰게 된다. 그건 틀린 상태다.
 */
export function compareCaptureSelection(a: Capture, b: Capture): number {
  if (a.stateAsOf !== b.stateAsOf) return a.stateAsOf < b.stateAsOf ? 1 : -1;
  const ra = completenessRank(a);
  const rb = completenessRank(b);
  if (ra !== rb) return rb - ra;
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? 1 : -1;
  return a.captureId.localeCompare(b.captureId);
}

/** 시간순(오름차순) — 전이 판정용 시퀀스에 쓴다. */
export function sortCapturesAscending(captures: readonly Capture[]): Capture[] {
  return [...captures].sort((a, b) => -compareCaptureSelection(a, b));
}

/** holdings 를 제공하는 capture 만, 시간 오름차순으로. */
export function holdingsCaptureSequence(captures: readonly Capture[]): Capture[] {
  return sortCapturesAscending(captures.filter((c) => holdingsOf(c).kind === "value"));
}

// ── plan universe 기준 holdings 정규화 ────────────────────────────────────

export interface NormalizedHoldings {
  /** plan universe 안에서 비교 가능한 ticker → 수량 */
  byTicker: Record<string, number>;
  /** 응답에 없고 부재를 0 으로 볼 수도 없는 ticker — **추정하지 않는다** */
  nonComparable: string[];
  /** plan 에 없는데 증권사가 보고한 ticker. mismatch 가 아니라 **별도 보고**다 */
  extraneous: Array<{ ticker: string; quantity: number }>;
}

/**
 * 증권사 holdings 를 plan universe 로 맞춘다.
 *
 *   t ∈ universe, 응답에 있음           → 그 값
 *   t ∈ universe, 응답에 없음
 *       omission non_zero_only          → **0** (전량매도를 검증할 수 있다)
 *       omission unknown                → nonComparable (0 으로 추정 금지)
 *   t ∉ universe, 응답에 있음           → extraneous (전략 밖 보유 / orphan / 다른 경로)
 */
export function normalizeHoldings(
  observed: Record<string, number>,
  planUniverse: readonly string[],
  sourceType: string,
  rowCompleteness?: HoldingsCompleteness | null,
): NormalizedHoldings {
  const omission = effectiveHoldingsOmission(sourceType, rowCompleteness);
  const universe = new Set(planUniverse);
  const byTicker: Record<string, number> = {};
  const nonComparable: string[] = [];

  for (const ticker of [...universe].sort()) {
    if (Object.prototype.hasOwnProperty.call(observed, ticker)) {
      byTicker[ticker] = observed[ticker];
    } else if (omission === "non_zero_only") {
      byTicker[ticker] = 0;
    } else {
      nonComparable.push(ticker);
    }
  }

  const extraneous = Object.keys(observed)
    .filter((t) => !universe.has(t) && observed[t] !== 0)
    .sort()
    .map((ticker) => ({ ticker, quantity: observed[ticker] }));

  return { byTicker, nonComparable, extraneous };
}
