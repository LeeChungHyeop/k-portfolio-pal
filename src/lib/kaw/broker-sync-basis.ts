// ─────────────────────────────────────────────────────────────────────────────
// 계좌 상태 동기화(broker_sync) — 읽기 경로용 가벼운 모듈 (Phase 4-D)
//
// 저장 모델과 "보유수량 근거" 선택 규칙만 담는다. 무거운 의존성(원장 재생 · 자금 모델)이 없어서
// 클라이언트 번들과 Worker cron(snapshot.ts)이 안전하게 가져다 쓴다. 판정(evaluate)은 broker-sync.ts.
//
// 설계 이유와 날짜 구분 규칙은 broker-sync.ts 상단 주석을 본다.
// ─────────────────────────────────────────────────────────────────────────────

export const BROKER_SYNC_VERSION = 1;

// ── 저장 모델 ───────────────────────────────────────────────────────────────

export interface BrokerSyncRecord {
  id: string;
  kind: "broker_sync";
  version: typeof BROKER_SYNC_VERSION;
  accountType: "pension";

  /** 보유수량이 효력을 갖는 날 (= 원장 마지막 거래일 = 한국투자 실제 체결일) */
  holdingsEffectiveFrom: string;
  holdingsBasis: "ledger_replay_verified_by_broker_balance";
  /** rowId → 보유수량 (`rowQuantitiesSnap` 과 같은 모양). 0주 행도 포함 */
  quantities: Record<string, number>;
  rowEtfSnap: Record<string, string>;
  rowLabelSnap: Record<string, string>;
  rowAssetSnap: Record<string, string>;
  /** rowId → 취득금액(원장 한국투자 체결 금액 합). **평가금액이 아니다** */
  rowHoldingsSnap: Record<string, number>;
  rowHoldingsBasis: "ledger_acquisition_amount";
  /** 근거: ticker → 수량 (원장 재생 == 증권사 잔고) */
  holdingsByTicker: Record<string, number>;

  /** 예수금은 **관측값**이다. 유효시점이 없다(effectiveFrom = null) */
  cash: {
    amount: number;
    basis: "broker_observation";
    source: "kis_live_read" | "stored_observation";
    stateAsOf: string;
    observedAt: string;
    /** 승인 시점 기준 같은 날(KST) 관측인가. false 면 오래된 관측이며 별도 승인을 받았다 */
    fresh: boolean;
    effectiveFrom: null;
    captureId: string | null;
  };

  approvedAt: string;
  approvedBy: string;
  staleObservationApproved: boolean;

  transfer: { toInstanceId: string; anchorDate: string; approvedAt: string; containsEstimates: boolean };
  ledger: { cutoff: string; rowCount: number; kisRowCount: number };
  principal: { amount: number };
  /** 원인 미확정 차이 — 분류하지 않는다 */
  unconfirmedDifferences: Array<{ id: string; difference: number; status: "unconfirmed" | "matches" }>;
  /** 모델상 미관측 현금수입의 '가능한 범위' 상한. 수익으로 확정하지 않는다 */
  incomeRangeUpper: { amount: number | null; meaning: "model_possible_range_not_confirmed_income" };
  /** 이 동기화 이전에 만들어진, 옛 수량 기준의 일별 스냅샷 날짜들 — 자동으로 고치거나 정상 데이터로 취급하지 않는다 */
  affectedSnapshots: { dates: string[]; reason: "computed_from_pre_transfer_holdings_and_cash"; preserved: true } | null;

  notRebalance: true;
  createsCashflow: false;
  createsTrade: false;
  changesBaseAmount: false;
  planHash: string;
}

export interface CashBalanceObservation {
  stateAsOf: string;
  observedAt: string;
  source: "kis_live_read" | "stored_observation";
  basis: "broker_observation";
  effectiveFrom: null;
  syncId: string;
}

// ── 읽기 경로: 보유수량 근거 ─────────────────────────────────────────────────

