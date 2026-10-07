// ─────────────────────────────────────────────────────────────────────────────
// 거래 원장 (Transaction Ledger) → 리밸런싱 이벤트 — 순수 모듈
//
// 리밸런싱 이력의 **유일한 source of truth 는 실제 체결내역**이다. 과거에 설정했던
// 목표비중은 당시 의사결정 참고자료일 뿐이고 실제 매매가 그대로 이루어지지 않은 경우가
// 많다. 그래서 이 모듈에는 목표비중이라는 개념이 아예 없다 — "당시 목표가 40%였으므로
// 이렇게 리밸런싱했을 것"이라는 추론을 하는 코드 경로를 만들지 않는다.
//
// legacy `AccountState.history`(리밸런싱 저장 시점의 상태 스냅샷)도 이 모듈은 읽지 않는다.
// 그쪽은 migration 검증·과거 기록 비교·audit 용으로 따로 살아 있다.
//
// ── 계층 ────────────────────────────────────────────────────────────────────
//
//   LedgerTransaction        증권사 체결 1건. **원본이며 수정하지 않는다.**
//     + TransactionCorrection  사용자 정정 overlay (유효값 = corrected ?? 원본)
//     + EventOverride          소속 이벤트 재지정 (병합 / 분리 / 이동)
//   ResolvedEvent            사용자에게 보여주는 매매 이벤트 (+ 메모·태그·숨김)
//
// 기본 grouping: **동일 계좌 + 동일 실효 거래일** → 이벤트 1개.
// 그래서 기본 이벤트 id 는 `rev:<account>:<date>` 로 계산 가능하고, DB 에 행이 없어도 된다.
// 사용자가 병합/분리/이동하면 그 거래에만 override 가 생긴다.
//
// ── 파생값을 저장하지 않는다 ────────────────────────────────────────────────
//
// 거래건수·매수/매도 금액·전후 보유수량은 전부 여기서 계산한다. 소속 거래가 바뀌면 즉시
// 달라지는 값이라 DB 컬럼으로 굳히면 그 순간 stale 해진다 (performance.ts 가 외부흐름을
// 스냅샷에 복사하지 않는 것과 같은 이유).
//
// ── 보유수량 재생 ───────────────────────────────────────────────────────────
//
// 이벤트의 "이전 보유수량 → 거래 → 이후 보유수량"은 계좌별로 **처음부터 순서대로 재생**해서
// 얻는다. 증권사가 보고한 `postQuantity` 가 있으면 그것과 대조해 불일치를 드러내고,
// 없으면 재생값만 쓴다. **추정으로 메우지 않는다.**
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";

export type TradeSide = "buy" | "sell";

/**
 * 거래일의 근거. UI 는 이것을 **신뢰도**로 노출해야 한다 —
 * `broker-order-date` 만 증권사가 직접 보고한 사실이고 나머지는 추정이다.
 */
export type TradeDateEvidence =
  | "broker-order-date"
  | "cross-account-settlement-match"
  | "tplus2-weekday-inference"
  | (string & {});

/** 증권사 체결 1건. **원본이며 이 모듈은 절대 수정하지 않는다.** */
export interface LedgerTransaction {
  id: string;
  accountId: AccountId;
  ticker: string;
  /** 체결 당시의 종목명 (이름이 바뀌어도 그 때 값을 보존한다) */
  etfName: string;
  side: TradeSide;
  quantity: number;
  price: number;
  /** 증권사가 보고한 거래대금. quantity × price 와 반올림 차이가 있을 수 있다. */
  amount: number;
  /** 증권사가 직접 보고한 주문일. 없는 계좌가 있다. */
  tradeDate: string | null;
  settlementDate: string | null;
  inferredTradeDate: string | null;
  /** grouping 에 쓰는 실효 거래일 = tradeDate ?? inferredTradeDate */
  eventDate: string;
  tradeDateEvidence: TradeDateEvidence;
  fee: number | null;
  tax: number | null;
  /** 증권사가 보고한 거래 후 보유수량. 보고하지 않으면 null — 0 으로 채우지 않는다. */
  postQuantity: number | null;
  source: string;
  sourceFile?: string | null;
  /**
   * 원본 파일의 행 번호. **신원이 아니라 참고용 + 일중 순서용**이다.
   * 증권사 export 가 최신순이라 거래가 추가되면 기존 행 번호가 전부 밀린다
   * (`transactionFingerprint` 주석 참고).
   */
  sourceRow?: number | null;
  /** 안정적 신원. 적재 시 `transactionFingerprint` 로 계산해 넣는다. */
  sourceFingerprint?: string;
  /** 그 신원을 만든 규칙의 버전 (`FINGERPRINT_VERSION`). 규칙이 바뀌면 올라간다. */
  fingerprintVersion?: number;
  /** 어느 적재 작업에서 들어왔는가 */
  importBatchId?: string | null;
}

