// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 주식 주문 · 체결조회 transport (server-only)
//
//   POST /uapi/domestic-stock/v1/trading/order-cash          TTTC0012U  현금 매수 주문
//   GET  /uapi/domestic-stock/v1/trading/inquire-daily-ccld  TTTC0081R  일별 주문체결 조회
//
// **연금저축(22)에서 이 주문 API 가 동작하는지는 공식 문서로 확인되지 않았다**(`KIS_ORDER_SUPPORT`
// unverified). 이 파일은 "호출 수단"일 뿐이고, 호출 여부는 상위(order-service)가 정한다 —
// 기능 flag(기본 OFF)·소유권·정책·1회성 승인을 모두 통과한 요청에서만 이 함수가 불린다.
//
// 이 파일은 **전송만** 한다:
//   · `fetchImpl` 을 주입받는다 — 테스트는 모의 응답을 넣고, 실제 네트워크를 타지 않는다
//   · 응답을 해석하지 않고 `PlaceResponse` / `ExecutionRow` 로 옮긴다(판정은 order-intent.ts)
//   · 어떤 경우에도 **재시도하지 않는다.** 한 번 보내고 결과(또는 불명)를 돌려준다
//   · 계좌번호·키·토큰을 로그·반환값에 남기지 않는다(console 호출 없음)
// ─────────────────────────────────────────────────────────────────────────────

import { parseKisNumber, redactKisSecrets, type KisAccountCredentials } from "./kis-account-server";
import { CCLD_PAGE_ROWS, type ExecutionRow, type PlaceResponse } from "./order-intent";

const KIS_BASE = "https://openapi.koreainvestment.com:9443";

export const KIS_PATH_ORDER_CASH = "/uapi/domestic-stock/v1/trading/order-cash";
export const TR_ID_ORDER_CASH_BUY = "TTTC0012U";
export const KIS_PATH_INQUIRE_DAILY_CCLD = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld";
export const TR_ID_INQUIRE_DAILY_CCLD = "TTTC0081R";

export const ORDER_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Raw {
  httpStatus: number;
  /** 응답 헤더 tr_cont (M/F = 다음 페이지 있음) */
  trCont?: string | null;
  body: Record<string, unknown> | null;
  transportError?: string;
  timedOut?: boolean;
  unparseable?: boolean;
}

async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  secrets: readonly string[],
): Promise<Raw> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    let unparseable = false;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      unparseable = true;
    }
    const trCont = res.headers?.get?.("tr_cont") ?? null;
    return { httpStatus: res.status, body, trCont, ...(unparseable ? { unparseable } : {}) };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      httpStatus: 0, body: null, timedOut: aborted,
      transportError: redactKisSecrets(e, secrets).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

const headersOf = (cred: KisAccountCredentials, token: string, trId: string) => ({
  authorization: `Bearer ${token}`,
  appkey: cred.appKey,
  appsecret: cred.appSecret,
  tr_id: trId,
  custtype: "P",
  "content-type": "application/json",
});

// ── 주문 ────────────────────────────────────────────────────────────────────

export interface CashBuyRequest {
  ticker: string;
  quantity: number;
  /** 지정가(정수 원) */
  limitPrice: number;
}

/**
 * 현금 매수 주문 **1회 전송.** 지정가(ORD_DVSN=00), 거래소 KRX.
 *
 * 입력을 한 번 더 검증한다(상위가 이미 검증했지만, 이 함수가 마지막 방어선이다). 어긋나면
 * **요청을 만들지 않고** `transportError` 로 돌려준다 — 그 경우 아무 것도 전송되지 않았다.
 */
