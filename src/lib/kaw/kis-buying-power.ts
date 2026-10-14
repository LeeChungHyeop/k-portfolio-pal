// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 매수가능조회 (server-only, 읽기 전용)
//
//   GET /uapi/domestic-stock/v1/trading/inquire-psbl-order   TR_ID TTTC8908R
//
// **조회다. 주문이 아니다.** 이 이름은 "주문가능"을 묻는 조회 API 이고(공식 예제
// `inquire_psbl_order`), 주문을 만들거나 예약하지 않는다. 그래도 order 계열 경로 이름이라
// 조회 어댑터(`kis-account-server.ts`)의 "주문 경로 문자열 없음" 불변식을 흐리지 않도록
// **이 파일에 따로 둔다.**
//
// ── 실증된 사실 (2026-10-14, 연금저축 22, 사용자 승인 하에 1회 조회) ──────────
//
//   · 22 에서 정상 응답한다 (HTTP 200 / rt_cd 0 / KIOK0510)
//   · `nrcvb_buy_amt`(미수없는매수금액) 가 한투 앱의 "주문가능원화"와 **정확히 일치**했다
//   · `ord_psbl_cash`(주문가능현금)는 예수금 쪽 값이었다
//   · 지정가(ORD_DVSN=00)로 조회하면 `psbl_qty_calc_unpr` 가 입력한 단가와 같았다
//
// **관측된 비율을 규칙으로 쓰지 않는다.** 응답 안에서 `nrcvb_buy_amt ≈ ord_psbl_cash/1.005`
// 가 관측됐지만, 그것이 수수료인지 증거금인지 여유율인지, 종목·주문구분마다 같은지 공식
// 문서로 확인되지 않았다. 그래서 이 모듈은 **어떤 비율도 계산에 쓰지 않고** 증권사가 돌려준
// 금액을 그대로 쓴다 — 우리 쪽에서 0.5% 를 다시 빼지 않는 이유도 "증권사 값이 이미
// 주문 가능 금액이기 때문"이지 0.5% 라는 규칙을 안다고 가정해서가 아니다.
// ─────────────────────────────────────────────────────────────────────────────

import {
  kisAuthorizedGet,
  parseKisNumber,
  toReadResult,
  type KisAccountCredentials,
  type KisAccountReadResult,
} from "./kis-account-server";

export const KIS_PATH_INQUIRE_PSBL_ORDER = "/uapi/domestic-stock/v1/trading/inquire-psbl-order";
export const TR_ID_INQUIRE_PSBL_ORDER = "TTTC8908R";

/** 주문구분. 매수가능조회에서는 **지정가(00)와 시장가(01)만** 쓴다. */
export type PsblOrderDvsn = "00" | "01";

export interface BuyingPowerQuery {
  ticker: string;
  /** 조회에 넣은 단가(지정가) */
  unitPrice: number;
  ordDvsn: PsblOrderDvsn;
}

export interface BuyingPowerResult extends KisAccountReadResult {
  ticker: string;
  unitPrice: number;
  ordDvsn: PsblOrderDvsn;
  /** 주문가능현금. 모르면 null (0 이 아니다) */
  ordPsblCash: number | null;
  /** 미수없는매수금액 — 주문가능금액으로 쓰는 값 */
  nrcvbBuyAmt: number | null;
  nrcvbBuyQty: number | null;
  maxBuyAmt: number | null;
  maxBuyQty: number | null;
  /** 증권사가 수량 계산에 쓴 단가. 입력 단가와 다르면 이 조회는 그 가격의 근거가 아니다 */
  psblQtyCalcUnpr: number | null;
  ruseAmt: number | null;
}

const TICKER_RE = /^[A-Z0-9]{6}$/;

/**
 * 한 종목·한 단가의 매수가능금액/수량. **GET 1회.** 실패는 throw 하지 않고 `ok:false` 로
 * 돌려준다 — 값이 없는 필드는 null 이고 0 으로 채우지 않는다.
 *
 * 계좌 상품코드는 호출자가 정한다. 이 모듈은 22 에서만 실증됐다 — 29(IRP)는 연금 전용
 * API(TTTC0503R)가 따로 있어 이 함수로 조회하지 않는다.
 */
