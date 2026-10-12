// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation — plan(계획/주장) × ledger(실제 체결) × observation(계좌 상태) 대조
//
// ## 저장하지 않는다
//
// 이 모듈의 출력은 **전부 파생값**이다. 상태를 컬럼으로 굳히면 원장 행 하나가
// 들어오는 순간 stale 해지고, 그때 backfill migration 이 필요해진다. 계산으로 두면
// 증거가 도착하는 것만으로 상태가 저절로 옳아진다(004 의 파생값 정책과 같은 이유).
//
// ## 세 축을 분리한다
//
//   executionEvidence   none | partial | complete | conflicting | indeterminate
//   settlementCheck     unobserved | pre_state_observed | intermediate_state_observed
//                       | post_state_verified | post_state_cash_divergent
//                       | settlement_overdue | state_mismatch
//   closure             open | closed(...)
//
// 단일 enum 으로 누르면 "결제는 확인됐지만 체결 증거는 없음"(IRP 정상 상태)과 "둘 다
// 없음"이 한 칸에 들어간다. 그게 §9-2 가 경계한 `P`/`H` → `A-exec` 승격 사고다.
// **settlementCheck 가 executionEvidence 를 올리지 않는다.** 단방향이다.
//
// ## discovery 와 settlement evidence 를 분리한다 (순환 제거)
//
// 후보 이벤트를 고르려면 window 가 필요하고, 증권사 보고 결제일을 알려면 이벤트가
// 필요하다 — 그대로 두면 순환이다. 두 단계로 나눈다:
//
//   1. discoveryWindow(plan)              **plan 만으로** 계산. 후보 탐색 전용이고
//                                         settlement fact 가 아니다
//   2. candidateEventIds(plan, discovery) + ledger attribution 으로 후보 확정
//   3. settlementEvidence(linkedEvents)   확정된 후보에서 **보고된** 결제일을 읽어
//                                         판정 window 를 정밀화한다
//
// **보고된 결제일을 자기 자신을 발견하기 위한 후보 window 생성에 쓰지 않는다.**
//
// ## 공휴일 달력을 만들지 않는다
//
// `WEEKDAY_GRACE_DAYS` 는 **평일 가산**이고 공휴일을 반영하지 않는다(CLAUDE.md 가
// 공휴일 달력 작성을 금지한다). 그래서 `weekday_inferred` window 초과는 **경고
// 전용**이고 단독으로 mismatch 를 만들지 않는다 — 연휴가 끼면 틀리기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import {
  resolveEventAttribution,
  sameInstance,
  type AttributableRecord,
  type BrokerAccountInstance,
  type InstanceMatch,
  type LedgerAttribution,
} from "./broker-account";
import {
  aggregateByTicker,
  effectivePreBasis,
  expectedDeltaByTicker,
  type EffectivePreBasis,
  type PlanPreResolution,
  type PreResolutionObservationRef,
  type RebalancePlan,
} from "./rebalance-plan";
import {
  cashOf,
  holdingsCaptureSequence,
  holdingsOf,
  normalizeHoldings,
  type Capture,
  type NormalizedHoldings,
} from "./settlement-observation";
import { capabilitiesOf } from "./source-registry";

/** 추정 결제일 뒤로 더 기다려 주는 **평일** 수. 공휴일 미반영(D4). */
export const WEEKDAY_GRACE_DAYS = 5;