export async function placeCashBuyOrder(
  cred: KisAccountCredentials,
  token: string,
  req: CashBuyRequest,
  fetchImpl: FetchLike,
  timeoutMs: number = ORDER_TIMEOUT_MS,
): Promise<PlaceResponse & { sent: boolean }> {
  if (!/^[A-Z0-9]{6}$/.test(req.ticker)) {
    return { httpStatus: 0, transportError: "종목코드 형식 오류(전송하지 않음)", sent: false };
  }
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
    return { httpStatus: 0, transportError: "수량 오류(전송하지 않음)", sent: false };
  }
  if (!Number.isInteger(req.limitPrice) || req.limitPrice <= 0) {
    return { httpStatus: 0, transportError: "지정가 오류(전송하지 않음)", sent: false };
  }

  const secrets = [cred.cano, cred.appKey, cred.appSecret, token];
  const raw = await send(
    fetchImpl,
    `${KIS_BASE}${KIS_PATH_ORDER_CASH}`,
    {
      method: "POST",
      headers: headersOf(cred, token, TR_ID_ORDER_CASH_BUY),
      // 수량·단가는 **문자열**로 보낸다(공식 예제의 주의사항).
      body: JSON.stringify({
        CANO: cred.cano,
        ACNT_PRDT_CD: "22",
        PDNO: req.ticker,
        ORD_DVSN: "00",
        ORD_QTY: String(req.quantity),
        ORD_UNPR: String(req.limitPrice),
        EXCG_ID_DVSN_CD: "KRX",
      }),
    },
    timeoutMs,
    secrets,
  );

  const body = raw.body ?? {};
  const out = (typeof body.output === "object" && body.output ? body.output : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    sent: true,
    httpStatus: raw.httpStatus,
    ...(typeof body.rt_cd === "string" ? { rtCd: body.rt_cd } : {}),
    ...(typeof body.msg_cd === "string"
      ? { msgCd: redactKisSecrets(body.msg_cd, secrets, { genericPatterns: false }) } : {}),
    ...(typeof body.msg1 === "string" ? { msg1: redactKisSecrets(body.msg1, secrets).slice(0, 120) } : {}),
    orderNo: str(out.ODNO),
    orderOrgNo: str(out.KRX_FWDG_ORD_ORGNO),
    orderTime: str(out.ORD_TMD),
    ...(raw.transportError ? { transportError: raw.transportError } : {}),
    ...(raw.timedOut ? { timedOut: true } : {}),
    ...(raw.unparseable ? { unparseable: true } : {}),
  };
}

// ── 체결조회 ────────────────────────────────────────────────────────────────

export interface DailyCcldQuery {
  ticker: string;
  /** YYYYMMDD (KST 영업일) */
  date: string;
  /** 알면 주문번호로 좁힌다. 모르면(응답 유실) 빈 값 */
  orderNo?: string | null;
  /** 조회 종료일 YYYYMMDD. 없으면 date 하루만 */
  endDate?: string;
}

export interface DailyCcldResult {
  ok: boolean;
  httpStatus: number;
  rtCd?: string;
  msg1?: string;
  rows: ExecutionRow[];
  /** 다음 페이지가 있다는 신호. 이 단계는 첫 페이지만 본다 */
  hasMore: boolean;
  /** 응답에 행 목록(output1)이 **배열로** 있었는가. 없으면 "0건"이 아니라 "모름"이다 */
  listPresent: boolean;
  /**
   * 이 조회가 그 기간의 주문을 **전부** 보여줬다고 볼 수 있는가: 성공 + 목록 존재 + 다음 페이지
   * 신호 없음(tr_cont M/F 아님, ctx_area_nk100 비어 있음) + 한 페이지 한도 미만. 아니면 false.
   */
  complete: boolean;
  transportError?: string;
}

/**
 * 일별 주문체결 조회 **GET 1회.** 매수(02)·전체 체결구분(00)·해당 종목.
 *
 * 응답 필드명은 공식 예제 저장소에 나열돼 있지 않다 — 아래 이름은 KIS 일반 명세의 것이고
 * **이 계좌의 실응답으로 확인되지 않았다.** 그래서 읽지 못한 필드는 null 이며, 체결 판정은
 * 필드를 못 읽으면 `unreadable` 로 멈춘다(order-intent.ts judgeExecution).
 */
