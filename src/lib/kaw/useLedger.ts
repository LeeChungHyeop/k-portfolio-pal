// 거래 원장 읽기/쓰기 훅 — 거래 이력 화면 전용.
//
// 브라우저는 Supabase 에 직접 붙지 않는다. Worker 의 인증된 /api/ledger/* 만 쓴다
// (기존 /api/data · /api/snapshots 와 같은 세션 토큰 경로).
//
// 서버는 **원본 행과 overlay 만** 내려준다. 거래건수·금액·전후 보유수량 같은 파생값은
// 여기서 `resolveEvents` 로 계산한다 — 서버가 계산해 보내면 사용자가 거래를 옮기는 순간
// stale 해지기 때문이다(ledger.ts 주석 참고).
//
// 쓰기(메모/태그/숨김/병합/분리/이동/정정) 뒤에는 원장 쿼리를 무효화해 다시 읽는다.
// 낙관적 업데이트를 하지 않는다 — 이 화면은 "실제로 저장된 것"을 보여주는 것이 목적이고,
// 서버가 거절했는데 화면만 바뀐 상태가 가장 나쁘다.
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSessionToken } from "./auth";
import {
  resolveEvents,
  type EventOverride, type LedgerTransaction, type RebalanceEventRow,
  type ResolvedEvent, type TradeSide, type TransactionCorrection,
} from "./ledger";
import type { AccountId } from "./constants";

const LEDGER_KEY = ["kaw-ledger"] as const;

// ── 서버 행(snake_case) → 도메인 타입 ──────────────────────────────────────

interface ServerTx {
  id: string; account_type: string; ticker: string; etf_name: string;
  side: string; quantity: number | string; price: number | string; amount: number | string;
  trade_date: string | null; settlement_date: string | null; inferred_trade_date: string | null;
  event_date: string; trade_date_evidence: string;
  fee: number | string | null; tax: number | string | null; post_quantity: number | string | null;
  source: string; source_file: string | null; source_row: number | null;
  source_fingerprint: string; fingerprint_version: number | null;
  import_batch_id: string | null;
}

const num = (v: number | string | null | undefined): number =>
  typeof v === "number" ? v : Number(v) || 0;
const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function toTransaction(r: ServerTx): LedgerTransaction {
  return {
    id: r.id,
    accountId: r.account_type as AccountId,
    ticker: r.ticker,
    etfName: r.etf_name,
    side: r.side === "sell" ? "sell" : "buy",
    quantity: num(r.quantity),
    price: num(r.price),
    amount: num(r.amount),
    tradeDate: r.trade_date,
    settlementDate: r.settlement_date,
    inferredTradeDate: r.inferred_trade_date,
    eventDate: r.event_date,
    tradeDateEvidence: r.trade_date_evidence,
    fee: numOrNull(r.fee),
    tax: numOrNull(r.tax),
    postQuantity: numOrNull(r.post_quantity),
    source: r.source,
    sourceFile: r.source_file,
    sourceRow: r.source_row,
    sourceFingerprint: r.source_fingerprint,
    fingerprintVersion: r.fingerprint_version ?? undefined,
    importBatchId: r.import_batch_id,
  };
}

interface ServerEvent {
  id: string; account_type: string; event_date: string; type: string;
  strategy_included: boolean; memo: string | null; tags: string[] | null;
  hidden: boolean; is_user_created: boolean;
}

const toEvent = (r: ServerEvent): RebalanceEventRow => ({
  id: r.id,
  accountId: r.account_type as AccountId,
  eventDate: r.event_date,
  type: r.type,
  strategyIncluded: r.strategy_included,
  memo: r.memo,
  tags: r.tags ?? [],
  hidden: r.hidden,
  isUserCreated: r.is_user_created,
});

interface ServerCorrection {
  transaction_id: string;
  corrected_quantity: number | string | null;
  corrected_price: number | string | null;
  corrected_amount: number | string | null;
  corrected_trade_date: string | null;
  corrected_side: string | null;
  corrected_ticker: string | null;
  excluded: boolean;
  reason: string | null;
}

const toCorrection = (r: ServerCorrection): TransactionCorrection => ({
  transactionId: r.transaction_id,
  correctedQuantity: numOrNull(r.corrected_quantity),
  correctedPrice: numOrNull(r.corrected_price),
  correctedAmount: numOrNull(r.corrected_amount),
  correctedTradeDate: r.corrected_trade_date,
  correctedSide: r.corrected_side === "buy" || r.corrected_side === "sell"
    ? (r.corrected_side as TradeSide) : null,
  correctedTicker: r.corrected_ticker,
  excluded: r.excluded,
  reason: r.reason,
});

// ── 조회 ────────────────────────────────────────────────────────────────────

export interface LedgerData {
  /** 저장소가 아직 없다(migration 004 미적용). "데이터 없음"과 구분해 안내한다. */
  unavailable: boolean;
  transactions: LedgerTransaction[];
  events: RebalanceEventRow[];
  corrections: TransactionCorrection[];
  overrides: EventOverride[];
}