/** 사용자 정정 overlay. 원본을 덮지 않는다 — 유효값 = corrected ?? 원본. */
export interface TransactionCorrection {
  transactionId: string;
  correctedQuantity?: number | null;
  correctedPrice?: number | null;
  correctedAmount?: number | null;
  correctedTradeDate?: string | null;
  correctedSide?: TradeSide | null;
  correctedTicker?: string | null;
  /** 계산에서 제외. 삭제가 아니라 플래그다. */
  excluded?: boolean;
  reason?: string | null;
}

/** 거래의 소속 이벤트 재지정 (병합 / 분리 / 이동) */
export interface EventOverride {
  transactionId: string;
  eventId: string;
}

/** DB 에 저장되는 이벤트 행. 기본 grouping 이벤트는 행이 없을 수도 있다. */
export interface RebalanceEventRow {
  id: string;
  accountId: AccountId;
  eventDate: string;
  type: string;
  strategyIncluded: boolean;
  memo?: string | null;
  tags?: readonly string[];
  hidden?: boolean;
  isUserCreated?: boolean;
}

/** 이벤트 안의 거래 한 줄 — 이전 → 매매 → 이후 를 한눈에 보여주기 위한 모양 */
export interface EventTransactionLine {
  transaction: LedgerTransaction;
  /** 정정이 적용된 유효 거래 (원본은 transaction 에 그대로 남아 있다) */
  effective: EffectiveTransaction;
  /** 이 거래 직전 보유수량 */
  beforeQuantity: number;
  /** 매수 +, 매도 - */
  deltaQuantity: number;
  /** 이 거래 직후 보유수량 */
  afterQuantity: number;
  /**
   * 증권사가 보고한 `postQuantity` 와 재생값이 다른가.
   * null 이면 증권사가 보고하지 않아 대조할 수 없다는 뜻이다(불일치 아님).
   */
  postQuantityMismatch: boolean | null;
}

/** 정정이 적용된 유효 거래값. 원본과 다른 필드가 있으면 `corrected` 가 true 다. */
export interface EffectiveTransaction {
  id: string;
  accountId: AccountId;
  ticker: string;
  etfName: string;
  side: TradeSide;
  quantity: number;
  price: number;
  amount: number;
  eventDate: string;
  /** 사용자가 정정한 데이터인가 */
  corrected: boolean;
  /** 사용자가 계산에서 제외한 거래인가 */
  excluded: boolean;
  /** 어떤 필드가 정정됐는지 (UI 에서 원본과 나란히 보여주기 위해) */
  correctedFields: readonly string[];
}

/** 화면에 보여주는 이벤트 — 파생값은 전부 여기서 계산된 것이다. */
export interface ResolvedEvent {
  id: string;
  accountId: AccountId;
  /** 이벤트 날짜. 소속 거래들의 **가장 이른** 실효 거래일이다(병합하면 범위가 생긴다). */
  date: string;
  /** 소속 거래의 실효 거래일 범위 끝. 병합하지 않았다면 date 와 같다. */
  dateEnd: string;
  type: string;
  strategyIncluded: boolean;
  memo: string;
  tags: readonly string[];
  hidden: boolean;
  isUserCreated: boolean;
  /** 사용자가 기본 grouping 을 바꿨는가 (병합/분리/이동된 거래가 있다) */
  regrouped: boolean;
  /** 날짜 근거 모음. `broker-order-date` 외의 값이 있으면 추정이 섞인 것이다. */
  dateEvidence: readonly TradeDateEvidence[];
  lines: readonly EventTransactionLine[];
  /** 체결 **건수**. 같은 종목을 여러 번 사도 그대로 센다. */
  tradeCount: number;
  /** 매수한 **종목 수**(distinct ticker). 체결 건수가 아니다 — 화면이 "매수 N종목"으로 쓴다. */
  buyCount: number;
  /** 매도한 **종목 수**(distinct ticker). 체결 건수가 아니다. */
  sellCount: number;
  buyAmount: number;
  sellAmount: number;
  /** 매수 - 매도 (순투입) */
  netAmount: number;
  /** 이벤트 직전 보유수량 (ticker → 수량). 0 인 종목은 키가 없다. */
  preHoldings: Readonly<Record<string, number>>;
  /** 이벤트 직후 보유수량 */
  postHoldings: Readonly<Record<string, number>>;
  /** 거래된 종목명 (매수금액 큰 순) — 목록 화면의 "주요 종목" */
  topEtfNames: readonly string[];
}

// ── 기본 grouping ───────────────────────────────────────────────────────────

/** 기본 이벤트 id. **동일 계좌 + 동일 실효 거래일** 규칙을 한 곳에 못박아둔다. */
export function defaultEventId(accountId: string, eventDate: string): string {
  return `rev:${accountId}:${eventDate}`;
}

/** 사용자가 분리(split)로 만드는 새 이벤트 id. 기본 id 와 섞이지 않게 접미사를 붙인다. */
export function splitEventId(accountId: string, eventDate: string, seq: number): string {
  return `${defaultEventId(accountId, eventDate)}#${seq}`;
}

