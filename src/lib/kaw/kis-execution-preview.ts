// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 체결내역 → 원장 **미리보기** — 순수 모듈 (Phase 4-A PoC)
//
// 조회한 체결(`ParsedCcldRow`)을 기존 원장과 대조해서 각 행에 상태를 붙인다.
// **어떤 거래도 원장에 추가하지 않는다.** 이 모듈은 DB·네트워크에 접근하지 않고, 사용자가
// 승인하기 전에는 "후보"(LedgerCandidate)를 만들어 보여주는 데서 끝난다.
//
//   new                    신규 체결 — 원장에 없고, 계좌 귀속이 맞고, 체결이 있다
//   matches                기존 원장과 일치 — 같은 출처의 같은 주문번호가 같은 값으로 이미 있다
//   possible_duplicate     중복 가능성 — 다른 출처(예: 미래에셋)나 값이 다른 같은 주문이 이미 있다
//   attribution_conflict   계좌 귀속 충돌 — 그 날짜에 이 한국투자 계좌가 활성이 아니다
//   no_execution           체결 없는 주문 — 체결수량 0(정정 원주문·취소·거부·미체결)
//   unverifiable           확인 불가 — 필드를 읽지 못했거나 주문번호가 겹친다
//
// 승인 가능(`approvable`)은 오직 `new` 뿐이다. `possible_duplicate` 는 사용자가 원장의 기존
// 행과 비교해 "같은 거래가 아니다"라고 판단한 뒤에만 별도 단계에서 풀 수 있고, 이 모듈은
// 그 판단을 대신하지 않는다.
//
// ## 신원(fingerprint) — v2 (주문번호 기반)
//
// 미래에셋 export 에는 주문번호가 없어 내용 조합(v1)을 썼다. KIS 는 주문번호를 주므로
// `v2|source|계좌 instance|주문일|주문번호` 한 줄로 신원을 잡는다. 출처가 다르므로 v1 행과
// 같은 문자열이 될 수 없다(버전·source 가 맨 앞에 들어간다). 기존 v1 행은 건드리지 않는다.
//
// ## 이 미리보기가 **하지 않는 것**
//
//   · cashflow(외부 입출금)를 만들거나 바꾸지 않는다
//   · 자금 출처가 확인됐는지는 `account-transfer-model.ts` 가 따로 본다 — 신규 매수는
//     자금 출처 없이 원장에 넣으면 유도 예수금이 음수가 되고, 보수 모델이 그 결손을 "미관측
//     수입"으로 오분류한다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { isActiveOn, type BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";
import type { ParsedCcldRow } from "./kis-ccld-history";

export const KIS_LEDGER_SOURCE = "kis_api_daily_ccld";
export const KIS_FINGERPRINT_VERSION = 2;

export type PreviewStatus =
  | "new"
  | "matches"
  | "possible_duplicate"
  | "attribution_conflict"
  | "no_execution"
  | "unverifiable";

export const PREVIEW_STATUS_LABEL: Readonly<Record<PreviewStatus, string>> = Object.freeze({
  new: "신규 체결",
  matches: "기존 원장과 일치",
  possible_duplicate: "중복 가능성",
  attribution_conflict: "계좌 귀속 충돌",
  no_execution: "체결 없는 주문",
  unverifiable: "확인 불가",
});

/** 행을 읽을 수 없다고 판단한 이유(어떤 필수 정보가 비었는가). 값은 싣지 않고 이름만 쓴다 */
function missingFields(r: ParsedCcldRow["row"]): string[] {
  const out: string[] = [];
  if (!r.orderDate || !/^\d{8}$/.test(r.orderDate)) out.push("주문일");
  if (!r.orderNo) out.push("주문번호");
  if (!r.ticker || !/^[A-Z0-9]{6}$/.test(r.ticker)) out.push("종목코드");
  if (r.sideCode !== "01" && r.sideCode !== "02") out.push("매수/매도 구분");
  if (r.orderQty === null) out.push("주문수량");
  if (r.filledQty === null) out.push("체결수량");
  if (r.remainingQty === null) out.push("잔여수량");
  if (r.filledQty !== null && r.filledQty > 0 && r.avgPrice === null) out.push("평균 체결가");
  if (r.filledQty !== null && r.filledQty > 0 && r.filledAmount === null) out.push("체결금액");
  return out.length ? out : ["필수 정보"];
}

