// ─────────────────────────────────────────────────────────────────────────────
// v1 → v2 데이터셋 생성기 (재현 가능)
//
//   node scripts/build-ledger-v2.mjs            # data/verified-transactions.v2.json 생성
//   node scripts/build-ledger-v2.mjs --check    # 생성물이 현재 파일과 같은지만 확인
//
// ## 왜 v1 을 고치지 않는가
//
// `data/verified-transactions.v1.json` 은 production 에 들어간 **463건 import 의 재현
// 가능한 원본**이다. 한 글자라도 고치면 "그때 무엇을 넣었는가"를 더 이상 말할 수 없다.
// 그래서 v1 은 immutable baseline 으로 두고, 추가분은 v2 에 **v1 전체 + 증분**으로 담는다.
// v2 는 v1 을 읽어서 만들어지므로 둘의 관계가 코드로 고정된다.
//
// ## dataset version ≠ schema version
//
//   - `schemaVersion: 1`  — **파일 구조**. 필드가 하나도 바뀌지 않았으므로 1 그대로다.
//     파서(`verified-transactions.ts`)는 이 값만 본다.
//   - `datasetVersion: 2` — **내용 세대**. 어떤 거래 집합인지를 가리킨다.
//     파서가 모르는 필드라 무시되고, 사람이 파일을 식별하는 용도다.
//
// 둘을 한 숫자로 합치지 않는다 — 구조를 안 바꾸고 내용만 늘리는 일이 앞으로도 반복된다.
//
// ## 증분 6건의 성격 (중요)
//
// 미래에셋 MTS 거래내역 화면 캡처에서 **직접 읽은 사실**은 결제일 / 종목 / 매매구분 /
// 거래금액 / "세금+수수료" / 예수금잔액뿐이다. **수량과 체결단가는 화면에 없다.**
//
// 아래 값들은 다음 세 조건으로 후보가 **하나만 남은 복원값**이다:
//   (a) 거래금액 = 수량 × 단가 의 정수 분해
//   (b) 단가가 그 날(2026-10-02) 실제 시장 저가~고가 범위 안
//   (c) 직전 보유수량(v1 재생) / 직후 보유수량(production rowQuantitiesSnap) 과 정합
//
// 근거가 매우 강하지만 **증권사가 보고한 값이 아니다.** 그래서 `source` 이름 자체에
// qty_price_reconstructed 를 박아 DB 행만 봐도 성격을 알 수 있게 한다
// (`source` 는 fingerprint 구성요소이기도 해서 신원에도 남는다).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const V1 = resolve(process.cwd(), "data/verified-transactions.v1.json");
const V2 = resolve(process.cwd(), "data/verified-transactions.v2.json");

/** 복원 거래의 source. 기존 두 source 와 섞이지 않는다. */
const SOURCE = "miraeasset_capture_qty_price_reconstructed";
/** 체결일 근거. 기존 tplus2-weekday-inference 와 **반드시** 구분된다 — 아래 주석 참고. */
const EVIDENCE = "tplus2-krx-trading-calendar-holiday-adjusted";
const SOURCE_FILE = "miraeasset_mts_transaction_history_pension_20261009_capture";

// 결제일 2026-10-07 → 실제 거래가능일 역산.
//   단순 평일 T+2 는 10-05(월) 를 내놓지만 **그 날은 장이 열리지 않았다**
//   (개천절 10-03 토요일의 대체공휴일). 네이버 일봉에 10-05 가 아예 없다:
//   … 10-01, 10-02, 10-06, 10-07 …
//   거래일 기준으로 2영업일 전 = 10-02(금). eventDate 는 이 값이다.
const EVENT_DATE = "2026-10-02";
const SETTLEMENT = "2026-10-07";