// ── 정정 overlay 적용 ───────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 원본 + 정정 → 유효 거래. **원본 객체를 변형하지 않는다.**
 * 정정이 없으면 `corrected: false` 이고 값은 원본 그대로다.
 */
export function effectiveTransaction(
  tx: LedgerTransaction,
  correction?: TransactionCorrection,
): EffectiveTransaction {
  const fields: string[] = [];
  let { quantity, price, amount, side, ticker, eventDate } = tx;

  if (correction) {
    if (isNum(correction.correctedQuantity) && correction.correctedQuantity !== quantity) {
      quantity = correction.correctedQuantity; fields.push("quantity");
    }
    if (isNum(correction.correctedPrice) && correction.correctedPrice !== price) {
      price = correction.correctedPrice; fields.push("price");
    }
    if (isNum(correction.correctedAmount) && correction.correctedAmount !== amount) {
      amount = correction.correctedAmount; fields.push("amount");
    }
    if (correction.correctedSide && correction.correctedSide !== side) {
      side = correction.correctedSide; fields.push("side");
    }
    if (correction.correctedTicker && correction.correctedTicker !== ticker) {
      ticker = correction.correctedTicker; fields.push("ticker");
    }
    if (correction.correctedTradeDate && correction.correctedTradeDate !== eventDate) {
      eventDate = correction.correctedTradeDate; fields.push("eventDate");
    }
    // 수량·단가만 고치고 금액을 안 고쳤다면 금액을 다시 계산한다 — 두 값이 어긋난 채로
    // 남으면 매수/매도 합계가 틀어진다. (금액을 직접 정정했으면 그 값을 존중한다.)
    if (!isNum(correction.correctedAmount)
      && (fields.includes("quantity") || fields.includes("price"))) {
      amount = Math.round(quantity * price);
    }
  }

  return {
    id: tx.id,
    accountId: tx.accountId,
    ticker,
    etfName: tx.etfName,
    side,
    quantity,
    price,
    amount,
    eventDate,
    corrected: fields.length > 0,
    excluded: correction?.excluded === true,
    correctedFields: fields,
  };
}

// ── 보유수량 재생 ───────────────────────────────────────────────────────────

const signedQty = (e: EffectiveTransaction): number =>
  e.side === "buy" ? e.quantity : -e.quantity;

/** 0 인 종목을 떨어낸 보유수량 사본 (전후 비교를 읽기 쉽게) */
function compactHoldings(h: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, q] of Object.entries(h)) if (q !== 0) out[t] = q;
  return out;
}

/**
 * 거래를 시간순으로 재생한 최종 보유수량 (계좌 → ticker → 수량).
 * import 검증(데이터셋 `validation.finalHoldings` 대조)과 화면 양쪽에서 쓴다.
 * 제외(excluded)된 거래는 반영하지 않는다.
 */
export function replayFinalHoldings(
  transactions: readonly LedgerTransaction[],
  corrections: ReadonlyMap<string, TransactionCorrection> = new Map(),
): Record<string, Record<string, number>> {
  const byAccount: Record<string, Record<string, number>> = {};
  for (const { effective: e } of sortedEffective(transactions, corrections)) {
    const acc = (byAccount[e.accountId] ??= {});
    acc[e.ticker] = (acc[e.ticker] ?? 0) + signedQty(e);
  }
  for (const id of Object.keys(byAccount)) byAccount[id] = compactHoldings(byAccount[id]);
  return byAccount;
}

// ── 중복 적재 방지: 체결의 안정적 신원 ─────────────────────────────────────
//
// 같은 원장에 미래에셋 Excel / KIS API / 수동 보정이 모두 들어온다. 같은 거래를 두 번
// 넣지 않으려면 파일 위치가 아니라 **그 체결 자체**를 가리키는 신원이 필요하다.
//
// **`sourceRow` 를 쓰지 않는 이유 (실측):** 미래에셋 export 는 둘 다 최신순이다 —
// DC 매매내역은 row 4 가 2026-10-01, row 456 이 2025-05-14 다. 거래가 하나 추가되면
// 기존 행 번호가 전부 밀리므로, 재export 한 같은 체결이 다른 번호를 받는다.
// 사용자가 직접 보완한 10 행은 `sourceRow` 가 아예 없기도 하다.
//
// **`occurrence`(동일건 순번)가 필요한 이유 (실측):** 내용이 완전히 같은 분할체결이
// 실제로 있다 — IRP 2026-03-25 에 `0072R0` 1주 매수 2건, 2026-08-28 에 `438080`
// 1주 매수 3건. 순번이 없으면 5건이 2건으로 뭉개진다.
//
// 해시가 아니라 **사람이 읽을 수 있는 문자열**로 둔다. DB 에서 눈으로 대조할 수 있고
// 해시 충돌을 걱정할 필요도 없다.

/** fingerprint 의 필드 구분자. 종목명·메모 같은 자유 문자열은 넣지 않으므로 충돌하지 않는다. */
const FP_SEP = "|";

