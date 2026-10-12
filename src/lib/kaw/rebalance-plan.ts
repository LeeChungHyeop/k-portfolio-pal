// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 계획(RebalancePlan) — 순수 모듈
//
// ## Plan 과 Actual Execution 은 절대 같은 것이 아니다
//
// 이 모듈이 다루는 것은 **사용자가 무엇을 하려 했고 무엇을 했다고 주장하는가** 뿐이다.
// 실제 체결 증거는 `kaw_transaction_ledger` 에만 있고, 이 모듈의 어떤 값으로도
// 거래를 합성하지 않는다. `targetWeights` 는 intention data 로 보존하되
// **ledger 행을 만드는 근거로 쓰는 코드 경로를 만들지 않는다**
// (migration 004 주석 / docs/mirae-export-recollection.md §9-6).
//
// ## PRE 는 역산하지 않는다
//
// 저장 시점의 `AccountState.liveQuantities` 는 PRE 가 **아니다** — 수량 편집 1초 뒤
// 디바운스가 planned 값으로 덮어쓴다(AccountPage.tsx:288-293 → store.ts:938).
// 예수금은 디바운스도 없이 키 입력마다 덮인다(AccountPage.tsx:845).
// 그래서 PRE 는 **첫 변경 직전에 캡처한 세션 snapshot** 만 근거로 쓴다.
// history 역산도, target delta 역산도 하지 않는다.
//
// ## 과거 날짜는 fail closed
//
// 과거 모드에서는 historical PRE 를 줄 수 있는 소스가 코드에 하나도 없다
// (quantities·cashBalance 는 현재값, rowHoldings 는 직전 리밸런싱 평가금액,
//  historyPrices 는 가격만). 그래서 `pre_basis = 'unknown'` 으로 떨어뜨린다.
// 세션을 먼저 캡처한 뒤 날짜를 과거로 바꾸는 경로까지 막는다.
//
// ## 비교는 ticker 공간에서 한다
//
// rowId 는 투자성향별 집합이라 성향을 바꾸면 통째로 교체되고, 같은 ticker 가 여러 row
// 에 존재할 수 있다(행 삭제 후 같은 자산 재추가 → orphan + 신규 행). 그래서 plan 은
// row 별 ticker 를 freeze 하고, 모든 비교·해시는 ticker 로 집계한 뒤에 한다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";

// ── 공용 정규화 / 지문 ──────────────────────────────────────────────────────
//
// 이 두 함수는 settlement-observation.ts 도 함께 쓴다. 암호학적 해시가 아니다 —
// 용도는 **한 profile 안에서의 중복 탐지와 결정적 id 생성**이고 보안 경계가 아니다
// (계좌 참조 지문 account_ref_fingerprint 는 서버에서 HMAC 으로 따로 계산한다).

/** 수를 결정적 문자열로. -0 과 0 을 같게 만들고 불필요한 소수점을 없앤다. */
function numToken(n: number): string {
  if (!Number.isFinite(n)) return "NaN";
  const v = n === 0 ? 0 : n; // -0 → 0
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8)));
}

/**
 * 키 정렬된 결정적 JSON. `undefined` 와 `null` 을 **다르게** 표현한다 —
 * "값이 없다"와 "모른다"를 뭉개면 004 의 null 정책이 깨진다.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "~u";
  if (value === null) return "~n";
  if (typeof value === "number") return numToken(value);
  if (typeof value === "boolean") return value ? "~t" : "~f";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  return "~x";
}

/**
 * 결정적 16진 지문 (32자). FNV-1a 를 서로 다른 offset basis 4개로 돌려 이어붙인다.
 * 의존성이 없어 node / 브라우저 / Workers 어디서나 같은 값이 나온다.
 */
