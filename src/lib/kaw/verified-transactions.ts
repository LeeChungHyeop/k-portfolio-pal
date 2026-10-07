// ─────────────────────────────────────────────────────────────────────────────
// 검증된 거래내역 데이터셋 (`data/verified-transactions.v1.json`) 파서 + 검증기
//
// 원본은 미래에셋 공식 매매내역/거래내역(DC·IRP·ISA·연금)에서 뽑아 정규화한 것이다.
// 이 모듈은 그 JSON 을 앱 타입(`ledger.ts`)으로 옮기고, **적재 전에 데이터가 스스로
// 모순되지 않는지** 확인한다.
//
// ## JSON 을 import 하지 않는다
//
// 파일은 340KB 고 앱 화면에서는 전혀 필요 없다 — 원장은 DB 에서 읽는다. 그래서 이
// 모듈은 **파싱된 값을 인자로 받기만** 하고 파일을 import 하지 않는다. 그래야 import
// 스크립트와 테스트만 파일을 읽고 브라우저 번들은 커지지 않는다.
//
// ## 무엇을 검증하는가
//
// 적재는 되돌리기 번거로우므로, 넣기 전에 데이터셋 **자체의 정합성**을 전부 확인한다:
// 건수, id 중복, 모든 거래가 정확히 한 이벤트에 속하는지, 이벤트 집계가 소속 거래와
// 맞는지, 그리고 가장 중요한 **거래를 전부 재생한 최종 보유수량이 데이터셋이 주장하는
// finalHoldings 와 1주 단위로 일치하는지**. 하나라도 어긋나면 적재하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { ACCOUNT_IDS, type AccountId } from "./constants";
import {
  defaultEventId, replayFinalHoldings, resolveEvents,
  type LedgerTransaction, type RebalanceEventRow, type TradeSide,
} from "./ledger";

export interface VerifiedDataset {
  schemaVersion: number;
  transactions: LedgerTransaction[];
  events: RebalanceEventRow[];
  /** ETF명 → 종목코드. 앱의 자산 라이브러리와 대조할 때 쓴다. */
  tickerMap: Record<string, string>;
  /** 계좌별 K-올웨더 전략 시작일. 전략 성과 집계 경계이며 계좌 원금 시작일과 다르다. */
  strategyStartDates: Record<string, string>;
  /** 데이터셋이 스스로 주장하는 기대값 — 검증의 기준이 된다. */
  validation: {
    transactionCount: number;
    eventCount: number;
    accountTransactionCounts: Record<string, number>;
    accountEventCounts: Record<string, number>;
    finalHoldings: Record<string, Record<string, number>>;
    cashflowPrincipalChecksums: Record<string, number>;
  };
  sourceNotes: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function isAccountId(v: unknown): v is AccountId {
  return typeof v === "string" && (ACCOUNT_IDS as readonly string[]).includes(v);
}

/**
 * 원본 JSON → 앱 타입. 모양이 어긋나면 **고쳐서 통과시키지 않고 throw 한다** —
 * 조용히 보정하면 잘못된 데이터가 그대로 적재된다.
 */
export function parseVerifiedDataset(raw: unknown): VerifiedDataset {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== "object") throw new Error("데이터셋이 객체가 아닙니다");
  if (!Array.isArray(d.transactions)) throw new Error("transactions 배열이 없습니다");
  if (!Array.isArray(d.rebalanceEvents)) throw new Error("rebalanceEvents 배열이 없습니다");