/**
 * 지금 쓰는 fingerprint 생성 규칙의 버전.
 *
 * **규칙이 바뀌면 이 숫자를 올린다.** 앞으로 KIS API 처럼 다른 source 가 들어오면
 * 중복 판정에 쓸 수 있는 필드가 달라진다 — 예를 들어 KIS 는 주문번호/체결번호를 주므로
 * 내용 조합 대신 그 번호 하나로 신원을 잡는 편이 정확하다. 그때 v2 규칙을 추가한다.
 *
 * 버전은 **fingerprint 문자열 맨 앞에도 들어간다.** 그래서
 *   - 규칙이 달라진 두 신원이 **우연히 같은 문자열이 되는 일이 없고**,
 *   - DB 를 보면 어떤 규칙으로 만들어진 행인지 바로 알 수 있고,
 *   - 재적재 멱등성은 **같은 버전끼리만** 판정된다.
 *
 * 규칙을 바꿀 때의 절차(의도적으로 번거롭게 둔다):
 *   1. 새 버전 함수를 추가하고 `FINGERPRINT_VERSION` 을 올린다.
 *   2. 기존 행의 fingerprint 를 다시 계산해 넣는 마이그레이션을 쓴다
 *      (원장 자체는 immutable 이지만 **신원 컬럼 재계산은 내용 변경이 아니다** —
 *       같은 체결을 가리키는 이름만 바꾸는 것이다).
 *   3. 섞인 상태로 두지 않는다. 한 profile 안에 두 버전이 공존하면 같은 거래가
 *      다른 신원으로 두 번 들어갈 수 있다.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * 체결 1건의 안정적 신원 (v1 규칙).
 *
 * v1 = `v1 | source | 계좌 | 종목 | 매매구분 | 수량 | 단가 | 금액 | 거래일 | 결제일 | 순번`
 *
 * `occurrence` 는 **내용이 완전히 같은 체결들 사이의 순번**이다(0부터).
 * 한 건만 있으면 0 이고, 보통은 `assignFingerprints` 가 계산해 넣는다.
 */
export function transactionFingerprint(
  tx: Pick<LedgerTransaction,
    "source" | "accountId" | "ticker" | "side" | "quantity" | "price" | "amount"
    | "tradeDate" | "settlementDate">,
  occurrence = 0,
  version: number = FINGERPRINT_VERSION,
): string {
  return [
    `v${version}`,
    tx.source,
    tx.accountId,
    tx.ticker,
    tx.side,
    tx.quantity,
    tx.price,
    tx.amount,
    tx.tradeDate ?? "",
    tx.settlementDate ?? "",
    occurrence,
  ].join(FP_SEP);
}

/** fingerprint 문자열에서 생성 규칙 버전을 읽는다. 모양이 아니면 null. */
export function fingerprintVersionOf(fingerprint: string | undefined): number | null {
  const m = /^v(\d+)\|/.exec(fingerprint ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * 거래 목록에 fingerprint 를 채워 돌려준다. **입력 객체를 변형하지 않는다.**
 *
 * 내용이 같은 체결이 여러 건이면 순번을 0,1,2… 로 매긴다. 순번 순서는
 * `compareIntraDayOrder` 가 정하는 시간순이라 같은 입력에 대해 항상 같다.
 *
 * 한계(알고 쓴다): 증권사가 나중에 **같은 날 내용까지 똑같은 체결을 추가로** 내보내면
 * 그 그룹의 순번이 밀릴 수 있다. 그 경우 재적재는 조용히 중복을 만들지 않고 건수
 * 불일치로 드러난다 — import 리포트가 inserted/skipped 를 항상 같이 보여주는 이유다.
 */
export function assignFingerprints(
  transactions: readonly LedgerTransaction[],
): LedgerTransaction[] {
  const ordered = [...transactions].sort(
    (a, b) => a.eventDate.localeCompare(b.eventDate) || compareIntraDayOrder(a, b),
  );
  const seen = new Map<string, number>();
  const fpById = new Map<string, string>();
  for (const tx of ordered) {
    const base = transactionFingerprint(tx, 0);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    fpById.set(tx.id, transactionFingerprint(tx, n));
  }
  return transactions.map((tx) => ({
    ...tx,
    sourceFingerprint: fpById.get(tx.id)!,
    fingerprintVersion: FINGERPRINT_VERSION,
  }));
}

/** fingerprint 가 겹치는 거래들 (0건이어야 정상). 적재 전 게이트가 쓴다. */
export function findDuplicateFingerprints(
  transactions: readonly LedgerTransaction[],
): { fingerprint: string; ids: string[] }[] {
  const byFp = new Map<string, string[]>();
  for (const tx of transactions) {
    const fp = tx.sourceFingerprint;
    if (!fp) continue;
    byFp.set(fp, [...(byFp.get(fp) ?? []), tx.id]);
  }
  return [...byFp.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprint, ids]) => ({ fingerprint, ids }));
}