export type PreviewReason =
  | "ok"
  | "same_order_in_ledger"
  | "same_order_different_values"
  | "other_source_same_trade"
  | "no_registry"
  | "no_active_kis_instance_on_date"
  | "active_instance_not_kis"
  | "ambiguous_instance"
  | "zero_fill_closed_possible_modification"
  | "zero_fill_open"
  | "cancelled_without_fill"
  | "rejected"
  | "unreadable_fields"
  | "duplicate_order_number_in_response"
  | "amount_mismatch"
  | "unsupported_side";

/** 원장에 넣게 될 후보. **아직 아무 곳에도 쓰이지 않았다.** */
export interface LedgerCandidate {
  accountId: AccountId;
  accountInstanceId: string;
  source: typeof KIS_LEDGER_SOURCE;
  sourceFingerprint: string;
  fingerprintVersion: typeof KIS_FINGERPRINT_VERSION;
  ticker: string;
  etfName: string;
  side: "buy" | "sell";
  quantity: number;
  /** 평균 체결가(주문 1건의 가중평균) */
  price: number;
  /** tot_ccld_amt — 수수료 제외 체결대금 */
  amount: number;
  /** YYYY-MM-DD — 증권사가 직접 보고한 주문일 */
  tradeDate: string;
  settlementDate: null;
  inferredTradeDate: null;
  eventDate: string;
  tradeDateEvidence: "broker-order-date";
  /** 건별 수수료·세금은 이 API 가 주지 않는다 — 0 으로 채우지 않는다 */
  fee: null;
  tax: null;
  postQuantity: null;
  /** 주문 1건 단위 집계다(분할체결 개별 내역이 아니다) */
  granularity: "order";
  orderNo: string;
  origOrderNo: string | null;
}

export interface PreviewEntry {
  /** 같은 주문일+주문번호 */
  key: string;
  status: PreviewStatus;
  reason: PreviewReason;
  label: string;
  parsed: ParsedCcldRow;
  /** 승인할 수 있는 상태인가 — `new` 일 때만 true */
  approvable: boolean;
  /** `new` 일 때만 있다 */
  candidate?: LedgerCandidate;
  /** 비교 대상으로 삼은 원장 행의 id (중복 가능성·일치) */
  ledgerRef?: string;
  /** 일부만 체결돼 잔여가 남은 주문 등 사용자가 알아야 할 주의 */
  notes: string[];
}

export interface PreviewInput {
  rows: readonly ParsedCcldRow[];
  /** 원장 전체(또는 이 계좌의 것). 읽기 전용으로만 쓴다 */
  ledger: readonly LedgerTransaction[];
  registry: readonly BrokerAccountInstance[];
  accountType: AccountId;
  /** KIS 상품코드. 연금저축 22 */
  productCode: string;
  /** 같은 거래로 의심하는 날짜 허용 오차(일). 기본 0 — 주문일은 증권사가 직접 보고한 사실이다 */
  duplicateDayTolerance?: number;
}

const ymdToIso = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

export function kisExecutionFingerprint(accountInstanceId: string, orderDateYmd: string, orderNo: string): string {
  return [`v${KIS_FINGERPRINT_VERSION}`, KIS_LEDGER_SOURCE, accountInstanceId, orderDateYmd, orderNo].join("|");
}

export type KisInstanceResolution =
  | { kind: "resolved"; instance: BrokerAccountInstance }
  | { kind: "none"; reason: "no_registry" | "no_active_kis_instance_on_date" | "active_instance_not_kis" }
  | { kind: "ambiguous" };

/**
 * 그 날짜에 이 상품코드의 한국투자 계좌가 **유일하게** 활성인가. 아니면 귀속하지 않는다.
 * (추정하지 않는다 — 날짜가 등록 기간 밖이면 충돌이다.)
 */