  const transactions: LedgerTransaction[] = d.transactions.map((r, i) => {
    const t = r as Record<string, unknown>;
    const accountId = t.account;
    if (!isAccountId(accountId)) {
      throw new Error(`transactions[${i}]: 알 수 없는 계좌 ${String(accountId)}`);
    }
    const side = t.side === "buy" || t.side === "sell" ? (t.side as TradeSide) : null;
    if (!side) throw new Error(`transactions[${i}]: side 가 buy/sell 이 아닙니다`);
    const quantity = numOrNull(t.quantity);
    const price = numOrNull(t.price);
    const amount = numOrNull(t.amount);
    if (!(quantity && quantity > 0)) throw new Error(`transactions[${i}]: quantity 이상`);
    if (!(price && price > 0)) throw new Error(`transactions[${i}]: price 이상`);
    if (amount === null) throw new Error(`transactions[${i}]: amount 없음`);
    const eventDate = str(t.eventDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw new Error(`transactions[${i}]: eventDate 형식 오류 (${eventDate})`);
    }
    return {
      id: str(t.id),
      accountId,
      ticker: str(t.ticker),
      etfName: str(t.etfName),
      side,
      quantity,
      price,
      amount,
      tradeDate: t.tradeDate === null ? null : str(t.tradeDate) || null,
      settlementDate: t.settlementDate === null ? null : str(t.settlementDate) || null,
      inferredTradeDate: t.inferredTradeDate === null ? null : str(t.inferredTradeDate) || null,
      eventDate,
      tradeDateEvidence: str(t.tradeDateEvidence),
      fee: numOrNull(t.fee),
      tax: numOrNull(t.tax),
      postQuantity: numOrNull(t.postQuantity),
      source: str(t.source),
      sourceFile: t.sourceFile === null ? null : str(t.sourceFile) || null,
      sourceRow: numOrNull(t.sourceRow),
    };
  });

  const events: RebalanceEventRow[] = d.rebalanceEvents.map((r, i) => {
    const e = r as Record<string, unknown>;
    const accountId = e.account;
    if (!isAccountId(accountId)) {
      throw new Error(`rebalanceEvents[${i}]: 알 수 없는 계좌 ${String(accountId)}`);
    }
    return {
      id: str(e.id),
      accountId,
      eventDate: str(e.date),
      type: str(e.type) || "rebalance",
      strategyIncluded: e.strategyIncluded !== false,
      // 메모·태그·숨김은 데이터셋에 없다 — 사용자가 앱에서 붙이는 값이다.
      memo: null,
      tags: [],
      hidden: false,
      isUserCreated: false,
    };
  });

  const v = (d.validation ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: numOrNull(d.schemaVersion) ?? 0,
    transactions,
    events,
    tickerMap: (d.tickerMap ?? {}) as Record<string, string>,
    strategyStartDates: (d.strategyStartDates ?? {}) as Record<string, string>,
    validation: {
      transactionCount: numOrNull(v.transactionCount) ?? 0,
      eventCount: numOrNull(v.eventCount) ?? 0,
      accountTransactionCounts: (v.accountTransactionCounts ?? {}) as Record<string, number>,
      accountEventCounts: (v.accountEventCounts ?? {}) as Record<string, number>,
      finalHoldings: (v.finalHoldings ?? {}) as Record<string, Record<string, number>>,
      cashflowPrincipalChecksums: (v.cashflowPrincipalChecksums ?? {}) as Record<string, number>,
    },
    sourceNotes: Array.isArray(d.sourceNotes) ? (d.sourceNotes as string[]) : [],
  };
}

/** 검증 결과 한 줄. `ok: false` 가 하나라도 있으면 적재하지 않는다. */
export interface DatasetCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 데이터셋 자체 정합성 검사. **적재 전에 전부 통과해야 한다.**
 * 네트워크도 DB 도 보지 않는 순수 함수라 테스트와 import 스크립트가 같은 판정을 쓴다.
 */