export async function fetchBuyingPower(
  cred: KisAccountCredentials,
  token: string,
  query: BuyingPowerQuery,
  productCode: "22" = "22",
): Promise<BuyingPowerResult> {
  const base = {
    ticker: query.ticker, unitPrice: query.unitPrice, ordDvsn: query.ordDvsn,
    ordPsblCash: null, nrcvbBuyAmt: null, nrcvbBuyQty: null,
    maxBuyAmt: null, maxBuyQty: null, psblQtyCalcUnpr: null, ruseAmt: null,
  } as const;

  // 입력 검증 — 잘못된 입력으로 증권사를 호출하지 않는다.
  if (!TICKER_RE.test(query.ticker)) {
    return { ...base, ok: false, httpStatus: 0, transportError: "종목코드 형식이 올바르지 않습니다" };
  }
  if (!Number.isInteger(query.unitPrice) || query.unitPrice <= 0) {
    return { ...base, ok: false, httpStatus: 0, transportError: "단가는 양의 정수여야 합니다" };
  }

  const raw = await kisAuthorizedGet(
    KIS_PATH_INQUIRE_PSBL_ORDER,
    TR_ID_INQUIRE_PSBL_ORDER,
    {
      CANO: cred.cano,
      ACNT_PRDT_CD: productCode,
      PDNO: query.ticker,
      ORD_UNPR: String(query.unitPrice),
      ORD_DVSN: query.ordDvsn,
      CMA_EVLU_AMT_ICLD_YN: "N",
      OVRS_ICLD_YN: "N",
    },
    cred,
    token,
  );
  const meta = toReadResult(raw, cred, token);
  const out = meta.ok && raw.body && typeof raw.body.output === "object" && raw.body.output
    ? (raw.body.output as Record<string, unknown>)
    : null;

  return {
    ...meta,
    ticker: query.ticker,
    unitPrice: query.unitPrice,
    ordDvsn: query.ordDvsn,
    ordPsblCash: out ? parseKisNumber(out.ord_psbl_cash) : null,
    nrcvbBuyAmt: out ? parseKisNumber(out.nrcvb_buy_amt) : null,
    nrcvbBuyQty: out ? parseKisNumber(out.nrcvb_buy_qty) : null,
    maxBuyAmt: out ? parseKisNumber(out.max_buy_amt) : null,
    maxBuyQty: out ? parseKisNumber(out.max_buy_qty) : null,
    psblQtyCalcUnpr: out ? parseKisNumber(out.psbl_qty_calc_unpr) : null,
    ruseAmt: out ? parseKisNumber(out.ruse_psbl_amt) : null,
  };
}

// ── 주문 예산으로의 변환 (순수) ─────────────────────────────────────────────

export interface VerifiedBuyingPowerEntry {
  ticker: string;
  /** 조회한 지정가 — 계획이 쓰는 단가와 같아야 이 값이 그 가격의 근거가 된다 */
  price: number;
  /** 주문가능금액(미수 없음) */
  amount: number;
  /** 그 단가에서의 최대 수량 */
  qty: number;
}

/**
 * 조회 결과 1건을 검증된 예산 항목으로. **하나라도 어긋나면 null** — 부분적으로 믿지 않는다.
 *
 *   · 호출이 성공했고(rt_cd 0)
 *   · 미수없는매수금액·수량이 있고 0 이상이며
 *   · 증권사가 계산에 쓴 단가가 우리가 넣은 단가와 같다
 *
 * 수량은 증권사가 준 값(`nrcvb_buy_qty`)을 쓰고 우리가 `금액 ÷ 단가`로 다시 계산하지 않는다.
 */
export function toVerifiedBuyingPower(r: BuyingPowerResult): VerifiedBuyingPowerEntry | null {
  if (!r.ok) return null;
  if (r.nrcvbBuyAmt === null || r.nrcvbBuyQty === null) return null;
  if (r.nrcvbBuyAmt < 0 || r.nrcvbBuyQty < 0 || !Number.isInteger(r.nrcvbBuyQty)) return null;
  if (r.psblQtyCalcUnpr !== r.unitPrice) return null;
  return { ticker: r.ticker, price: r.unitPrice, amount: r.nrcvbBuyAmt, qty: r.nrcvbBuyQty };
}