export function resolveKisInstanceOn(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  productCode: string,
  isoDate: string,
): KisInstanceResolution {
  if (!registry.length) return { kind: "none", reason: "no_registry" };
  const mine = registry.filter((i) => i.logicalAccountType === accountType && isActiveOn(i, isoDate));
  if (!mine.length) return { kind: "none", reason: "no_active_kis_instance_on_date" };
  const kis = mine.filter((i) => i.broker === "kis" && i.productCode === productCode);
  if (kis.length === 1 && mine.length === 1) return { kind: "resolved", instance: kis[0] };
  if (mine.length > 1) return { kind: "ambiguous" };
  return { kind: "none", reason: "active_instance_not_kis" };
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** 원장 행을 이 미리보기가 비교하는 모양으로 줄인다. */
function ledgerDate(t: LedgerTransaction): string {
  return String(t.eventDate).slice(0, 10);
}

export function previewKisExecutions(input: PreviewInput): PreviewEntry[] {
  const tol = input.duplicateDayTolerance ?? 0;
  const entries: PreviewEntry[] = [];

  // 응답 안에서 주문일+주문번호가 겹치는 행은 어느 쪽이 맞는지 가릴 수 없다.
  const counts = new Map<string, number>();
  for (const p of input.rows) {
    if (p.row.orderNo && p.row.orderDate) {
      const k = `${p.row.orderDate}:${p.row.orderNo}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const accountLedger = input.ledger.filter((t) => t.accountId === input.accountType);

  for (const p of input.rows) {
    const r = p.row;
    const key = r.orderDate && r.orderNo ? `${r.orderDate}:${r.orderNo}` : `unreadable:${entries.length}`;
    const mk = (
      status: PreviewStatus,
      reason: PreviewReason,
      extra: Partial<Pick<PreviewEntry, "candidate" | "ledgerRef" | "notes">> = {},
    ): PreviewEntry => ({
      key, status, reason, label: PREVIEW_STATUS_LABEL[status], parsed: p,
      approvable: status === "new", notes: extra.notes ?? [],
      ...(extra.candidate ? { candidate: extra.candidate } : {}),
      ...(extra.ledgerRef ? { ledgerRef: extra.ledgerRef } : {}),
    });

    // 1) 읽을 수 없다
    if (p.kind === "unreadable") {
      entries.push(mk("unverifiable", "unreadable_fields", {
        notes: [`읽지 못한 필수 정보: ${missingFields(r).join(", ")}. 체결 여부를 알 수 없어 합계와 원장 후보에서 제외했습니다.`],
      }));
      continue;
    }
    if ((counts.get(key) ?? 0) > 1) { entries.push(mk("unverifiable", "duplicate_order_number_in_response")); continue; }

    // 2) 체결이 없다 — 어떤 경우에도 원장 후보가 아니다
    if (!p.hasExecution) {
      const reason: PreviewReason =
        p.kind === "rejected" ? "rejected"
        : p.kind === "cancelled" ? "cancelled_without_fill"
        : p.kind === "no_fill_open" ? "zero_fill_open"
        : "zero_fill_closed_possible_modification";
      const notes = reason === "zero_fill_closed_possible_modification"
        ? [
            r.cancelled === false
              ? "체결 0 · 잔여 0 · 취소 아님: 정정으로 대체된 원주문일 가능성이 있습니다(확정 아님). 같은 종목·수량의 체결 행이 따로 있는지 확인하세요."
              : "체결 0 · 잔여 0: 증권사가 취소 여부를 알려주지 않았습니다. 정정으로 대체되었거나 취소된 원주문일 수 있습니다(확정 아님). 같은 종목·수량의 체결 행이 따로 있는지 확인하세요.",
          ]
        : [];
      entries.push(mk("no_execution", reason, { notes }));
      continue;
    }

    // 3) 방향 — 이 PoC 는 매수·매도 모두 읽지만, 알 수 없는 코드는 막는다
    const side = r.sideCode === "02" ? "buy" : r.sideCode === "01" ? "sell" : null;
    if (!side) { entries.push(mk("unverifiable", "unsupported_side")); continue; }

    // 4) 금액이 수량 × 평균가와 맞지 않으면 값을 믿지 않는다(1원 단위 반올림은 허용)
    if (p.amountMismatch !== null && p.amountMismatch > Math.max(1, Math.round((r.filledQty as number) * 0.0001))) {
      entries.push(mk("unverifiable", "amount_mismatch"));
      continue;
    }

    // 5) 계좌 귀속
    const iso = ymdToIso(r.orderDate as string);
    const res = resolveKisInstanceOn(input.registry, input.accountType, input.productCode, iso);
    if (res.kind === "ambiguous") { entries.push(mk("attribution_conflict", "ambiguous_instance")); continue; }
    if (res.kind === "none") { entries.push(mk("attribution_conflict", res.reason)); continue; }
    const inst = res.instance;

    const notes: string[] = [];
    if (p.kind === "partially_filled_open") {
      notes.push(
        r.cancelled === null
          ? "일부만 체결됐고 잔여 수량이 있습니다. 증권사가 취소 여부를 알려주지 않아 주문이 아직 살아 있는지는 확인되지 않았습니다. 체결된 수량만 후보입니다."
          : "일부만 체결됐고 잔여 주문이 남아 있습니다. 체결된 수량만 후보입니다.",
      );
    }
    if (p.kind === "partially_filled_closed") notes.push("일부만 체결되고 잔여가 닫혔습니다. 체결된 수량만 후보입니다.");

    const fp = kisExecutionFingerprint(inst.id, r.orderDate as string, r.orderNo as string);
    const filled = r.filledQty as number;
    const amount = r.filledAmount as number;
    const avg = r.avgPrice as number;

    // 6) 같은 출처 · 같은 주문번호
    const sameOrder = accountLedger.find((t) => t.sourceFingerprint === fp);
    if (sameOrder) {
      const same = sameOrder.quantity === filled && sameOrder.amount === amount && sameOrder.ticker === r.ticker && sameOrder.side === side;
      entries.push(
        same
          ? mk("matches", "same_order_in_ledger", { ledgerRef: sameOrder.id, notes })
          : mk("possible_duplicate", "same_order_different_values", {
              ledgerRef: sameOrder.id,
              notes: [...notes, "같은 주문번호가 원장에 있는데 수량·금액이 다릅니다(주문이 더 체결됐거나 정정됐을 수 있습니다)."],
            }),
      );
      continue;
    }

    // 7) 다른 출처의 같은 거래 (날짜 · 종목 · 방향 · 수량)
    const other = accountLedger.find(
      (t) =>
        t.ticker === r.ticker && t.side === side && t.quantity === filled &&
        dayDiff(ledgerDate(t), iso) <= tol,
    );
    if (other) {
      entries.push(mk("possible_duplicate", "other_source_same_trade", { ledgerRef: other.id, notes }));
      continue;
    }

    // 8) 신규
    const candidate: LedgerCandidate = {
      accountId: input.accountType,
      accountInstanceId: inst.id,
      source: KIS_LEDGER_SOURCE,
      sourceFingerprint: fp,
      fingerprintVersion: KIS_FINGERPRINT_VERSION,
      ticker: r.ticker as string,
      etfName: r.name ?? (r.ticker as string),
      side,
      quantity: filled,
      price: avg,
      amount,
      tradeDate: iso,
      settlementDate: null,
      inferredTradeDate: null,
      eventDate: iso,
      tradeDateEvidence: "broker-order-date",
      fee: null,
      tax: null,
      postQuantity: null,
      granularity: "order",
      orderNo: r.orderNo as string,
      origOrderNo: r.origOrderNo,
    };
    entries.push(mk("new", "ok", { candidate, notes }));
  }
  return entries;
}

export interface PreviewTotals {
  byStatus: Record<PreviewStatus, number>;
  /** 승인 가능한 신규 체결의 매수 합계 / 매도 합계 */
  newBuyAmount: number;
  newSellAmount: number;
  newBuyQty: number;
}

export function totalsOfPreview(entries: readonly PreviewEntry[]): PreviewTotals {
  const byStatus: Record<PreviewStatus, number> = {
    new: 0, matches: 0, possible_duplicate: 0, attribution_conflict: 0, no_execution: 0, unverifiable: 0,
  };
  let newBuyAmount = 0, newSellAmount = 0, newBuyQty = 0;
  for (const e of entries) {
    byStatus[e.status]++;
    if (e.status === "new" && e.candidate) {
      if (e.candidate.side === "buy") { newBuyAmount += e.candidate.amount; newBuyQty += e.candidate.quantity; }
      else newSellAmount += e.candidate.amount;
    }
  }
  return { byStatus, newBuyAmount, newSellAmount, newBuyQty };
}