/** `snapshot.ts` 의 SnapshotHistoryLike 와 같은 모양(필요한 필드만) */
export interface HoldingsBasis {
  id: string;
  date: string;
  rowQuantitiesSnap?: Record<string, number>;
  rowEtfSnap?: Record<string, string>;
  rowLabelSnap?: Record<string, string>;
  rowAssetSnap?: Record<string, string>;
  rowHoldingsSnap?: Record<string, number>;
  /** 'history' = 일반 리밸런싱 이력, 'broker_sync' = 계좌 동기화 */
  source: "history" | "broker_sync";
}

export function asBrokerSyncs(raw: unknown): BrokerSyncRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is BrokerSyncRecord =>
    !!r && typeof r === "object" && (r as BrokerSyncRecord).kind === "broker_sync" &&
    typeof (r as BrokerSyncRecord).holdingsEffectiveFrom === "string" &&
    !!(r as BrokerSyncRecord).quantities && typeof (r as BrokerSyncRecord).quantities === "object");
}

/** 동기화 기록을 '보유수량 anchor' 모양으로 바꾼다. 리밸런싱 이력이 아니다 — 수익률·이벤트에 쓰지 않는다 */
export function syncAsHoldingsBasis(s: BrokerSyncRecord): HoldingsBasis {
  return {
    id: s.id, date: s.holdingsEffectiveFrom, source: "broker_sync",
    rowQuantitiesSnap: s.quantities, rowEtfSnap: s.rowEtfSnap, rowLabelSnap: s.rowLabelSnap,
    rowAssetSnap: s.rowAssetSnap, rowHoldingsSnap: s.rowHoldingsSnap,
  };
}

export interface HistoryLike {
  id: string; date: string;
  rowQuantitiesSnap?: Record<string, number>;
  rowEtfSnap?: Record<string, string>;
  rowLabelSnap?: Record<string, string>;
  rowAssetSnap?: Record<string, string>;
  rowHoldingsSnap?: Record<string, number>;
}

/**
 * **현재 확정 보유수량의 근거** — 마지막 리밸런싱 이력과 계좌 동기화 중 효력일이 더 늦은 쪽.
 * 같은 날이면 동기화가 이긴다(더 나중에 증권사 기준으로 확인한 값). 사용자가 동기화 뒤에 리밸런싱을 저장하면
 * 그 이력의 날짜가 더 늦으므로 자연스럽게 이력이 이긴다.
 */
export function holdingsBasisOf(account: { history?: readonly HistoryLike[]; brokerSyncs?: unknown }): HoldingsBasis | null {
  const hist = [...(account.history ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = hist.length ? hist[hist.length - 1] : null;
  const syncs = asBrokerSyncs(account.brokerSyncs).sort((a, b) => a.holdingsEffectiveFrom.localeCompare(b.holdingsEffectiveFrom));
  const sync = syncs.length ? syncs[syncs.length - 1] : null;
  const asHist = (h: HistoryLike): HoldingsBasis => ({
    id: h.id, date: String(h.date), source: "history",
    rowQuantitiesSnap: h.rowQuantitiesSnap, rowEtfSnap: h.rowEtfSnap, rowLabelSnap: h.rowLabelSnap,
    rowAssetSnap: h.rowAssetSnap, rowHoldingsSnap: h.rowHoldingsSnap,
  });
  if (last && sync) return sync.holdingsEffectiveFrom >= String(last.date) ? syncAsHoldingsBasis(sync) : asHist(last);
  if (sync) return syncAsHoldingsBasis(sync);
  return last ? asHist(last) : null;
}

/** 보유수량 anchor 목록(이력 + 동기화). 시계열(`validAnchors`) 같은 '보유수량 근거' 소비자가 쓴다 */
export function holdingsAnchorsOf<H extends HistoryLike>(
  account: { history?: readonly H[]; brokerSyncs?: unknown },
): Array<H | (HistoryLike & { deposit: number; baseAmount: number; totalValue: number; returnPct: null; holdings: never[] })> {
  const syncs = asBrokerSyncs(account.brokerSyncs).map((s) => {
    const b = syncAsHoldingsBasis(s);
    return { ...b, deposit: 0, baseAmount: 0, totalValue: 0, returnPct: null, holdings: [] as never[] };
  });
  return [...(account.history ?? []), ...syncs];
}

