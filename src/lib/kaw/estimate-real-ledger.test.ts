// 실제 연금저축 원장(저장소의 검증 데이터셋) + 2026-10-02 / 10-13 / 10-14 운영 원장 행으로
// 추정 청산 provenance 를 검증한다.
//
// 10-02 미래에셋 체결 6건, 10-13 사용자 승인 가격 대용 청산 2건, 10-14 한국투자 확정 매수 2건의 값은
// 이전 조사(운영 원장 SELECT)에서 확인한 값을 그대로 옮긴 fixture 다. 이 테스트는 DB 에 접근하지 않는다.
//
// 현금 모델이 어떤 절대값을 내는지는 단정하지 않는다(운영 cashflow 와 데이터셋의 verified cashflow 가 같다는 보증이 없다).
// 거래가 만드는 **차이**와 provenance 판정만 고정한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVerifiedDataset } from "./verified-transactions";
import type { LedgerTransaction } from "./ledger";
import { verifiedCashflowsFor } from "./verified-cashflows";
import { buildDerivedCash } from "./derived-cash";
import { cashErrorCancels } from "./profit-analysis";
import { estimatedExitDays } from "./estimate-provenance";

const dataset = parseVerifiedDataset(
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../data/verified-transactions.v1.json"), "utf-8")),
);
const earlier = (dataset.transactions as LedgerTransaction[]).filter(
  (t) => t.accountId === "pension" && t.eventDate <= "2026-10-01",
);

const MIRAE = "miraeasset_capture_qty_price_reconstructed";
const PROXY = "user_attested_liquidation_price_proxy";
const KIS = "kis_api_daily_ccld";
const row = (o: Partial<LedgerTransaction> & Pick<LedgerTransaction, "id" | "ticker" | "side" | "quantity" | "price" | "amount" | "eventDate" | "source">): LedgerTransaction => ({
  accountId: "pension", etfName: o.ticker, tradeDate: null, settlementDate: null, inferredTradeDate: null,
  tradeDateEvidence: "broker-order-date", fee: null, tax: null, postQuantity: null, ...o,
});