export function stableDigest(input: string): string {
  const bases = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9];
  let out = "";
  for (const base of bases) {
    let h = base >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

// ── 타입 ────────────────────────────────────────────────────────────────────

/** 행별로 freeze 하는 메타. **ticker 가 비교의 유일한 식별자다.** */
export interface PlanRowMeta {
  assetId: string;
  etfName: string;
  label: string;
  /** 종목코드. 라이브러리에 없으면 null — 빈 문자열로 두지 않는다 */
  ticker: string | null;
  /** 투자성향에서 지워졌지만 보유가 남아 있는 행 */
  orphaned: boolean;
}

/** 계산에 쓴 가격의 행별 근거. 전역 1개로 뭉개면 혼재 사실이 사라진다. */
export interface PlanPriceEvidence {
  ticker: string | null;
  /** 가격을 못 받았으면 **null**. 0 을 가격으로 기록하지 않는다 */
  price: number | null;
  source: "kis-live" | "naver-live-fallback" | "naver-history" | "unavailable" | "manual";
  /** 그 가격의 기준 시각/날짜. 주말이면 plan_date 와 다를 수 있다 */
  asOf: string | null;
}

export type PlanDateMode = "today" | "past" | "future";

/** DB 에 저장하는 PRE 근거. 005 는 2값만 쓴다. */
export type StoredPreBasis = "session_snapshot" | "unknown";

/** 파생 PRE 근거. broker_snapshot 은 **overlay 가 있을 때만** 나온다(006+). */
export type EffectivePreBasis = StoredPreBasis | "broker_snapshot";

export type PreDiscardReason =
  | "no_session"
  | "past_date_mode"
  | "date_mode_changed"
  | "instance_changed";

/**
 * 편집 세션의 PRE snapshot. `rebalance-journal.ts` 가 영속화한다.
 * 첫 변경 직전에 1회 고정되고 그 뒤로 **불변**이다.
 */
export interface RebalanceSessionSnapshot {
  sessionId: string;
  accountType: AccountId;
  accountInstanceId: string;
  startedAt: string;
  trigger: "quantity" | "cash" | "row";
  preDateMode: PlanDateMode;
  /** rowId → 수량 */
  preQuantities: Record<string, number>;
  /** 세션 시작 시점 예수금. **undefined = 당시 미입력**(0 과 다르다) */
  preCash?: number;
  preRowMeta: Record<string, PlanRowMeta>;
  preProfileKey: string;
}

/** `kaw_rebalance_plan` 1행에 대응하는 도메인 타입. 저장 후 **불변**이다. */
export interface RebalancePlan {
  id: string;
  completionId: string;

  accountType: AccountId;
  broker: string;
  brokerProductCode?: string | null;
  accountInstanceId: string;
  accountRefFingerprint?: string | null;

  planDate: string;
  recordedAt: string;
  dateMode: Exclude<PlanDateMode, "future">;

  preBasis: StoredPreBasis;
  preSessionId?: string | null;
  preSessionStartedAt?: string | null;
  preProfileKey?: string | null;
  /** pre_basis 가 unknown 이면 **null**. 역산으로 채우지 않는다 */
  preQuantities: Record<string, number> | null;
  preCash: number | null;
  /** 완료 시점의 account.cashBalance. 세션 시작값과 다르면 그 사실을 드러낸다 */
  preCashAtRecord: number | null;
  preDiscardReason?: PreDiscardReason | null;

  /** 완료 시점 앱 상태. **PRE 가 아니다** — 포렌식 전용 */
  appStateQuantitiesAtRecord?: Record<string, number> | null;
  appStateCashAtRecord?: number | null;

  plannedQuantities: Record<string, number>;
  assertedPostCash: number;
  projectedPostCash?: number | null;

  /** intention data. ledger 생성 근거로 쓰지 않는다 */
  targetWeights?: Record<string, number> | null;
  frozenInvested?: number | null;
  frozenInvestedBasis?: "entry_freeze" | "remount_refreeze" | "manual" | "unknown" | null;
  baseAmount?: number | null;

  rowMeta: Record<string, PlanRowMeta>;
  priceMode: "live" | "history" | "manual";
  priceEvidence: Record<string, PlanPriceEvidence>;

  planPayloadHash: string;
  hashVersion: number;
  actor: string;
}

// ── PRE 근거 판정 ───────────────────────────────────────────────────────────

export interface ResolvedPre {
  preBasis: StoredPreBasis;
  preQuantities: Record<string, number> | null;
  preCash: number | null;
  preDiscardReason: PreDiscardReason | null;
}

/**
 * 완료 시점의 `dateMode` 로 PRE 근거를 정한다.
 *
 * `session_snapshot` 이 되는 조건은 **전부 충족**해야 한다:
 *   · 완료 시점 dateMode === 'today'
 *   · 세션이 있다
 *   · 세션 캡처 당시 dateMode 도 'today' 였다   ← 캡처 후 과거로 바꾼 경로를 막는다
 *   · 세션의 instance 가 완료 시점 instance 와 같다
 *
 * 하나라도 어긋나면 `unknown` + 사유다. **세션 값을 PRE 로 쓰지 않는다.**
 */
export function resolvePreBasis(
  session: RebalanceSessionSnapshot | null | undefined,
  dateMode: PlanDateMode,
  accountInstanceId?: string,
): ResolvedPre {
  const discard = (preDiscardReason: PreDiscardReason): ResolvedPre => ({
    preBasis: "unknown",
    preQuantities: null,
    preCash: null,
    preDiscardReason,
  });

  if (!session) return discard("no_session");
  if (dateMode !== "today") return discard("past_date_mode");
  if (session.preDateMode !== "today") return discard("date_mode_changed");
  if (accountInstanceId !== undefined && session.accountInstanceId !== accountInstanceId) {
    return discard("instance_changed");
  }
  return {
    preBasis: "session_snapshot",
    preQuantities: { ...session.preQuantities },
    preCash: session.preCash ?? null,
    preDiscardReason: null,
  };
}

/** migration 006+ 의 historical PRE overlay. plan 행은 수정하지 않는다. */
export interface PlanPreResolution {
  planId: string;
  preSourceObservationId: string;
  reason: string;
}

/** overlay 가 유효한지 판정할 때 쓰는 최소 관측 정보. */
export interface PreResolutionObservationRef {
  id: string;
  accountInstanceId: string;
  stateAsOf: string;
  hasHoldings: boolean;
  voided: boolean;
}

/**
 * 유효 PRE 근거. **immutable plan 행의 preBasis 를 수정하지 않고 파생한다.**
 *
 * overlay 가 유효한 조건: 같은 instance / state_as_of === plan_date /
 * holdings 가 있다 / void 되지 않았다. 하나라도 어긋나면 unknown 을 유지한다.
 */
export function effectivePreBasis(
  plan: Pick<RebalancePlan, "preBasis" | "planDate" | "accountInstanceId">,
  preResolution?: PlanPreResolution | null,
  observation?: PreResolutionObservationRef | null,
): EffectivePreBasis {
  if (plan.preBasis === "session_snapshot") return "session_snapshot";
  if (!preResolution || !observation) return "unknown";
  if (observation.id !== preResolution.preSourceObservationId) return "unknown";
  if (observation.voided) return "unknown";
  if (!observation.hasHoldings) return "unknown";
  if (observation.accountInstanceId !== plan.accountInstanceId) return "unknown";
  if (observation.stateAsOf !== plan.planDate) return "unknown";
  return "broker_snapshot";
}

// ── ticker 공간 집계 ────────────────────────────────────────────────────────

export interface UnmappableRow {
  rowId: string;
  etfName: string;
  quantity: number;
}

export interface TickerAggregate {
  /** ticker → 수량 합. 같은 ticker 의 여러 row 가 합쳐진다 */
  byTicker: Record<string, number>;
  /** ticker 를 모르는 행 중 **수량이 0 이 아닌** 것. 0 으로 채우지 않는다 */
  unmappable: UnmappableRow[];
}

/**
 * rowId 기반 수량을 ticker 기반으로 집계한다.
 *
 * 같은 ticker 가 여러 row 에 있을 수 있다(orphan 행 + 재추가 행). 수량 0 인 ticker
 * 항목도 **남긴다** — 전량매도(planned 0)를 검증하려면 그 키가 있어야 한다.
 */
export function aggregateByTicker(
  quantities: Record<string, number>,
  rowMeta: Record<string, PlanRowMeta>,
): TickerAggregate {
  const byTicker: Record<string, number> = {};
  const unmappable: UnmappableRow[] = [];
  for (const rowId of Object.keys(quantities).sort()) {
    const qty = quantities[rowId] ?? 0;
    const meta = rowMeta[rowId];
    const ticker = meta?.ticker ?? null;
    if (!ticker) {
      if (qty !== 0) unmappable.push({ rowId, etfName: meta?.etfName ?? rowId, quantity: qty });
      continue;
    }
    byTicker[ticker] = (byTicker[ticker] ?? 0) + qty;
  }
  unmappable.sort((a, b) => a.etfName.localeCompare(b.etfName) || a.rowId.localeCompare(b.rowId));
  return { byTicker, unmappable };
}

/**
 * 기대 수량 변화 = planned − pre (ticker 공간).
 *
 * **DB 컬럼으로 저장하지 않는다.** 변화가 0 인 ticker 는 결과에서 빼는데, 매매가
 * 일어나지 않을 종목을 기대값에 넣으면 비교가 거짓 불일치를 만든다.
 * PRE 를 모르면 null — 역산하지 않는다.
 */
export function expectedDeltaByTicker(
  preByTicker: Record<string, number> | null,
  plannedByTicker: Record<string, number>,
): Record<string, number> | null {
  if (!preByTicker) return null;
  const out: Record<string, number> = {};
  for (const ticker of new Set([...Object.keys(preByTicker), ...Object.keys(plannedByTicker)])) {
    const delta = (plannedByTicker[ticker] ?? 0) - (preByTicker[ticker] ?? 0);
    if (delta !== 0) out[ticker] = delta;
  }
  return out;
}

// ── canonical payload / 중복 탐지 해시 ─────────────────────────────────────

export const PLAN_HASH_VERSION = 1;

export interface CanonicalPlanPayload {
  accountInstanceId: string;
  planDate: string;
  preBasis: StoredPreBasis;
  preByTicker: Record<string, number> | null;
  preCash: number | null;
  plannedByTicker: Record<string, number>;
  assertedPostCash: number;
  targetWeightsByTicker: Record<string, number> | null;
  unmappableRows: Array<{ etfName: string; quantity: number }>;
  /** ticker → 정렬된 distinct 가격. 빈 배열 = 가격 없음, 2개 이상 = 행간 불일치 */
  priceByTicker: Record<string, number[]>;
}

/**
 * 중복 탐지용 canonical payload.
 *
 * **들어가는 것은 경제적/의도적 값뿐이다.** identity(id / completionId / sessionId)와
 * volatile(recordedAt / actor / retry)·파생(frozenInvested / baseAmount /
 * projectedPostCash)·provenance(priceEvidence 의 source·asOf / broker 라벨)는 빼야
 * 한다. 그래야
 *
 *   같은 completion retry           → 같은 id + 같은 hash
 *   다른 completion, 경제값 동일     → 다른 id + **같은 hash**  (재기록 탐지)
 *
 * 가 성립한다. `dateMode` / `priceMode` 도 뺀다 — 같은 리밸런싱을 며칠 뒤 다시
 * 기록하면 값이 달라져 탐지가 깨진다(가격 차이는 priceByTicker 에 이미 반영된다).
 * rowId 는 쓰지 않는다 — 투자성향 변경으로 바뀌므로 ticker 공간으로 정규화한다.
 */
export function canonicalPlanPayload(
  plan: Pick<
    RebalancePlan,
    | "accountInstanceId"
    | "planDate"
    | "preBasis"
    | "preQuantities"
    | "preCash"
    | "plannedQuantities"
    | "assertedPostCash"
    | "targetWeights"
    | "rowMeta"
    | "priceEvidence"
  >,
): CanonicalPlanPayload {
  const planned = aggregateByTicker(plan.plannedQuantities, plan.rowMeta);
  const pre = plan.preQuantities ? aggregateByTicker(plan.preQuantities, plan.rowMeta) : null;

  const targetWeightsByTicker = plan.targetWeights
    ? aggregateByTicker(plan.targetWeights, plan.rowMeta).byTicker
    : null;

  const priceByTicker: Record<string, number[]> = {};
  for (const rowId of Object.keys(plan.priceEvidence).sort()) {
    const ev = plan.priceEvidence[rowId];
    const ticker = ev?.ticker ?? plan.rowMeta[rowId]?.ticker ?? null;
    if (!ticker) continue;
    const list = (priceByTicker[ticker] ??= []);
    if (ev?.price !== null && ev?.price !== undefined && !list.includes(ev.price)) {
      list.push(ev.price);
    }
  }
  for (const list of Object.values(priceByTicker)) list.sort((a, b) => a - b);

  // unmappable 은 planned 와 pre 양쪽을 합쳐 본다 — 한쪽에만 있는 행을 놓치면
  // 서로 다른 계획이 같은 해시가 된다. rowId 는 넣지 않는다(성향 변경에 흔들린다).
  const unmappableMap = new Map<string, number>();
  for (const r of [...planned.unmappable, ...(pre?.unmappable ?? [])]) {
    unmappableMap.set(`${r.etfName}|${r.quantity}`, r.quantity);
  }
  const unmappableRows = [...unmappableMap.keys()]
    .sort()
    .map((k) => ({ etfName: k.slice(0, k.lastIndexOf("|")), quantity: unmappableMap.get(k)! }));

  return {
    accountInstanceId: plan.accountInstanceId,
    planDate: plan.planDate,
    preBasis: plan.preBasis,
    preByTicker: pre ? pre.byTicker : null,
    preCash: plan.preCash,
    plannedByTicker: planned.byTicker,
    assertedPostCash: plan.assertedPostCash,
    targetWeightsByTicker,
    unmappableRows,
    priceByTicker,
  };
}

/** `p<version>|<digest>`. 004 의 fingerprint 버전 prefix 규칙과 같은 모양이다. */
export function planPayloadHash(
  plan: Parameters<typeof canonicalPlanPayload>[0],
  version: number = PLAN_HASH_VERSION,
): string {
  return `p${version}|${stableDigest(canonicalJson(canonicalPlanPayload(plan)))}`;
}

/** 해시 문자열에서 규칙 버전을 읽는다. 모양이 아니면 null. */
export function planHashVersionOf(hash: string | undefined): number | null {
  const m = /^p(\d+)\|/.exec(hash ?? "");
  return m ? Number(m[1]) : null;
}