// 화면 표시 순서(최신 위) 그대로의 행 번호. 6건 모두 같은 날이라 일중 순서는
// 결과에 영향이 없다(verify 스크립트가 모든 순열에서 같은 결과임을 확인한다).
const SUPPLEMENTAL = [
  { row: 1, ticker: "367380", etfName: "ACE 미국나스닥100", side: "buy", quantity: 81, price: 31660, amount: 2564460, fee: 93 },
  { row: 2, ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 35, price: 25910, amount: 906850, fee: 33 },
  { row: 3, ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 122, price: 25890, amount: 3158580, fee: 114 },
  { row: 4, ticker: "0181B0", etfName: "HANARO 미국AI메모리반도체TOP4+", side: "sell", quantity: 38, price: 10495, amount: 398810, fee: 14 },
  { row: 5, ticker: "0181B0", etfName: "HANARO 미국AI메모리반도체TOP4+", side: "sell", quantity: 252, price: 10470, amount: 2638440, fee: 96 },
  { row: 6, ticker: "0167A0", etfName: "SOL AI반도체TOP2플러스", side: "sell", quantity: 160, price: 19440, amount: 3110400, fee: 113 },
];

// ── 거래 id ─────────────────────────────────────────────────────────────────
//
// v1 의 vtx:<16hex> 를 만든 변환 스크립트는 이 저장소에 없다(외부 1회성 변환이었다).
// 그래서 **같은 해시 함수를 복원하려 하지 않고**, 내용에서 결정적으로 나오는 새 id 를
// 만든다. 요구되는 성질은 두 가지뿐이다: (1) 같은 입력 → 같은 id, (2) 기존 463건과 충돌 없음.
// 둘 다 verify 스크립트가 검사한다.
function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const B = 0x100000001b3n;
  const M = (1n << 64n) - 1n;
  for (const b of new TextEncoder().encode(s)) h = ((h ^ BigInt(b)) * B) & M;
  return h.toString(16).padStart(16, "0");
}
const idOf = (t) => `vtx:${fnv1a64([
  SOURCE, "pension", t.ticker, t.side, t.quantity, t.price, t.amount, EVENT_DATE, SETTLEMENT, t.row,
].join("|"))}`;