export function verifyDataset(d: VerifiedDataset): DatasetCheck[] {
  const checks: DatasetCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 1. 건수
  add(
    "거래 건수",
    d.transactions.length === d.validation.transactionCount,
    `${d.transactions.length} / 기대 ${d.validation.transactionCount}`,
  );
  add(
    "이벤트 건수",
    d.events.length === d.validation.eventCount,
    `${d.events.length} / 기대 ${d.validation.eventCount}`,
  );

  // 2. id 중복
  const txIds = new Set(d.transactions.map((t) => t.id));
  add("거래 id 유일", txIds.size === d.transactions.length,
    `${txIds.size} / ${d.transactions.length}`);
  const evIds = new Set(d.events.map((e) => e.id));
  add("이벤트 id 유일", evIds.size === d.events.length,
    `${evIds.size} / ${d.events.length}`);

  // 3. 계좌별 건수
  for (const id of ACCOUNT_IDS) {
    const expected = d.validation.accountTransactionCounts[id];
    if (expected === undefined) continue;
    const actual = d.transactions.filter((t) => t.accountId === id).length;
    add(`거래 건수 (${id})`, actual === expected, `${actual} / 기대 ${expected}`);
  }

  // 4. 기본 grouping 으로 재구성한 이벤트가 데이터셋 이벤트와 같은가.
  //    (앱은 override 가 없으면 `rev:<account>:<date>` 로 묶는다 — 두 규칙이 일치해야
  //     적재 후 화면이 데이터셋과 같은 이벤트를 보여준다.)
  const derivedIds = new Set(
    d.transactions.map((t) => defaultEventId(t.accountId, t.eventDate)),
  );
  const datasetIds = new Set(d.events.map((e) => e.id));
  const onlyDerived = [...derivedIds].filter((x) => !datasetIds.has(x));
  const onlyDataset = [...datasetIds].filter((x) => !derivedIds.has(x));
  add(
    "기본 grouping = 데이터셋 이벤트",
    onlyDerived.length === 0 && onlyDataset.length === 0,
    onlyDerived.length || onlyDataset.length
      ? `파생만: ${onlyDerived.slice(0, 3).join(", ")} / 데이터셋만: ${onlyDataset.slice(0, 3).join(", ")}`
      : `${derivedIds.size}개 일치`,
  );

  // 5. 음수 보유수량이 생기지 않는가 (매도가 보유보다 많은 경우).
  //    **정규 순서(ledger.ts compareIntraDayOrder)로 재생한다** — 같은 날 매도가 매수보다
  //    먼저 온 것처럼 정렬하면 있지도 않은 음수가 만들어진다.
  const events = resolveEvents({ transactions: d.transactions });
  const negatives = [...new Set(
    events.flatMap((e) => e.lines)
      .filter((l) => l.afterQuantity < 0)
      .map((l) => `${l.effective.accountId}/${l.effective.ticker}`),
  )];
  add("음수 보유수량 없음", negatives.length === 0,
    negatives.length ? negatives.slice(0, 5).join(", ") : "0건");

  // 6. **가장 중요한 검증** — 전부 재생한 최종 보유수량이 데이터셋 주장과 일치하는가
  const replayed = replayFinalHoldings(d.transactions);
  const mismatches: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const expected = d.validation.finalHoldings[id];
    if (!expected) continue;
    const actual = replayed[id] ?? {};
    const tickers = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const tk of tickers) {
      const e = expected[tk] ?? 0;
      const a = actual[tk] ?? 0;
      if (e !== a) mismatches.push(`${id}/${tk}: 재생 ${a} ≠ 기대 ${e}`);
    }
  }
  add("최종 보유수량 재생 일치", mismatches.length === 0,
    mismatches.length ? mismatches.slice(0, 5).join(" | ") : "전 계좌 일치");

  // 7. 증권사가 보고한 거래후수량과 재생값이 어긋나지 않는가
  //    (보고하지 않은 거래는 대조 대상이 아니다 — 추정으로 메우지 않는다)
  const postMismatch = events
    .flatMap((e) => e.lines)
    .filter((l) => l.postQuantityMismatch === true);
  add("증권사 보고 거래후수량 일치", postMismatch.length === 0,
    postMismatch.length
      ? postMismatch.slice(0, 5).map((l) =>
        `${l.effective.id} 보고 ${l.transaction.postQuantity} ≠ 재생 ${l.afterQuantity}`).join(" | ")
      : `대조 가능 ${events.flatMap((e) => e.lines).filter((l) => l.postQuantityMismatch !== null).length}건 전부 일치`);

  // 8. 모든 거래가 정확히 하나의 이벤트에 들어갔는가
  const inEvents = events.reduce((s, e) => s + e.lines.length, 0);
  add("모든 거래가 이벤트에 1회씩", inEvents === d.transactions.length,
    `${inEvents} / ${d.transactions.length}`);

  return checks;
}

/** 검증 결과를 사람이 읽을 수 있는 줄로. import 스크립트의 dry-run 출력에 쓴다. */
export function formatChecks(checks: readonly DatasetCheck[]): string {
  return checks
    .map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(28)} ${c.detail}`)
    .join("\n");
}