/**
 * 원본 파일의 행 번호(`sourceRow`)가 **같은 날 안에서** 어느 방향으로 시간순인가.
 *
 * 증권사는 체결 시각을 주지 않는다. 순서를 알 수 있는 유일한 단서가 원본 엑셀의 행
 * 번호인데, **export 마다 방향이 다르다.** 추측하지 않고 실측으로 확정했다:
 *
 *   - `miraeasset_transaction_history` (ISA·연금): **내림차순**.
 *     이 export 는 거래후잔고(`postQuantity`)를 같이 주므로 정답을 대조할 수 있다.
 *     내림차순이면 171건 전부 일치하고, 오름차순이면 51건이 어긋난다.
 *   - `miraeasset_retirement_web` (퇴직연금·IRP): **오름차순**.
 *     이쪽은 거래후잔고를 주지 않아 직접 대조할 수 없다. 대신 "보유하지 않은 수량을 팔 수
 *     없다"는 제약으로 가려진다 — 내림차순으로 재생하면 retirement/484790 이 2026-05-26 에
 *     -723 주가 된다(그 날 매수 689+34 와 매도 1381 의 순서가 뒤집히기 때문이다).
 *     오름차순이면 658 → 692 → 1381 → 0 으로 자연스럽게 이어지고 음수가 사라진다.
 *
 * 두 파일 모두 **날짜는 최신순**이지만 하루 안의 행 방향이 반대다. 그래서 파일 전체의
 * 방향 하나로 처리할 수 없고 source 별로 둔다.
 *
 * **새 source 를 추가할 때는 반드시 실측으로 방향을 정한다.** 기본값 `"asc"` 는 파일을
 * 위에서 아래로 읽는 자연스러운 순서일 뿐 검증된 값이 아니다 — 거래후잔고가 있으면
 * 그것으로, 없으면 음수 보유수량이 생기지 않는지로 확인한다
 * (verified-transactions.ts verifyDataset 이 두 검사를 모두 한다).
 */
export const INTRA_DAY_ROW_ORDER: Readonly<Record<string, "asc" | "desc">> = {
  miraeasset_retirement_web: "asc",
  miraeasset_transaction_history: "desc",
};

/**
 * **일중(같은 날) 거래 순서** 비교자.
 *
 * 이 순서가 맞아야 "이전 → 이후 보유수량"이 증권사가 보고한 거래후잔고와 일치하고
 * 음수 보유수량이 생기지 않는다. 방향은 `INTRA_DAY_ROW_ORDER` 가 source 별로 정한다.
 *
 * ── 반드시 **유효한 전순서(total order)** 여야 한다 ───────────────────
 *
 * 이것은 취향이 아니라 **실측으로 드러난 요구사항**이다. 예전 구현은 행 번호를
 * **계좌 구분 없이** 비교했다. 계좌마다 행 번호가 따로 매겨지므로 같은 날에 서로 다른
 * 계좌 거래가 있으면 의미 없는 숫자끼리 비교됐고, 한 정렬 안에 "행 번호 기준"과
 * "id 기준"이 섞여 **전이성이 깨졌다.** 실측 수치(463건 기준):
 *
 *   · 같은 event_date 에 2개 이상 계좌가 있는 날        12 / 39
 *   · 계좌가 다른데 행 번호로 비교되는 쌍              1,101
 *   · 전이성 위반 삼각형                              17,190
 *
 * `Array.prototype.sort` 는 비일관 비교자를 만나면 **입력 순서에 따라 다른 결과**를
 * 낸다. 데이터셋 파일 순서가 우연히 맞는 답을 주고 있었을 뿐이다 — DB 에서 읽은
 * 순서로는 postQuantity 불일치 12건, 무작위 순열에서는 최악 22건 + 음수 보유수량 5건이
 * 나왔다. Worker 는 `.order("event_date")` 만 걸어서 같은 날 안은 Postgres 가 임의
 * 순서로 준다 — 즉 UI 가 실행마다 다른 보유수량을 보일 수 있는 상태였다.
 *
 * 그래서 지금은 **사전식 전순서**다. 앞 키가 같을 때만 다음 키로 내려간다:
 *
 *   eventDate (호출하는 쪽에서 먼저 비교한다)
 *     → accountId      계좌가 다르면 행 번호를 비교할 근거가 없다
 *     → source         source 가 다르면 방향도 번호체계도 다르다
 *     → sourceRow      **같은 (계좌, source) 안에서만** 방향을 적용해 비교
 *     → id             deterministic tie-breaker
 *
 * **source 별 방향 규칙 자체는 하나도 바뀌지 않았다**(`INTRA_DAY_ROW_ORDER`).
 * 같은 계좌·같은 source 안의 순서는 예전과 동일하다. 달라진 것은 "비교할 근거가
 * 없는 쌍"을 명확히 분리해 전순서를 회복한 것뿐이다.
 *
 * `sourceRow` 가 없는 거래(사용자가 직접 보완한 행)는 그 (계좌, source) 그룹의
 * **마지막**에 두고 id 로 순서를 고정한다 — 추측으로 끼워 넣지 않되, 실행마다
 * 순서가 달라지지도 않게 한다.
 *
 * 순서 독립성은 `ledger-order.test.ts` 가 고정한다 — 같은 463건을 여러 입력 순서로
 * 넣어 line 단위까지 같은 결과가 나오는지 확인한다. 파일 순서 하나로만 테스트해서
 * 이 버그를 547건의 테스트가 못 잡았다.
 */