export function buildV2Text() {
  const v1 = JSON.parse(readFileSync(V1, "utf-8"));

  const added = SUPPLEMENTAL.map((t) => ({
    id: idOf(t),
    account: "pension",
    ticker: t.ticker,
    etfName: t.etfName,
    side: t.side,
    quantity: t.quantity,
    price: t.price,
    amount: t.amount,
    // 캡처는 결제일만 보여준다. 체결일은 직접 사실이 아니므로 tradeDate 에 적지 않고
    // inferredTradeDate 에만 둔다 — v1 의 isa/pension 행들과 같은 규칙이다.
    tradeDate: null,
    settlementDate: SETTLEMENT,
    inferredTradeDate: EVENT_DATE,
    eventDate: EVENT_DATE,
    tradeDateEvidence: EVIDENCE,
    // 캡처의 "세금+수수료" 합산값. 분리하지 않는다 — tax=0 근거는 sourceNotes 참고.
    fee: t.fee,
    tax: 0,
    // 증권사가 거래후잔고를 보여주지 않았다. 재생값으로 메우지 않는다.
    postQuantity: null,
    source: SOURCE,
    sourceFile: SOURCE_FILE,
    sourceRow: t.row,
  }));

  const buys = added.filter((t) => t.side === "buy");
  const sells = added.filter((t) => t.side === "sell");

  const event = {
    id: `rev:pension:${EVENT_DATE}`,
    account: "pension",
    date: EVENT_DATE,
    type: "rebalance",
    strategyIncluded: true,
    transactionIds: added.map((t) => t.id),
    tradeCount: added.length,
    buyCount: buys.length,
    sellCount: sells.length,
    buyAmount: buys.reduce((s, t) => s + t.amount, 0),
    sellAmount: sells.reduce((s, t) => s + t.amount, 0),
    preHoldings: { "360750": 140, "0167A0": 160, "0181B0": 290 },
    postHoldings: { "360750": 297, "367380": 81 },
    dateEvidence: [EVIDENCE],
  };

  const transactions = [...v1.transactions, ...added];
  const rebalanceEvents = [...v1.rebalanceEvents, event];
  const accounts = ["retirement", "isa", "pension", "irp"];

  const out = {
    schemaVersion: v1.schemaVersion, // 구조 동일 → 1 유지
    datasetVersion: 2, // 내용 세대. 파서는 보지 않는다.
    basedOn: "verified-transactions.v1.json",
    purpose: v1.purpose,
    strategyStartDates: v1.strategyStartDates,
    datePolicy: {
      ...v1.datePolicy,
      krxTradingCalendar:
        "T+2 inference must skip non-trading days. 2026-10-05 was a substitute holiday "
        + "(National Foundation Day fell on Saturday 2026-10-03), so settlement 2026-10-07 "
        + "maps back to trade date 2026-10-02, not 2026-10-05. Verified against KRX daily "
        + "bars: no 2026-10-05 bar exists for 360750 / 367380 / 0167A0 / 0181B0.",
    },
    tickerMap: { ...v1.tickerMap, "ACE 미국나스닥100": "367380" },
    transactions,
    rebalanceEvents,
    validation: {
      transactionCount: transactions.length,
      eventCount: rebalanceEvents.length,
      accountTransactionCounts: Object.fromEntries(
        accounts.map((a) => [a, transactions.filter((t) => t.account === a).length]),
      ),
      accountEventCounts: Object.fromEntries(
        accounts.map((a) => [a, rebalanceEvents.filter((e) => e.account === a).length]),
      ),
      finalHoldings: {
        ...v1.validation.finalHoldings,
        pension: { "360750": 297, "367380": 81 },
      },
      // 외부 입출금은 이번 증분으로 바뀌지 않는다 (분배금·예탁금이용료는 원금이 아니다).
      cashflowPrincipalChecksums: v1.validation.cashflowPrincipalChecksums,
    },
    sourceNotes: [
      ...v1.sourceNotes,
      "v2 adds 6 pension transactions (settlement 2026-10-07 / trade 2026-10-02) absent from v1. The 463 v1 rows are carried over unchanged.",
      "Those 6 rows come from a Mirae Asset MTS transaction-history screen capture. Directly observed: settlement date, instrument, buy/sell, transaction amount, combined tax+fee, cash balance. NOT observed: quantity, execution price, trade date.",
      "quantity/price are uniquely reconstructed, not broker-reported: integer factorisation of the amount, constrained to that instrument's 2026-10-02 low~high range, cross-checked against pre-trade holdings replayed from v1 and post-trade holdings in the production 2026-10-02 rowQuantitiesSnap. Exactly one candidate survived per row.",
      "tax=0 on the 6 rows is evidenced, not assumed: all 171 existing miraeasset_transaction_history rows (ISA 85 + pension 86) carry tax=0; domestic ETF trades in a pension-savings account incur no securities transaction tax; and the cost ratio of the 6 rows (3.51e-5 ~ 3.64e-5) sits inside the band spanned by existing pension BUY rows, which can carry no tax at all. The capture's single combined tax+fee column is therefore stored whole in `fee` and never split by estimation.",
      "postQuantity is left null on the 6 rows — the capture reports no post-trade balance and it is not backfilled from replay.",
      "2026-08-04 ETF distribution 9,768 and 2026-07-10 / 2026-10-08 deposit interest 291 / 765 are account-internal income, not external cashflow. They are deliberately absent from verified-cashflows.ts.",
    ],
  };

  return `${JSON.stringify(out, null, 1)}\n`;
}

// 직접 실행일 때만 파일을 쓴다 (verify 스크립트는 buildV2Text 만 import 한다).
// Windows 경로 때문에 import.meta.url 문자열 비교는 쓰지 않는다 — 파일명으로 판정한다.
if ((process.argv[1] ?? "").endsWith("build-ledger-v2.mjs")) {
  const text = buildV2Text();
  if (process.argv.includes("--check")) {
    const same = readFileSync(V2, "utf-8") === text;
    console.log(same ? "✓ v2 파일 = 생성 결과" : "✗ v2 파일이 생성 결과와 다르다");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(V2, text);
  console.log(`wrote ${V2}`);
}