const EMPTY: LedgerData = {
  unavailable: false, transactions: [], events: [], corrections: [], overrides: [],
};

async function fetchLedger(): Promise<LedgerData> {
  const token = getSessionToken();
  if (!token) return EMPTY;
  const res = await fetch("/api/ledger", { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) return EMPTY;
  if (!res.ok) return { ...EMPTY, unavailable: true };
  const body = await res.json() as {
    unavailable?: boolean;
    transactions?: ServerTx[]; events?: ServerEvent[];
    corrections?: ServerCorrection[];
    overrides?: { transaction_id: string; event_id: string }[];
  };
  return {
    unavailable: body.unavailable === true,
    transactions: (body.transactions ?? []).map(toTransaction),
    events: (body.events ?? []).map(toEvent),
    corrections: (body.corrections ?? []).map(toCorrection),
    overrides: (body.overrides ?? []).map((o) => ({
      transactionId: o.transaction_id, eventId: o.event_id,
    })),
  };
}

export function useLedger(enabled: boolean) {
  return useQuery({
    queryKey: LEDGER_KEY,
    queryFn: fetchLedger,
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * 원장 + overlay → 화면에 보여줄 이벤트 목록.
 * 파생값 계산은 전부 여기(클라이언트)에서 한다 — 필터·기간 토글이 재요청을 만들지 않는다.
 */
export function useResolvedEvents(data: LedgerData | undefined): ResolvedEvent[] {
  return useMemo(() => {
    if (!data?.transactions.length) return [];
    return resolveEvents({
      transactions: data.transactions,
      corrections: data.corrections,
      overrides: data.overrides,
      events: data.events,
    });
  }, [data]);
}

// ── 변경 ────────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<unknown> {
  const token = getSessionToken();
  if (!token) throw new Error("로그인이 필요합니다");
  const res = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `요청 실패 (${res.status})`);
  }
  return res.json();
}

/** 메모 / 태그 / 숨김 / 타입 — 거래 자체는 건드리지 않는다. */
export interface EventPatch {
  id: string;
  accountId: string;
  eventDate: string;
  memo?: string;
  tags?: readonly string[];
  hidden?: boolean;
  type?: string;
  strategyIncluded?: boolean;
  isUserCreated?: boolean;
}

export function useLedgerMutations() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: LEDGER_KEY }); };

  const saveEvent = useMutation({
    mutationFn: (p: EventPatch) => post("/api/ledger/event", {
      id: p.id, accountType: p.accountId, eventDate: p.eventDate,
      memo: p.memo, tags: p.tags, hidden: p.hidden, type: p.type,
      strategyIncluded: p.strategyIncluded, isUserCreated: p.isUserCreated,
    }),
    onSuccess: invalidate,
  });

  /**
   * 병합 / 분리 / 이동. `eventId: null` 이면 override 를 지워 기본 grouping 으로 돌아간다.
   * `action` 은 audit 에 남을 이름이다 — 나중에 "무엇을 했는지" 구분하기 위해 넘긴다.
   */
  const assign = useMutation({
    mutationFn: (p: {
      transactionIds: readonly string[];
      eventId: string | null;
      action: "event_merge" | "event_split" | "tx_move";
    }) => post("/api/ledger/assign", p),
    onSuccess: invalidate,
  });

  /** 거래정보 정정. `clear: true` 면 정정을 지워 원본으로 되돌린다. */
  const correct = useMutation({
    mutationFn: (p: {
      transactionId: string;
      correctedQuantity?: number | null;
      correctedPrice?: number | null;
      correctedAmount?: number | null;
      correctedTradeDate?: string | null;
      correctedSide?: TradeSide | null;
      correctedTicker?: string | null;
      excluded?: boolean;
      reason?: string;
      clear?: boolean;
    }) => post("/api/ledger/correct", p),
    onSuccess: invalidate,
  });

  return { saveEvent, assign, correct };
}

// ── 변경 이력 ───────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  previousValue: unknown;
  newValue: unknown;
  note: string | null;
}

async function fetchAudit(targetId?: string): Promise<AuditEntry[]> {
  const token = getSessionToken();
  if (!token) return [];
  const url = targetId
    ? `/api/ledger/audit?targetId=${encodeURIComponent(targetId)}`
    : "/api/ledger/audit";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const body = await res.json() as {
    entries?: Array<{
      id: number; at: string; actor: string; action: string;
      target_type: string; target_id: string;
      previous_value: unknown; new_value: unknown; note: string | null;
    }>;
  };
  return (body.entries ?? []).map((e) => ({
    id: e.id, at: e.at, actor: e.actor, action: e.action,
    targetType: e.target_type, targetId: e.target_id,
    previousValue: e.previous_value, newValue: e.new_value, note: e.note,
  }));
}

export function useLedgerAudit(targetId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["kaw-ledger-audit", targetId ?? "all"],
    queryFn: () => fetchAudit(targetId),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