export function compareIntraDayOrder(a: LedgerTransaction, b: LedgerTransaction): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const ka = intraDayRowKey(a);
  const kb = intraDayRowKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 정렬 키로 쓰는 행 번호. **같은 (계좌, source) 안에서만 의미가 있다** —
 * 비교자가 그 둘을 먼저 걸러낸 뒤에만 이 키를 쓴다.
 *
 * `desc` source 는 부호를 뒤집어 **항상 오름차순 비교**로 만든다. 비교자 안에서
 * 방향에 따라 분기하면 위치에 따라 부호가 뒤집힐 수 있어 전순서가 깨지기 쉬우므로,
 * **키를 먼저 만들고 비교는 항상 같은 방향으로** 한다.
 *
 * `sourceRow` 가 없으면 +Infinity — 그룹의 마지막으로 간다. 둘 다 없으면 키가 같아져
 * id tie-breaker 로 내려간다.
 */
function intraDayRowKey(t: LedgerTransaction): number {
  const r = t.sourceRow ?? null;
  if (r === null) return Number.POSITIVE_INFINITY;
  return (INTRA_DAY_ROW_ORDER[t.source] ?? "asc") === "desc" ? -r : r;
}

/** 정정이 적용된 거래와 그 원본을 함께 들고 다닌다 (정렬에 원본의 sourceRow 가 필요하다). */
interface OrderedTransaction {
  tx: LedgerTransaction;
  effective: EffectiveTransaction;
}

/**
 * 유효 거래를 **시간순**으로 정렬한다. 날짜는 정정이 적용된 실효 거래일 기준이고,
 * 같은 날 안의 순서는 `compareIntraDayOrder` 가 정한다. 제외된 거래는 빠진다.
 */
function sortedEffective(
  transactions: readonly LedgerTransaction[],
  corrections: ReadonlyMap<string, TransactionCorrection>,
): OrderedTransaction[] {
  return transactions
    .map((tx) => ({ tx, effective: effectiveTransaction(tx, corrections.get(tx.id)) }))
    .filter((o) => !o.effective.excluded)
    .sort((a, b) =>
      a.effective.eventDate.localeCompare(b.effective.eventDate)
      || compareIntraDayOrder(a.tx, b.tx));
}

// ── 이벤트 구성 ─────────────────────────────────────────────────────────────

export interface ResolveEventsInput {
  transactions: readonly LedgerTransaction[];
  /** 사용자 정정 overlay */
  corrections?: readonly TransactionCorrection[];
  /** 소속 이벤트 재지정 (병합 / 분리 / 이동) */
  overrides?: readonly EventOverride[];
  /** 저장된 이벤트 행 (메모·태그·숨김·타입). 없는 이벤트는 기본값으로 만들어진다. */
  events?: readonly RebalanceEventRow[];
}

/**
 * 원장 + overlay → 화면에 보여줄 이벤트 목록 (날짜 내림차순, 최신 먼저).
 *
 * 보유수량 "이전 → 이후"는 **계좌별 전체 재생**으로 구한다. 이벤트 하나만 떼어 보면
 * 그 앞의 보유수량을 알 수 없기 때문이다. 제외된 거래는 재생에도 들어가지 않는다.
 */
