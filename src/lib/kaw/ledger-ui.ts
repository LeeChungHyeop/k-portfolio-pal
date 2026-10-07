// 거래 이력 화면의 **표시 규칙** — 순수 함수만 둔다 (렌더링과 분리해 테스트로 고정한다).
//
// 여기서 정하는 것은 "무엇을 어떻게 보여주는가"뿐이고, 금액·수량 계산은 전부
// `ledger.ts` 가 한다. 특히 **없는 값을 추정해 채우지 않는다** — 증권사가 주지 않은
// 수수료·세금·거래후잔고는 "—"로 비워 두고, 추정 날짜는 추정이라고 밝힌다.

import type { ResolvedEvent, TradeDateEvidence } from "./ledger";

// ── 이벤트 유형 ─────────────────────────────────────────────────────────────
//
// 확장 가능한 구조다 — 모르는 값이 와도 그 값을 그대로 보여주고 화면이 깨지지 않는다.
export const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  rebalance: "리밸런싱",
  pre_strategy_trade: "전략 이전 매매",
  strategy_start: "전략 시작",
  contribution_buy: "정기매수",
  partial_sell: "부분매도",
  full_sell: "전량매도",
  new_position: "신규편입",
  cash_raise: "현금확보",
  manual: "수동",
};

/** 사용자가 고를 수 있는 유형 목록 (저장된 값이 목록에 없어도 그대로 유지된다) */
export const EVENT_TYPE_OPTIONS = Object.keys(EVENT_TYPE_LABELS);

export const eventTypeLabel = (type: string): string => EVENT_TYPE_LABELS[type] ?? type;

/** 추천 태그. 사용자가 직접 입력한 태그도 그대로 쓸 수 있다(고정 목록이 아니다). */
export const SUGGESTED_TAGS: readonly string[] = [
  "정기매수", "리밸런싱", "부분매도", "전량매도", "신규편입", "현금확보", "수동",
];

// ── 날짜 신뢰도 ─────────────────────────────────────────────────────────────

export interface DateConfidence {
  /** 증권사가 거래일을 직접 보고했는가 */
  direct: boolean;
  label: string;
  detail: string;
}

const EVIDENCE_TEXT: Readonly<Record<string, { label: string; detail: string }>> = {
  "broker-order-date": {
    label: "확정",
    detail: "증권사가 보고한 주문일입니다.",
  },
  "cross-account-settlement-match": {
    label: "추정",
    detail: "결제일이 같은 다른 계좌의 주문일과 대조해 추정한 날짜입니다.",
  },
  "tplus2-weekday-inference": {
    label: "추정",
    detail: "결제일에서 영업일 2일을 역산해 추정한 날짜입니다. 결제일은 확정 사실입니다.",
  },
};

export function dateConfidenceOf(evidence: TradeDateEvidence): DateConfidence {
  const hit = EVIDENCE_TEXT[evidence];
  if (hit) return { direct: evidence === "broker-order-date", ...hit };
  // 모르는 근거는 "확정"이라고 말하지 않는다 — 모른다고 말한다.
  return { direct: false, label: "추정", detail: `날짜 근거: ${evidence}` };
}

/** 이벤트 전체의 날짜 신뢰도 — 하나라도 추정이 섞이면 추정으로 본다. */
export function eventDateConfidence(e: ResolvedEvent): DateConfidence {
  const all = e.dateEvidence.map(dateConfidenceOf);
  if (all.length && all.every((c) => c.direct)) return all[0];
  const inferred = all.filter((c) => !c.direct);
  return {
    direct: false,
    label: "추정 포함",
    detail: inferred.length
      ? inferred.map((c) => c.detail).join(" ")
      : "거래일 근거를 확인할 수 없습니다.",
  };
}

// ── 표시 포맷 ───────────────────────────────────────────────────────────────

/** 금액 — 원 단위 천단위 구분. 0 도 "0" 으로 보여준다(빈칸과 구분). */
export const fmtAmount = (n: number): string => Math.round(n).toLocaleString("ko-KR");

/**
 * 값이 없을 수 있는 숫자. **null 은 "—" 다** — 0 으로 바꾸지 않는다.
 * 증권사가 수수료·세금·거래후잔고를 주지 않는 계좌가 있어서, 0 원과 "모름"을
 * 구분하지 않으면 사용자가 잘못 읽는다.
 */
export const fmtNullableAmount = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : fmtAmount(n);

/** 수량 — 소수 보유가 가능하므로 필요한 자리만 보여준다. */
export const fmtQty = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString("ko-KR") : n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });

/** 매매 수량 — 부호를 분명히 (+3 / -5) */
export const fmtDelta = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtQty(Math.abs(n))}`;

/** 날짜 — 목록에서 짧게 (YY.MM.DD) */
export const fmtDateShort = (iso: string): string => iso.slice(2).replaceAll("-", ".");

/** 이벤트의 날짜 표시. 병합해서 범위가 생겼으면 범위로 보여준다. */
export function eventDateLabel(e: ResolvedEvent): string {
  return e.date === e.dateEnd
    ? e.date
    : `${e.date} ~ ${fmtDateShort(e.dateEnd)}`;
}

/** 목록의 "주요 종목" — 매수금액 큰 순으로 2개까지, 나머지는 +N */
export function topEtfLabel(e: ResolvedEvent, limit = 2): string {
  const names = e.topEtfNames;
  if (!names.length) return "—";
  const head = names.slice(0, limit).join(", ");
  return names.length > limit ? `${head} 외 ${names.length - limit}` : head;
}

// ── audit 라벨 ──────────────────────────────────────────────────────────────

export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  import: "원장 적재",
  event_merge: "이벤트 병합",
  event_split: "이벤트 분리",
  tx_move: "거래 이동",
  memo_change: "메모 수정",
  tag_change: "태그 수정",
  event_hide: "이벤트 숨김",
  event_restore: "이벤트 복원",
  tx_correct: "거래정보 정정",
  tx_uncorrect: "정정 취소(원본 복귀)",
};

export const auditActionLabel = (action: string): string =>
  AUDIT_ACTION_LABELS[action] ?? action;

/** 정정된 필드 이름 → 사람이 읽는 말 */
export const CORRECTED_FIELD_LABELS: Readonly<Record<string, string>> = {
  quantity: "수량",
  price: "단가",
  amount: "금액",
  side: "매매구분",
  ticker: "종목코드",
  eventDate: "거래일",
};

export const correctedFieldLabel = (f: string): string => CORRECTED_FIELD_LABELS[f] ?? f;

/** 변경 시각 — 한국시간 기준 "YYYY-MM-DD HH:MM" */
export function fmtAuditTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 9 * 3_600_000).toISOString().replace("T", " ").slice(0, 16);
}