const prod: LedgerTransaction[] = [
  // 10-02 미래에셋 (체결일 보고 없음, 결제 10-07, 거래 후 보유수량 미보고)
  row({ id: "m1", ticker: "0167A0", side: "sell", quantity: 160, price: 19440, amount: 3_110_400, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  row({ id: "m2", ticker: "0181B0", side: "sell", quantity: 252, price: 10470, amount: 2_638_440, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  row({ id: "m3", ticker: "0181B0", side: "sell", quantity: 38, price: 10495, amount: 398_810, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  row({ id: "m4", ticker: "360750", side: "buy", quantity: 122, price: 25890, amount: 3_158_580, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  row({ id: "m5", ticker: "360750", side: "buy", quantity: 35, price: 25910, amount: 906_850, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  row({ id: "m6", ticker: "367380", side: "buy", quantity: 81, price: 31660, amount: 2_564_460, eventDate: "2026-10-02", source: MIRAE, settlementDate: "2026-10-07" }),
  // 10-13 사용자 승인 전량 청산 — 가격 대용(10-02 가격), 실제 매도일 미확인
  row({ id: "p1", ticker: "367380", side: "sell", quantity: 81, price: 31660, amount: 2_564_460, eventDate: "2026-10-13", source: PROXY, tradeDateEvidence: "user-attested-full-liquidation; exact-sale-date-unknown; 2026-10-13=transfer-accounting-anchor; 2026-10-02-price-proxy", postQuantity: 0 }),
  row({ id: "p2", ticker: "360750", side: "sell", quantity: 297, price: 25910, amount: 7_695_270, eventDate: "2026-10-13", source: PROXY, tradeDateEvidence: "user-attested-full-liquidation; exact-sale-date-unknown; 2026-10-13=transfer-accounting-anchor; 2026-10-02-price-proxy", postQuantity: 0 }),
  // 10-14 한국투자 확정 체결
  row({ id: "k1", ticker: "367380", side: "buy", quantity: 64, price: 31220, amount: 1_998_080, eventDate: "2026-10-14", source: KIS, tradeDate: "2026-10-14" }),
  row({ id: "k2", ticker: "360750", side: "buy", quantity: 230, price: 25985, amount: 5_976_550, eventDate: "2026-10-14", source: KIS, tradeDate: "2026-10-14" }),
];
const all = [...earlier, ...prod];

const weekdays: string[] = [];
for (let t = Date.parse("2025-01-01"); t <= Date.parse("2026-12-31"); t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() % 6) weekdays.push(d.toISOString().slice(0, 10));
}
const derived = buildDerivedCash({
  flows: verifiedCashflowsFor("pension").map((f) => ({ date: f.date, amount: f.amount, timing: f.timing })),
  trades: all.map((t) => ({ date: t.eventDate, side: t.side, amount: t.amount, fee: t.fee, tax: t.tax })),
  tradingDates: weekdays,
});
const dv = (d: string) => derived.byDate.get(d)!.derived;

describe("실제 연금저축 원장 — 추정 청산 provenance", () => {
  const est = estimatedExitDays(all);

  it("추정 청산은 10-13 하나뿐이다. 미래에셋 10-02 체결과 한국투자 10-14 확정 매수는 추정으로 격하되지 않는다", () => {
    expect(est).toHaveLength(1);
    expect(est[0]).toMatchObject({ accountId: "pension", date: "2026-10-13" });
    expect(est[0].reasons).toEqual(["exit_price_proxy", "exit_date_unconfirmed"]);
  });

  it("불확실 창의 시작은 매도 종목의 보유를 확인한 거래에서 나온다 — 계좌의 아무 거래(예: 다른 종목 10-02 매도)가 아니다", () => {
    // 10-02 거래 후 보유수량(postQuantity)이 보고되지 않았으므로 10-02 종가 보유는 입증되지 않는다 → 창은 10-02 부터
    expect(est[0].windowStart).toBe("2026-10-02"); // 실제 원장 재생: 10-02 거래 직후 보유가 매도 수량(297/81) 이상
    // 다른 종목(0167A0·0181B0 매도)만으로는 창이 좁아지지 않는다: 그 거래들을 빼도 시작점은 같거나 더 이르다
    const onlyOtherTickers = estimatedExitDays([...earlier.filter((t) => t.eventDate < "2026-10-02"), ...prod.filter((t) => ["p1", "p2"].includes(t.id))]);
    expect(onlyOtherTickers[0].windowStart === null || onlyOtherTickers[0].windowStart <= est[0].windowStart!).toBe(true);
  });

  it("거래가 파생 예수금에 만드는 차이: 10-13 추정 대금 +10,259,730, 10-14 확정 매수 −7,974,630", () => {
    expect(dv("2026-10-13") - dv("2026-10-02")).toBe(2_564_460 + 7_695_270);
    expect(dv("2026-10-13") - dv("2026-10-14")).toBe(1_998_080 + 5_976_550);
  });

  it("10-14 일간은 청산 뒤 새 현금 최저점이 생기므로 손익 상쇄를 입증할 수 없다 (참고값)", () => {
    expect(dv("2026-10-14")).toBeLessThan(dv("2026-10-13"));
    expect(cashErrorCancels(derived, "2026-10-14", "2026-10-13", "2026-10-14", "2026-10-14")).toBe(false);
  });

  it("원장 cutoff(10-14) 뒤 구간(일간·월간·연간)은 입증된다 — 현금이 c = c_prev + f − spend 로만 움직인다", () => {
    expect(cashErrorCancels(derived, "2026-10-14", "2026-10-13", "2026-10-15", "2026-10-15")).toBe(true);
    expect(cashErrorCancels(derived, "2026-10-14", "2026-10-13", "2026-11-02", "2026-11-30")).toBe(true);
    expect(cashErrorCancels(derived, "2026-10-14", "2026-10-13", "2027-01-04", "2027-12-30")).toBe(true);
  });
});