// ── 날짜 산술 (UTC 고정 — 로컬 타임존이 하루를 밀지 않게) ──────────────────

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/** 토·일을 건너뛰며 평일 n 일을 더한다. **공휴일은 모른다.** */
export function addWeekdays(date: string, n: number): string {
  let ms = toUtc(date);
  let left = n;
  while (left > 0) {
    ms += DAY;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return fromUtc(ms);
}

/** 거래일에서 평일 2일 뒤. 결제일의 **추정**이며 사실이 아니다. */
export function tplus2Weekday(tradeDate: string): string {
  return addWeekdays(tradeDate, 2);
}

// ── 1. discovery window (plan 만으로) ─────────────────────────────────────

export interface DiscoveryWindow {
  from: string;
  to: string;
  /** 항상 weekday_inferred 다 — 이 window 는 사실이 아니라 탐색 범위다 */
  basis: "weekday_inferred";
}

/**
 * 후보 이벤트를 찾을 범위. **plan 만 본다** — 이벤트도 결제일도 쓰지 않는다.
 * 이것은 settlement fact 가 아니라 discovery horizon 이다.
 */
export function discoveryWindow(plan: Pick<RebalancePlan, "planDate">): DiscoveryWindow {
  return {
    from: plan.planDate,
    to: addWeekdays(tplus2Weekday(plan.planDate), WEEKDAY_GRACE_DAYS),
    basis: "weekday_inferred",
  };
}

// ── 2. 후보 이벤트 (attribution gate) ─────────────────────────────────────

export interface ReconcileTransactionInput {
  /** kaw_transaction_ledger.source */
  source: string;
  ticker: string;
  side: "buy" | "sell";
  /** 유효 수량 (correction overlay 적용 후) */
  quantity: number;
  /** 증권사가 보고한 결제일. 없으면 null — 추정값을 넣지 않는다 */
  settlementDate: string | null;
}

export interface ReconcileEventInput {
  id: string;
  accountType: AccountId;
  eventDate: string;
  transactions: ReconcileTransactionInput[];
}

export interface UnattributedEvent {
  eventId: string;
  attribution: LedgerAttribution;
}

export interface CandidateEvents {
  /** 자동 후보. attribution 이 resolved 이고 plan 과 같은 instance 인 것만 */
  candidates: ReconcileEventInput[];
  /**
   * 날짜 범위에는 들어오지만 귀속이 확정되지 않은 이벤트. **자동 연결하지 않고
   * 보고만 한다** — account_type 만으로 붙이는 경로를 만들지 않는다.
   */
  unattributed: UnattributedEvent[];
  /** 귀속은 됐지만 다른 instance 의 것 */
  otherInstance: UnattributedEvent[];
}

/**
 * discovery window 안에서 plan 에 붙일 후보 이벤트를 찾는다.
 *
 * 원장에는 broker account instance 컬럼이 없고 immutable 이라 추가할 수도 없다.
 * 그래서 `source` + `account_type` + `event_date` + 계좌 레지스트리 active 기간으로
 * **파생**한 attribution 이 resolved 일 때만 후보가 된다.
 */
export function candidateEventIds(
  plan: Pick<RebalancePlan, "planDate" | "accountType" | "accountInstanceId">,
  window: DiscoveryWindow,
  events: readonly ReconcileEventInput[],
  brokerAccounts: readonly BrokerAccountInstance[],
  overlays: Readonly<Record<string, { accountInstanceId: string }>> = {},
): CandidateEvents {
  const candidates: ReconcileEventInput[] = [];
  const unattributed: UnattributedEvent[] = [];
  const otherInstance: UnattributedEvent[] = [];

  for (const e of events) {
    if (e.accountType !== plan.accountType) continue;
    if (e.eventDate < window.from || e.eventDate > window.to) continue;

    const records: AttributableRecord[] = e.transactions.map((t) => ({
      accountType: e.accountType,
      eventDate: e.eventDate,
      source: t.source,
    }));
    const attribution = resolveEventAttribution(records, brokerAccounts, overlays[e.id] ?? null);

    if (attribution.kind !== "resolved") {
      unattributed.push({ eventId: e.id, attribution });
      continue;
    }
    if (attribution.accountInstanceId !== plan.accountInstanceId) {
      otherInstance.push({ eventId: e.id, attribution });
      continue;
    }
    candidates.push(e);
  }

  candidates.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id));
  return { candidates, unattributed, otherInstance };
}