export async function inquireDailyCcld(
  cred: KisAccountCredentials,
  token: string,
  q: DailyCcldQuery,
  fetchImpl: FetchLike,
  timeoutMs: number = ORDER_TIMEOUT_MS,
): Promise<DailyCcldResult> {
  const end = q.endDate ?? q.date;
  if (!/^[A-Z0-9]{6}$/.test(q.ticker) || !/^\d{8}$/.test(q.date) || !/^\d{8}$/.test(end) || end < q.date) {
    return { ok: false, httpStatus: 0, rows: [], hasMore: false, listPresent: false, complete: false, transportError: "조회 조건 형식 오류" };
  }
  const params = new URLSearchParams({
    CANO: cred.cano,
    ACNT_PRDT_CD: "22",
    INQR_STRT_DT: q.date,
    INQR_END_DT: end,
    SLL_BUY_DVSN_CD: "02",
    PDNO: q.ticker,
    CCLD_DVSN: "00",
    INQR_DVSN: "00",
    INQR_DVSN_3: "00",
    ORD_GNO_BRNO: "",
    ODNO: q.orderNo ?? "",
    INQR_DVSN_1: "",
    EXCG_ID_DVSN_CD: "KRX",
    CTX_AREA_FK100: "",
    CTX_AREA_NK100: "",
  });
  const secrets = [cred.cano, cred.appKey, cred.appSecret, token];
  const raw = await send(
    fetchImpl,
    `${KIS_BASE}${KIS_PATH_INQUIRE_DAILY_CCLD}?${params.toString()}`,
    { method: "GET", headers: headersOf(cred, token, TR_ID_INQUIRE_DAILY_CCLD) },
    timeoutMs,
    secrets,
  );

  const body = raw.body ?? {};
  const rtCd = typeof body.rt_cd === "string" ? body.rt_cd : undefined;
  const ok = raw.httpStatus >= 200 && raw.httpStatus < 300 && rtCd === "0";
  const listPresent = ok && Array.isArray(body.output1);
  const list = listPresent ? (body.output1 as unknown[]) : [];
  const s = (r: Record<string, unknown>, k: string) =>
    typeof r[k] === "string" && (r[k] as string).trim() !== "" ? (r[k] as string).trim() : null;

  const rows: ExecutionRow[] = list
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      orderNo: s(r, "odno"),
      ticker: s(r, "pdno"),
      orderQty: parseKisNumber(r.ord_qty),
      orderPrice: parseKisNumber(r.ord_unpr),
      orderTime: s(r, "ord_tmd"),
      filledQty: parseKisNumber(r.tot_ccld_qty),
      avgPrice: (() => {
        const v = parseKisNumber(r.avg_prvs);
        return v !== null && v > 0 ? v : null;
      })(),
      remainingQty: parseKisNumber(r.rmn_qty),
      cancelled: r.cncl_yn === "Y" ? true : r.cncl_yn === "N" ? false : null,
      sideCode: s(r, "sll_buy_dvsn_cd"),
      orderDate: s(r, "ord_dt"),
    }));

  const trCont = (raw.trCont ?? "").trim().toUpperCase();
  const hasMore = trCont === "M" || trCont === "F"
    || (body.ctx_area_nk100 !== undefined && String(body.ctx_area_nk100).trim() !== "");
  return {
    ok,
    httpStatus: raw.httpStatus,
    ...(rtCd !== undefined ? { rtCd } : {}),
    ...(typeof body.msg1 === "string" ? { msg1: redactKisSecrets(body.msg1, secrets).slice(0, 120) } : {}),
    rows,
    hasMore,
    listPresent,
    complete: ok && listPresent && !hasMore && rows.length < CCLD_PAGE_ROWS,
    ...(raw.transportError ? { transportError: raw.transportError } : {}),
  };
}