export function resolveEvents(input: ResolveEventsInput): ResolvedEvent[] {
  const corrections = new Map((input.corrections ?? []).map((c) => [c.transactionId, c]));
  const overrides = new Map((input.overrides ?? []).map((o) => [o.transactionId, o.eventId]));
  const eventRows = new Map((input.events ?? []).map((e) => [e.id, e]));

  // 계좌별 시간순 재생 — 각 거래의 before/after 를 여기서 확정한다.
  const running: Record<string, Record<string, number>> = {};
  const lineByTxId = new Map<string, EventTransactionLine>();

  for (const { tx, effective: e } of sortedEffective(input.transactions, corrections)) {
    const acc = (running[e.accountId] ??= {});
    const before = acc[e.ticker] ?? 0;
    const delta = signedQty(e);
    const after = before + delta;
    acc[e.ticker] = after;
    lineByTxId.set(e.id, {
      transaction: tx,
      effective: e,
      beforeQuantity: before,
      deltaQuantity: delta,
      afterQuantity: after,
      // 증권사가 보고하지 않았으면 대조할 수 없다 — "불일치 아님"이 아니라 null 이다.
      postQuantityMismatch: tx.postQuantity === null || tx.postQuantity === undefined
        ? null
        : tx.postQuantity !== after,
    });
  }

  // 이벤트별로 묶는다. 소속은 override ?? 기본 grouping.
  interface Bucket { id: string; lines: EventTransactionLine[]; regrouped: boolean }
  const buckets = new Map<string, Bucket>();
  for (const [txId, line] of lineByTxId) {
    const e = line.effective;
    const fallback = defaultEventId(e.accountId, e.eventDate);
    const eventId = overrides.get(txId) ?? fallback;
    const b = buckets.get(eventId) ?? { id: eventId, lines: [], regrouped: false };
    b.lines.push(line);
    if (eventId !== fallback) b.regrouped = true;
    buckets.set(eventId, b);
  }

  const out: ResolvedEvent[] = [];
  for (const bucket of buckets.values()) {
    // 이벤트 안에서도 시간순 — 상세 화면의 "이전 → 이후" 사슬이 이어져 보이게 한다.
    const lines = [...bucket.lines].sort(
      (a, b) => a.effective.eventDate.localeCompare(b.effective.eventDate)
        || compareIntraDayOrder(a.transaction, b.transaction),
    );
    const row = eventRows.get(bucket.id);
    const accountId = row?.accountId ?? lines[0].effective.accountId;
    const dates = lines.map((l) => l.effective.eventDate);
    const date = dates.reduce((a, b) => (a < b ? a : b));
    const dateEnd = dates.reduce((a, b) => (a > b ? a : b));

    let buyAmount = 0, sellAmount = 0;
    const pre: Record<string, number> = {};
    const post: Record<string, number> = {};
    const buyByEtf = new Map<string, number>();
    // **종목 수**다 — 체결 건수가 아니다. 화면이 "매수 N종목"으로 읽히므로
    // 같은 종목을 하루에 여러 번 사면 1로 센다. 체결 건수는 tradeCount 에 있다.
    // (실제 예: 2026-08-28 퇴직연금은 매수 체결 14건이지만 종목은 5개다.)
    const buyTickers = new Set<string>();
    const sellTickers = new Set<string>();

    for (const l of lines) {
      if (l.effective.side === "buy") {
        buyTickers.add(l.effective.ticker); buyAmount += l.effective.amount;
        buyByEtf.set(l.effective.etfName, (buyByEtf.get(l.effective.etfName) ?? 0) + l.effective.amount);
      } else {
        sellTickers.add(l.effective.ticker); sellAmount += l.effective.amount;
      }
      const t = l.effective.ticker;
      // 한 이벤트에서 같은 종목을 여러 번 거래하면 **처음 before** 와 **마지막 after** 가
      // 그 이벤트의 전후 수량이다.
      if (!(t in pre)) pre[t] = l.beforeQuantity;
      post[t] = l.afterQuantity;
    }

    // 거래가 없던 종목도 전후에 그대로 있어야 "포트폴리오가 어떻게 변했는가"가 보인다 —
    // 다만 이 이벤트가 건드리지 않은 종목은 양쪽에 똑같이 들어가므로 여기서는 생략하고,
    // 상세 화면이 필요하면 replay 결과를 따로 받는다(추정을 섞지 않기 위해).
    const evidence = [...new Set(lines.map((l) => l.transaction.tradeDateEvidence))].sort();
    const topEtfNames = [...buyByEtf.entries()]
      .sort((a, b) => b[1] - a[1]).map(([name]) => name);
    // 매수가 하나도 없으면(전량매도 등) 매도 종목을 주요 종목으로 쓴다.
    const fallbackNames = [...new Set(lines.map((l) => l.effective.etfName))];

    out.push({
      id: bucket.id,
      accountId: accountId as AccountId,
      date,
      dateEnd,
      type: row?.type ?? "rebalance",
      strategyIncluded: row?.strategyIncluded ?? true,
      memo: row?.memo ?? "",
      tags: row?.tags ?? [],
      hidden: row?.hidden ?? false,
      isUserCreated: row?.isUserCreated ?? false,
      regrouped: bucket.regrouped,
      dateEvidence: evidence,
      lines,
      tradeCount: lines.length,
      buyCount: buyTickers.size,
      sellCount: sellTickers.size,
      buyAmount,
      sellAmount,
      netAmount: buyAmount - sellAmount,
      preHoldings: compactHoldings(pre),
      postHoldings: compactHoldings(post),
      topEtfNames: topEtfNames.length ? topEtfNames : fallbackNames,
    });
  }

  return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

// ── 목록 화면 필터 / 검색 ───────────────────────────────────────────────────

export interface EventFilter {
  /** YYYY-MM-DD (포함) */
  from?: string;
  to?: string;
  accountIds?: readonly string[];
  /** ticker 또는 ETF명 */
  tickers?: readonly string[];
  /** "buy" 면 매수가 있는 이벤트만, "sell" 이면 매도가 있는 이벤트만 */
  side?: TradeSide;
  types?: readonly string[];
  tags?: readonly string[];
  /** ETF명 / 종목코드 / 메모 / 태그 부분일치 (대소문자 무시) */
  query?: string;
  /** 숨긴 이벤트도 포함할 것인가 (기본 false — 숨김은 삭제가 아니라 가려두는 것이다) */
  includeHidden?: boolean;
  /** 전략 성과에 포함되는 이벤트만 */
  strategyOnly?: boolean;
}

export function filterEvents(
  events: readonly ResolvedEvent[],
  f: EventFilter = {},
): ResolvedEvent[] {
  const q = f.query?.trim().toLowerCase() ?? "";
  const accounts = f.accountIds?.length ? new Set(f.accountIds) : null;
  const tickers = f.tickers?.length
    ? new Set(f.tickers.map((t) => t.toLowerCase()))
    : null;
  const types = f.types?.length ? new Set(f.types) : null;
  const tags = f.tags?.length ? new Set(f.tags) : null;

  return events.filter((e) => {
    if (!f.includeHidden && e.hidden) return false;
    if (f.strategyOnly && !e.strategyIncluded) return false;
    // 병합으로 날짜 범위가 생긴 이벤트는 범위가 조금이라도 걸치면 포함한다.
    if (f.from && e.dateEnd < f.from) return false;
    if (f.to && e.date > f.to) return false;
    if (accounts && !accounts.has(e.accountId)) return false;
    if (types && !types.has(e.type)) return false;
    if (tags && !e.tags.some((t) => tags.has(t))) return false;
    if (f.side === "buy" && e.buyCount === 0) return false;
    if (f.side === "sell" && e.sellCount === 0) return false;
    if (tickers && !e.lines.some((l) =>
      tickers.has(l.effective.ticker.toLowerCase())
      || tickers.has(l.effective.etfName.toLowerCase()))) return false;
    if (q) {
      const hay = [
        e.memo, e.id, e.type, ...e.tags,
        ...e.lines.flatMap((l) => [l.effective.etfName, l.effective.ticker]),
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 필터 UI 의 선택지 — 지금 데이터에 실제로 존재하는 값만 보여주기 위해. */
export function eventFacets(events: readonly ResolvedEvent[]): {
  accountIds: string[];
  types: string[];
  tags: string[];
  etfNames: string[];
} {
  const accountIds = new Set<string>();
  const types = new Set<string>();
  const tags = new Set<string>();
  const etfNames = new Set<string>();
  for (const e of events) {
    accountIds.add(e.accountId);
    types.add(e.type);
    e.tags.forEach((t) => tags.add(t));
    e.lines.forEach((l) => etfNames.add(l.effective.etfName));
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    accountIds: sorted(accountIds),
    types: sorted(types),
    tags: sorted(tags),
    etfNames: sorted(etfNames),
  };
}

// ── 과거 시점 평가 ──────────────────────────────────────────────────────────

/**
 * 이벤트 직후 포트폴리오 평가액 = Σ(그 시점 보유수량 × **그 날 종가**).
 *
 * **현재 가격을 쓰지 않는다.** 그리고 가격이 없는 종목이 하나라도 있으면 금액을 만들지
 * 않고 `null` 을 돌려준다 (snapshot.ts / historical-performance.ts 와 같은 fail-closed
 * 규칙). 일부만 평가한 금액은 그 시점 포트폴리오를 틀리게 말한다.
 *
 * 이벤트의 postHoldings 는 그 이벤트가 건드린 종목만 담고 있으므로, 계좌 전체 평가가
 * 필요하면 `holdings` 에 그 시점 **계좌 전체** 보유수량을 넘긴다.
 */
export function valuateHoldings(
  holdings: Readonly<Record<string, number>>,
  priceByTicker: Readonly<Record<string, number>>,
): { value: number; missing: string[] } | null {
  let value = 0;
  const missing: string[] = [];
  for (const [ticker, qty] of Object.entries(holdings)) {
    if (!(qty > 0)) continue;
    const p = priceByTicker[ticker];
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) { missing.push(ticker); continue; }
    value += qty * p;
  }
  if (missing.length) return null;
  return { value: Math.round(value), missing };
}

/**
 * 어떤 시점의 **계좌 전체** 보유수량 (그 날짜까지의 거래를 재생).
 * 이벤트 상세에서 "이 계좌 전체가 어떻게 변했는가"를 보여줄 때 쓴다.
 */
export function holdingsAsOf(
  transactions: readonly LedgerTransaction[],
  accountId: string,
  date: string,
  corrections: ReadonlyMap<string, TransactionCorrection> = new Map(),
): Record<string, number> {
  const h: Record<string, number> = {};
  for (const { effective: e } of sortedEffective(transactions, corrections)) {
    if (e.accountId !== accountId) continue;
    if (e.eventDate > date) break;
    h[e.ticker] = (h[e.ticker] ?? 0) + signedQty(e);
  }
  return compactHoldings(h);
}