/** 여러 이벤트의 수량 변화를 ticker 로 합산. 변화 0 인 ticker 는 빼고 돌려준다. */
export function aggregateLedgerDelta(
  events: readonly ReconcileEventInput[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    for (const t of e.transactions) {
      const signed = t.side === "buy" ? t.quantity : -t.quantity;
      out[t.ticker] = (out[t.ticker] ?? 0) + signed;
    }
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

// ── 3. settlement evidence (확정된 후보에서만) ────────────────────────────

export interface SettlementEvidence {
  /** 증권사가 보고한 결제일 전체 (오름차순, 중복 제거) */
  reportedSettlementDates: string[];
  window: { from: string; to: string; basis: "reported" | "weekday_inferred" };
}

/**
 * 판정에 쓸 window. **후보가 확정된 뒤에** 부른다.
 *
 * 보고된 결제일이 하나라도 있으면 그것이 사실이므로 window 가 정확해지고, 그때만
 * `state_mismatch` 승격(M1)이 가능해진다. 없으면 discovery window 를 그대로 쓰되
 * basis 를 `weekday_inferred` 로 유지해 경고 전용임을 드러낸다.
 */
export function settlementEvidence(
  linkedEvents: readonly ReconcileEventInput[],
  discovery: DiscoveryWindow,
): SettlementEvidence {
  const dates = [
    ...new Set(
      linkedEvents.flatMap((e) =>
        e.transactions.map((t) => t.settlementDate).filter((d): d is string => !!d),
      ),
    ),
  ].sort();
  if (!dates.length) {
    return {
      reportedSettlementDates: [],
      window: { from: discovery.from, to: discovery.to, basis: "weekday_inferred" },
    };
  }
  return {
    reportedSettlementDates: dates,
    window: { from: dates[0], to: dates[dates.length - 1], basis: "reported" },
  };
}

// ── 축 1: execution evidence ──────────────────────────────────────────────

export type ExecutionEvidence =
  | "none"
  | "partial"
  | "complete"
  | "conflicting"
  /** PRE 를 모르면 기대값이 없다 — 역산하지 않고 판정을 포기한다 */
  | "indeterminate";

function sameDelta(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

/** ledger 가 expected 의 **같은 방향 부분집합**인가 (잔량 체결 중). */
function isSameDirectionSubset(
  ledger: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  for (const [ticker, got] of Object.entries(ledger)) {
    const want = expected[ticker];
    if (want === undefined) return false;
    if (Math.sign(got) !== Math.sign(want)) return false;
    if (Math.abs(got) > Math.abs(want)) return false;
  }
  return true;
}

export function classifyExecutionEvidence(
  expectedDelta: Record<string, number> | null,
  ledgerDelta: Record<string, number>,
  hasLinkedEvents: boolean,
): ExecutionEvidence {
  if (expectedDelta === null) return "indeterminate";
  if (!hasLinkedEvents) return "none";
  if (sameDelta(expectedDelta, ledgerDelta)) return "complete";
  if (isSameDirectionSubset(ledgerDelta, expectedDelta)) return "partial";
  return "conflicting";
}

// ── 축 2: settlement check ────────────────────────────────────────────────

export type CaptureClassKind = "pre" | "planned" | "other";

export interface ClassifiedCapture {
  captureId: string;
  stateAsOf: string;
  observedAt: string;
  kind: CaptureClassKind;
  normalized: NormalizedHoldings;
  cash: number | null;
  sourceType: string;
}

export type SettlementCheck =
  | "unobserved"
  | "pre_state_observed"
  | "intermediate_state_observed"
  | "post_state_verified"
  | "post_state_cash_divergent"
  | "settlement_overdue"
  | "state_mismatch";

/** 중간 상태가 원장 증거로 설명되는가. */
export type IntermediateDetail = "intermediate_consistent" | "intermediate_unexplained";

export type MismatchTrigger = "M1_reported_window_elapsed" | "M2_conflicting_execution" | "M3_direction_reversed";

export type ReconcileWarning =
  | "ambiguous_event_attribution"
  | "capture_internal_conflict"
  | "same_day_holdings_conflict"
  | "credential_drift_suspected"
  | "unattributed_candidate_events"
  | "non_comparable_holdings";

export type Comparability = "full" | "partial";

export interface ReconcileClosure {
  closure: "evidence_unavailable" | "superseded" | "not_executed";
  reason: string;
}

export interface ReconcileInput {
  plan: RebalancePlan;
  events: readonly ReconcileEventInput[];
  captures: readonly Capture[];
  brokerAccounts: readonly BrokerAccountInstance[];
  today: string;
  /** migration 006+ 의 명시적 plan↔event 귀속 (include/exclude) */
  eventLinks?: { include?: readonly string[]; exclude?: readonly string[] };
  /** 원장 이벤트의 명시적 instance 귀속 overlay (006+) */
  attributionOverlays?: Readonly<Record<string, { accountInstanceId: string }>>;
  /** PRE 를 historical observation 으로 보강하는 overlay (006+) */
  preResolution?: PlanPreResolution | null;
  preResolutionObservation?: PreResolutionObservationRef | null;
  closure?: ReconcileClosure | null;
}

export interface ReconcileResult {
  planId: string;
  effectivePreBasis: EffectivePreBasis;

  executionEvidence: ExecutionEvidence;
  settlementCheck: SettlementCheck;
  intermediateDetail: IntermediateDetail | null;
  mismatchTriggers: MismatchTrigger[];
  closure: ReconcileClosure | null;

  expectedDeltaByTicker: Record<string, number> | null;
  ledgerDeltaByTicker: Record<string, number>;
  remainingDeltaByTicker: Record<string, number> | null;

  /** 관측 cash − plan 주장 cash. 비교 불가면 null. **장부에 넣지 않는다** */
  cashDivergence: number | null;
  /** 전이가 일어난 구간 (하한 배타, 상한 포함). 단일 날짜로 축약하지 않는다 */
  observedTransitionWindow: { after: string; atOrBefore: string } | null;

  discoveryWindow: DiscoveryWindow;
  settlementWindow: SettlementEvidence["window"];
  reportedSettlementDates: string[];

  linkedEventIds: string[];
  unattributedCandidates: UnattributedEvent[];
  crossInstanceCaptures: Array<{ captureId: string; match: InstanceMatch }>;

  comparability: Comparability;
  unmappableRows: Array<{ rowId: string; etfName: string; quantity: number }>;
  nonComparableTickers: string[];
  extraneousPositions: Array<{ ticker: string; quantity: number }>;
  classifiedCaptures: ClassifiedCapture[];
  warnings: ReconcileWarning[];
}

/** plan 이 다루는 ticker 집합 (비교의 universe). */
export function planUniverse(plan: Pick<RebalancePlan, "rowMeta">): string[] {
  return [
    ...new Set(
      Object.values(plan.rowMeta)
        .map((m) => m.ticker)
        .filter((t): t is string => !!t),
    ),
  ].sort();
}

function mapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

function addDelta(
  base: Record<string, number>,
  delta: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [k, v] of Object.entries(delta)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/**
 * plan 1건의 reconciliation. **서버 I/O 없음.**
 *
 * 입력이 같으면 출력이 같고, 원장 행이 나중에 들어오면 같은 입력으로 상태가 저절로
 * 올라간다 — backfill 이 필요 없는 이유다.
 */
export function reconcilePlan(input: ReconcileInput): ReconcileResult {
  const { plan, captures, brokerAccounts, today } = input;
  const warnings = new Set<ReconcileWarning>();

  // ── PRE / 기대값 ────────────────────────────────────────────────────────
  const preBasis = effectivePreBasis(plan, input.preResolution, input.preResolutionObservation);
  const planned = aggregateByTicker(plan.plannedQuantities, plan.rowMeta);
  const pre = plan.preQuantities ? aggregateByTicker(plan.preQuantities, plan.rowMeta) : null;
  const preByTicker = preBasis === "unknown" ? null : (pre?.byTicker ?? null);
  const expectedDelta = expectedDeltaByTicker(preByTicker, planned.byTicker);

  const unmappableRows = [
    ...planned.unmappable,
    ...(pre?.unmappable ?? []).filter(
      (r) => !planned.unmappable.some((p) => p.rowId === r.rowId),
    ),
  ];

  // ── 후보 이벤트 (discovery → attribution gate) ─────────────────────────
  const discovery = discoveryWindow(plan);
  const found = candidateEventIds(
    plan,
    discovery,
    input.events,
    brokerAccounts,
    input.attributionOverlays ?? {},
  );
  const excluded = new Set(input.eventLinks?.exclude ?? []);
  const includeIds = new Set(input.eventLinks?.include ?? []);
  const linked = [
    ...found.candidates.filter((e) => !excluded.has(e.id)),
    ...input.events.filter((e) => includeIds.has(e.id) && !found.candidates.some((c) => c.id === e.id)),
  ].sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id));

  if (found.unattributed.length) warnings.add("unattributed_candidate_events");
  if (found.unattributed.some((u) => u.attribution.kind === "ambiguous")) {
    warnings.add("ambiguous_event_attribution");
  }

  const ledgerDelta = aggregateLedgerDelta(linked);
  const executionEvidence = classifyExecutionEvidence(expectedDelta, ledgerDelta, linked.length > 0);
  const remainingDelta =
    expectedDelta === null
      ? null
      : Object.fromEntries(
          Object.entries(addDelta(expectedDelta, invert(ledgerDelta))).filter(([, v]) => v !== 0),
        );

  // ── settlement evidence (후보 확정 **뒤에**) ───────────────────────────
  const evidence = settlementEvidence(linked, discovery);

  // ── capture 분류 ───────────────────────────────────────────────────────
  const universe = planUniverse(plan);
  const crossInstanceCaptures: Array<{ captureId: string; match: InstanceMatch }> = [];
  const usable: Capture[] = [];

  for (const c of captures) {
    if (c.accountType !== plan.accountType) continue;
    if (c.stateAsOf < plan.planDate) continue;
    const match = sameInstance(
      { accountInstanceId: plan.accountInstanceId, accountRefFingerprint: plan.accountRefFingerprint },
      { accountInstanceId: c.accountInstanceId, accountRefFingerprint: c.accountRefFingerprint },
    );
    if (match.kind !== "same") {
      crossInstanceCaptures.push({ captureId: c.captureId, match });
      if (match.kind === "credential_drift_suspected") warnings.add("credential_drift_suspected");
      continue;
    }
    const h = holdingsOf(c);
    if (h.kind === "conflict" || cashOf(c).kind === "conflict") {
      warnings.add("capture_internal_conflict");
      continue;
    }
    if (h.kind !== "value") continue;
    // 거래기준 화면은 전이 판정에 쓰지 않는다.
    const part = c.parts.find((p) => p.sourceType === h.sourceType);
    if (part?.settlementBasis === "trade") continue;
    if (!capabilitiesOf(h.sourceType).autoReconcile) continue;
    usable.push(c);
  }

  const classified: ClassifiedCapture[] = [];
  const nonComparableTickers = new Set<string>();
  const extraneous = new Map<string, number>();

  for (const c of holdingsCaptureSequence(usable)) {
    const h = holdingsOf(c);
    if (h.kind !== "value") continue;
    const part = c.parts.find((p) => p.sourceType === h.sourceType)!;
    const normalized = normalizeHoldings(
      h.value,
      universe,
      h.sourceType,
      part.holdingsCompleteness,
    );
    for (const t of normalized.nonComparable) nonComparableTickers.add(t);
    for (const e of normalized.extraneous) extraneous.set(e.ticker, e.quantity);
    // 비교 불가 ticker 가 있으면 그 capture 로는 상태를 단정하지 않는다.
    if (normalized.nonComparable.length) {
      warnings.add("non_comparable_holdings");
      continue;
    }
    const cash = cashOf(c);
    const isPre = preByTicker !== null && mapsEqual(normalized.byTicker, restrict(preByTicker, universe));
    const isPlanned = mapsEqual(normalized.byTicker, restrict(planned.byTicker, universe));
    classified.push({
      captureId: c.captureId,
      stateAsOf: c.stateAsOf,
      observedAt: c.observedAt,
      // PRE 와 PLANNED 가 같은 plan(delta 0)이면 planned 로 본다 — 전이가 없다.
      kind: isPlanned ? "planned" : isPre ? "pre" : "other",
      normalized,
      cash: cash.kind === "value" ? cash.value : null,
      sourceType: h.sourceType,
    });
  }

  // 같은 state_as_of 에 서로 다른 holdings → 조용히 고르지 않고 드러낸다.
  const byDate = new Map<string, string[]>();
  for (const c of classified) {
    const sig = JSON.stringify(c.normalized.byTicker);
    const list = byDate.get(c.stateAsOf);
    if (list) {
      if (!list.includes(sig)) {
        list.push(sig);
        warnings.add("same_day_holdings_conflict");
      }
    } else byDate.set(c.stateAsOf, [sig]);
  }

  // ── 상태 판정 ──────────────────────────────────────────────────────────
  const lastPreIdx = findLastIndex(classified, (c) => c.kind === "pre");
  const postIdx = classified.findIndex((c, i) => c.kind === "planned" && i > lastPreIdx);
  const latest = classified.length ? classified[classified.length - 1] : null;
  const windowClosed = today > evidence.window.to;

  let settlementCheck: SettlementCheck = "unobserved";
  let intermediateDetail: IntermediateDetail | null = null;
  let cashDivergence: number | null = null;
  let observedTransitionWindow: ReconcileResult["observedTransitionWindow"] = null;
  const mismatchTriggers: MismatchTrigger[] = [];

  if (!classified.length) {
    settlementCheck = "unobserved";
  } else if (postIdx >= 0) {
    const post = classified[postIdx];
    observedTransitionWindow = {
      // PRE 관측이 없으면 하한이 plan_date 다 — **약한 하한임을 그대로 드러낸다**
      after: lastPreIdx >= 0 ? classified[lastPreIdx].stateAsOf : plan.planDate,
      atOrBefore: post.stateAsOf,
    };
    // cash 는 **POST 를 성립시킨 그 capture 에서만** 읽는다. 다른 capture 의 cash 를
    // 끌어오지 않는다 — 그게 holdings/cash 오짝의 유일한 경로다.
    if (post.cash === null) {
      settlementCheck = "post_state_verified";
    } else {
      cashDivergence = post.cash - plan.assertedPostCash;
      settlementCheck = cashDivergence === 0 ? "post_state_verified" : "post_state_cash_divergent";
    }
  } else if (latest) {
    const explained =
      preByTicker !== null &&
      mapsEqual(latest.normalized.byTicker, restrict(addDelta(preByTicker, ledgerDelta), universe));
    const reversed =
      expectedDelta !== null &&
      preByTicker !== null &&
      hasReversedDirection(latest.normalized.byTicker, preByTicker, expectedDelta);

    if (evidence.window.basis === "reported" && windowClosed) {
      mismatchTriggers.push("M1_reported_window_elapsed");
    }
    if (executionEvidence === "conflicting") mismatchTriggers.push("M2_conflicting_execution");
    if (latest.kind === "other" && !explained && reversed) {
      mismatchTriggers.push("M3_direction_reversed");
    }

    if (mismatchTriggers.length) {
      settlementCheck = "state_mismatch";
    } else if (latest.kind === "pre") {
      settlementCheck = windowClosed ? "settlement_overdue" : "pre_state_observed";
    } else {
      // kind === "other" — 부분체결·복수 거래일 실행에서 **정상**일 수 있다
      settlementCheck = windowClosed ? "settlement_overdue" : "intermediate_state_observed";
      intermediateDetail = explained ? "intermediate_consistent" : "intermediate_unexplained";
    }
  }

  const comparability: Comparability =
    unmappableRows.length || nonComparableTickers.size ? "partial" : "full";

  return {
    planId: plan.id,
    effectivePreBasis: preBasis,
    executionEvidence,
    settlementCheck,
    intermediateDetail,
    mismatchTriggers,
    closure: input.closure ?? null,
    expectedDeltaByTicker: expectedDelta,
    ledgerDeltaByTicker: ledgerDelta,
    remainingDeltaByTicker: remainingDelta,
    cashDivergence,
    observedTransitionWindow,
    discoveryWindow: discovery,
    settlementWindow: evidence.window,
    reportedSettlementDates: evidence.reportedSettlementDates,
    linkedEventIds: linked.map((e) => e.id),
    unattributedCandidates: found.unattributed,
    crossInstanceCaptures,
    comparability,
    unmappableRows,
    nonComparableTickers: [...nonComparableTickers].sort(),
    extraneousPositions: [...extraneous.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, quantity]) => ({ ticker, quantity })),
    classifiedCaptures: classified,
    warnings: [...warnings].sort(),
  };
}

// ── 보조 ───────────────────────────────────────────────────────────────────

function invert(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = -v;
  return out;
}

function restrict(m: Record<string, number>, universe: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of universe) out[t] = m[t] ?? 0;
  return out;
}

/** 기대 방향과 **반대로** 움직인 ticker 가 있는가 (중간 상태로 설명 불가). */
function hasReversedDirection(
  observed: Record<string, number>,
  pre: Record<string, number>,
  expectedDelta: Record<string, number>,
): boolean {
  for (const [ticker, want] of Object.entries(expectedDelta)) {
    const moved = (observed[ticker] ?? 0) - (pre[ticker] ?? 0);
    if (moved !== 0 && Math.sign(moved) !== Math.sign(want)) return true;
  }
  return false;
}

function findLastIndex<T>(list: readonly T[], pred: (v: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}
