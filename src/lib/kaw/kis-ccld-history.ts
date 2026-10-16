// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 일별 주문체결 **과거 조회** — 읽기 전용 모듈 (Phase 4-A PoC)
//
//   GET /uapi/domestic-stock/v1/trading/inquire-daily-ccld
//   TR_ID  TTTC0081R(3개월 이내) / CTSC9215R(3개월 이전)
//
// 연금저축(22)에서 실계좌로 실증됐다(2026-10-16, HTTP 200 / rt_cd 0 / KIOK0510).
// 이 모듈은 **조회와 해석만** 한다:
//   · 주문·취소 경로가 없다. GET 뿐이다
//   · **재시도하지 않는다.** 실패하면 사유를 분류해서 돌려준다
//   · 응답 해석은 순수 함수(`parseCcldResponse`)고, 전송은 주입된 `fetchImpl` 로만 한다
//   · 계좌번호·키·토큰은 반환값·오류 문구에 남기지 않는다(`redactKisSecrets`)
//   · 이 모듈은 원장·장부·DB 에 아무것도 쓰지 않는다
//
// ## 실증된 응답 구조 (output1 = 주문 1건당 1행, 분할체결 개별 내역이 아니다)
//
//   ord_dt odno orgn_odno pdno prdt_name sll_buy_dvsn_cd(01 매도 / 02 매수)
//   ord_qty ord_unpr ord_tmd tot_ccld_qty avg_prvs tot_ccld_amt rmn_qty rjct_qty cncl_yn …
//   output2: tot_ord_qty tot_ccld_qty tot_ccld_amt(총체결금액) pchs_avg_pric prsm_tlex_smtl
//
// 공식 예제의 한글 라벨은 output2 에서 한 칸씩 밀려 있다 — **영문 필드명으로만 읽는다.**
// `tot_ccld_amt` 는 수량 × 평균가(수수료 제외)로 실증됐다.
//
// ## "응답 부재"와 "실제 0건"을 구분한다
//
//   list_absent   성공으로 보였지만 output1 이 배열이 아니다 → **모름**(0건이 아니다)
//   empty         배열이고 0행이다 → 그 조건에서 주문이 없었다는 **관측**이다. 다만 날짜·거래소
//                 구분·TR_ID 가 틀려도 빈 배열이 오므로 "없었다"의 증거로 승격하지 않는다
//   rows          행이 있다
// ─────────────────────────────────────────────────────────────────────────────

import { parseKisNumber, redactKisSecrets, type KisAccountCredentials } from "./kis-account-server";

export const KIS_CCLD_BASE = "https://openapi.koreainvestment.com:9443";
export const KIS_CCLD_PATH = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld";
export const TR_ID_CCLD_INNER = "TTTC0081R";
export const TR_ID_CCLD_BEFORE = "CTSC9215R";
/** 실전 1회 조회 상한(공식 예제 docstring) */
export const CCLD_PAGE_LIMIT = 100;
/** 3개월 이전 조회는 짧은 구간으로 쪼개라는 권고(공식 예제) */
export const CCLD_BEFORE_MAX_SPAN_DAYS = 31;
export const CCLD_TIMEOUT_MS = 10_000;
/** 안전한 기본값 — 한 번에 가져오는 페이지 수. 실계좌 테스트는 1 로 둔다 */
export const CCLD_DEFAULT_MAX_PAGES = 1;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ── 날짜 / TR_ID / 구간 분할 (순수) ─────────────────────────────────────────

const YMD = /^\d{8}$/;

function toDate(ymd: string): Date | null {
  if (!YMD.test(ymd)) return null;
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const back = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return back === ymd ? d : null;
}
const fromDate = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** `today` 로부터 3개월 전 날짜(YYYYMMDD). 말일은 그 달의 말일로 맞춘다. */
export function threeMonthsAgo(today: string): string | null {
  const d = toDate(today);
  if (!d) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - 3, day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return fromDate(target);
}

export interface CcldWindow {
  start: string;
  end: string;
  trId: typeof TR_ID_CCLD_INNER | typeof TR_ID_CCLD_BEFORE;
}

export type CcldPlan =
  | { ok: true; windows: CcldWindow[] }
  | { ok: false; reason: "invalid_date" | "range_reversed" | "future_end" };

/**
 * 조회 구간을 TR_ID 별로 나눈다.
 *   · `cutoff`(오늘 − 3개월) 이상은 TTTC0081R, 그 앞은 CTSC9215R
 *   · 경계를 가로지르면 둘로 나눈다(같은 URL 이라도 TR_ID 가 다르면 다른 저장소를 본다)
 *   · 3개월 이전 구간은 31일 단위로 쪼갠다(공식 권고)
 */
export function planCcldWindows(start: string, end: string, today: string): CcldPlan {
  const s = toDate(start), e = toDate(end), t = toDate(today);
  if (!s || !e || !t) return { ok: false, reason: "invalid_date" };
  if (s > e) return { ok: false, reason: "range_reversed" };
  if (e > t) return { ok: false, reason: "future_end" };
  const cutoffStr = threeMonthsAgo(today);
  const cutoff = cutoffStr ? toDate(cutoffStr) : null;
  if (!cutoff) return { ok: false, reason: "invalid_date" };

  const windows: CcldWindow[] = [];
  if (e >= cutoff) {
    windows.push({ start: fromDate(s >= cutoff ? s : cutoff), end: end, trId: TR_ID_CCLD_INNER });
  }
  if (s < cutoff) {
    const beforeEnd = e < cutoff ? e : addDays(cutoff, -1);
    let cur = s;
    const chunks: CcldWindow[] = [];
    while (cur <= beforeEnd) {
      const chunkEnd = addDays(cur, CCLD_BEFORE_MAX_SPAN_DAYS - 1);
      const realEnd = chunkEnd < beforeEnd ? chunkEnd : beforeEnd;
      chunks.push({ start: fromDate(cur), end: fromDate(realEnd), trId: TR_ID_CCLD_BEFORE });
      cur = addDays(realEnd, 1);
    }
    windows.unshift(...chunks);
  }
  return { ok: true, windows };
}

// ── 요청 구성 (순수) ────────────────────────────────────────────────────────

export interface CcldQuery {
  /** 계좌상품코드. 연금저축 22. 29(IRP)는 이 API 로 조회하지 않는다 */
  productCode: "22";
  window: CcldWindow;
  /** 매도매수 00 전체 / 01 매도 / 02 매수. 기본 전체 */
  side?: "00" | "01" | "02";
  /** 기본 KRX */
  exchange?: "KRX" | "NXT" | "SOR" | "ALL";
}

/** 연속조회 키. 첫 페이지는 둘 다 빈 문자열이다 */
export interface CcldContinuation {
  fk100: string;
  nk100: string;
}

/** 요청 파라미터. **CANO 는 호출 직전에 전송부가 채운다** — 이 함수는 계좌번호를 모른다. */
export function buildCcldParams(q: CcldQuery, cont: CcldContinuation = { fk100: "", nk100: "" }): Record<string, string> {
  return {
    ACNT_PRDT_CD: q.productCode,
    INQR_STRT_DT: q.window.start,
    INQR_END_DT: q.window.end,
    SLL_BUY_DVSN_CD: q.side ?? "00",
    PDNO: "",
    CCLD_DVSN: "00",
    INQR_DVSN: "01",
    INQR_DVSN_3: "00",
    ORD_GNO_BRNO: "",
    ODNO: "",
    INQR_DVSN_1: "",
    EXCG_ID_DVSN_CD: q.exchange ?? "KRX",
    CTX_AREA_FK100: cont.fk100,
    CTX_AREA_NK100: cont.nk100,
  };
}

// ── 응답 해석 (순수) ────────────────────────────────────────────────────────

export interface CcldRow {
  /** YYYYMMDD */
  orderDate: string | null;
  orderNo: string | null;
  /** 정정·취소 주문이 가리키는 원주문번호. 최초 주문이면 보통 비어 있다 */
  origOrderNo: string | null;
  ticker: string | null;
  name: string | null;
  /** 01 매도 / 02 매수 */
  sideCode: string | null;
  orderQty: number | null;
  orderPrice: number | null;
  /** HHMMSS */
  orderTime: string | null;
  filledQty: number | null;
  avgPrice: number | null;
  filledAmount: number | null;
  remainingQty: number | null;
  rejectedQty: number | null;
  cancelled: boolean | null;
  orderTypeName: string | null;
}

export type CcldRowKind =
  /** 주문 수량이 전부 체결됐다 */
  | "filled"
  /** 일부만 체결됐고 **잔여가 남아 있다**(주문이 살아 있다) */
  | "partially_filled_open"
  /** 일부 체결 후 잔여가 닫혔다(취소·정정·장마감) — 체결된 만큼은 실제 체결이다 */
  | "partially_filled_closed"
  /** 체결 0 · 잔여 0 · 취소 아님 — 정정으로 대체된 원주문일 가능성이 높다(확정 아님) */
  | "no_fill_closed"
  /** 체결 0 · 잔여 있음 — 아직 체결되지 않은 주문 */
  | "no_fill_open"
  | "cancelled"
  | "rejected"
  /** 필수 필드를 읽지 못했다 — 0 으로 채우지 않는다 */
  | "unreadable";

export interface ParsedCcldRow {
  row: CcldRow;
  kind: CcldRowKind;
  /** 체결이 한 주라도 있는가 — 원장 후보가 될 수 있는 유일한 조건 */
  hasExecution: boolean;
  /** 수량 × 평균가 와 체결금액이 어긋난 정도(원). 어긋나지 않으면 0, 계산 불가면 null */
  amountMismatch: number | null;
}

export interface CcldSummary {
  totalOrderQty: number | null;
  totalFilledQty: number | null;
  totalFilledAmount: number | null;
  avgPurchasePrice: number | null;
  estimatedCosts: number | null;
}

export type CcldListState = "rows" | "empty" | "list_absent";

export interface ParsedCcldPage {
  /** HTTP 2xx + rt_cd "0" */
  ok: boolean;
  rtCd: string | null;
  msgCd: string | null;
  msg1: string | null;
  listState: CcldListState;
  rows: ParsedCcldRow[];
  summary: CcldSummary | null;
  /** 응답 헤더 tr_cont (M/F = 다음 페이지 있음, D/E = 마지막) */
  trCont: string;
  hasMore: boolean;
  next: CcldContinuation | null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** 한 행을 읽는다. 읽지 못한 숫자는 null(0 이 아니다). */
export function readCcldRow(r: Record<string, unknown>): CcldRow {
  const pos = (v: unknown) => {
    const n = parseKisNumber(v);
    return n !== null && n > 0 ? n : null;
  };
  return {
    orderDate: s(r.ord_dt),
    orderNo: s(r.odno),
    origOrderNo: s(r.orgn_odno),
    ticker: s(r.pdno),
    name: s(r.prdt_name),
    sideCode: s(r.sll_buy_dvsn_cd),
    orderQty: parseKisNumber(r.ord_qty),
    orderPrice: parseKisNumber(r.ord_unpr),
    orderTime: s(r.ord_tmd),
    filledQty: parseKisNumber(r.tot_ccld_qty),
    avgPrice: pos(r.avg_prvs),
    filledAmount: parseKisNumber(r.tot_ccld_amt),
    remainingQty: parseKisNumber(r.rmn_qty),
    rejectedQty: parseKisNumber(r.rjct_qty),
    cancelled: r.cncl_yn === "Y" ? true : r.cncl_yn === "N" ? false : null,
    orderTypeName: s(r.ord_dvsn_name),
  };
}

/** 행의 성격을 가린다. **체결수량이 0 인 행은 어떤 경우에도 hasExecution=false 다.** */
export function classifyCcldRow(row: CcldRow): ParsedCcldRow {
  const essential =
    row.orderDate !== null && /^\d{8}$/.test(row.orderDate) &&
    row.orderNo !== null && row.ticker !== null && /^[A-Z0-9]{6}$/.test(row.ticker) &&
    (row.sideCode === "01" || row.sideCode === "02") &&
    row.orderQty !== null && row.filledQty !== null && row.remainingQty !== null && row.cancelled !== null;
  if (!essential) return { row, kind: "unreadable", hasExecution: false, amountMismatch: null };

  const filled = row.filledQty as number;
  const ord = row.orderQty as number;
  const rmn = row.remainingQty as number;
  const rejected = (row.rejectedQty ?? 0) > 0;

  let amountMismatch: number | null = null;
  if (filled > 0 && row.avgPrice !== null && row.filledAmount !== null) {
    amountMismatch = Math.abs(Math.round(filled * row.avgPrice) - row.filledAmount);
  }

  if (filled > 0) {
    // 체결이 있으면 금액을 읽을 수 있어야 한다 — 못 읽으면 값을 추정하지 않는다
    if (row.avgPrice === null || row.filledAmount === null) {
      return { row, kind: "unreadable", hasExecution: false, amountMismatch };
    }
    const kind: CcldRowKind = filled >= ord ? "filled" : rmn > 0 && row.cancelled === false ? "partially_filled_open" : "partially_filled_closed";
    return { row, kind, hasExecution: true, amountMismatch };
  }
  if (rejected) return { row, kind: "rejected", hasExecution: false, amountMismatch: null };
  if (row.cancelled === true) return { row, kind: "cancelled", hasExecution: false, amountMismatch: null };
  return { row, kind: rmn > 0 ? "no_fill_open" : "no_fill_closed", hasExecution: false, amountMismatch: null };
}

/**
 * 한 페이지 응답을 해석한다. **throw 하지 않는다.**
 *
 * @param httpStatus   HTTP 상태
 * @param body         JSON 본문 (해석 실패면 null)
 * @param trContHeader 응답 헤더 tr_cont
 */
export function parseCcldResponse(
  httpStatus: number,
  body: Record<string, unknown> | null,
  trContHeader: string | null,
): ParsedCcldPage {
  const rtCd = body && typeof body.rt_cd === "string" ? body.rt_cd : null;
  const ok = httpStatus >= 200 && httpStatus < 300 && rtCd === "0";
  const trCont = (trContHeader ?? "").trim().toUpperCase();
  const nk = body && body.ctx_area_nk100 !== undefined ? String(body.ctx_area_nk100).trim() : "";
  const fk = body && body.ctx_area_fk100 !== undefined ? String(body.ctx_area_fk100).trim() : "";
  const hasMore = trCont === "M" || trCont === "F";
  const list = ok && body && Array.isArray(body.output1) ? (body.output1 as unknown[]) : null;
  const rows = (list ?? [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => classifyCcldRow(readCcldRow(x)));

  let summary: CcldSummary | null = null;
  const o2raw = ok && body ? body.output2 : null;
  const o2 = (Array.isArray(o2raw) ? o2raw[0] : o2raw) as Record<string, unknown> | null | undefined;
  if (o2 && typeof o2 === "object") {
    summary = {
      totalOrderQty: parseKisNumber(o2.tot_ord_qty),
      totalFilledQty: parseKisNumber(o2.tot_ccld_qty),
      totalFilledAmount: parseKisNumber(o2.tot_ccld_amt),
      avgPurchasePrice: parseKisNumber(o2.pchs_avg_pric),
      estimatedCosts: parseKisNumber(o2.prsm_tlex_smtl),
    };
  }
  return {
    ok,
    rtCd,
    msgCd: body && typeof body.msg_cd === "string" ? body.msg_cd : null,
    msg1: body && typeof body.msg1 === "string" ? body.msg1.slice(0, 120) : null,
    listState: list === null ? "list_absent" : list.length === 0 ? "empty" : "rows",
    rows,
    summary,
    trCont,
    hasMore,
    next: hasMore ? { fk100: fk, nk100: nk } : null,
  };
}

// ── 오류 분류 (순수) ────────────────────────────────────────────────────────

export type CcldFailureKind =
  /** 토큰 만료·무효, 앱키/시크릿 오류 */
  | "auth"
  /** 계좌번호 형식·계좌 연결 문제(INVALID_CHECK_ACNO 등) */
  | "account"
  /** 호출 빈도 초과 */
  | "rate_limit"
  /** 요청 파라미터 문제(날짜·구분코드 등) */
  | "request_value"
  /** 이 계좌·상품에서 API 를 쓸 수 없다는 신호(확정 아님) */
  | "possibly_unsupported"
  | "network"
  | "timeout"
  | "unparseable"
  | "unclassified";

/**
 * 실패를 원인별로 나눈다. **자동 재시도 근거로 쓰지 않는다.** 분류가 틀릴 수 있어서
 * 사유 문구만 사용자에게 보여주고, 어떤 분류도 다음 호출을 자동으로 일으키지 않는다.
 *
 * 알려진 코드: EGW00121/EGW00123(토큰), EGW00201(초당 호출 초과), OPSQ2000 + INVALID_CHECK_ACNO(계좌).
 * 그 외 서버 오류는 `unclassified` 로 둔다 — "미지원"으로 단정하지 않는다.
 */
export function classifyCcldFailure(page: Pick<ParsedCcldPage, "rtCd" | "msgCd" | "msg1">, httpStatus: number): CcldFailureKind {
  const code = (page.msgCd ?? "").toUpperCase();
  const msg = (page.msg1 ?? "").toUpperCase();
  // 계좌 형식 오류는 가장 구체적인 신호라 먼저 본다(메시지에 다른 단어가 섞여도 오분류하지 않는다).
  if (msg.includes("INVALID_CHECK_ACNO")) return "account";
  if (httpStatus === 401 || httpStatus === 403 || /^EGW0012[0-9]$/.test(code) || /TOKEN.*(만료|유효|EXPIRED|INVALID)|(만료|유효).*TOKEN/.test(msg)) return "auth";
  if (/^EGW00201$/.test(code) || msg.includes("초당")) return "rate_limit";
  if (msg.includes("계좌")) return "account";
  if (msg.includes("INVALID") || msg.includes("조회시작") || msg.includes("조회종료") || msg.includes("파라미터") || msg.includes("필수")) return "request_value";
  if (msg.includes("미지원") || msg.includes("지원하지") || msg.includes("불가") || code === "OPSQ0002") return "possibly_unsupported";
  return "unclassified";
}

// ── 전송 (주입된 fetch) ─────────────────────────────────────────────────────

export interface CcldFetchResult {
  /** 어떤 구간도 조회에 실패하지 않았고 모든 페이지를 읽었다 */
  complete: boolean;
  pages: ParsedCcldPage[];
  /** 마지막 페이지가 다음 페이지를 알렸는데 상한 때문에 읽지 않았다 */
  unreadPages: boolean;
  failure: { kind: CcldFailureKind; httpStatus: number; rtCd: string | null; msgCd: string | null; msg1: string | null } | null;
  /** 읽은 주문 행(모든 페이지) */
  rows: ParsedCcldRow[];
  /** 같은 응답 묶음에서 주문번호+주문일이 중복된 행의 키 — 어느 쪽이 맞는지 가릴 수 없다 */
  duplicateOrderKeys: string[];
}

export interface CcldFetchOptions {
  token: string;
  maxPages?: number;
  timeoutMs?: number;
}

/**
 * 구간 1개를 조회한다. **재시도하지 않는다.** 첫 실패에서 멈추고 분류해 돌려준다.
 * 연속 요청에는 요청 헤더 `tr_cont: "N"` 과 직전 응답의 FK/NK 를 쓴다.
 */
export async function fetchCcldWindow(
  cred: KisAccountCredentials,
  q: CcldQuery,
  fetchImpl: FetchLike,
  opts: CcldFetchOptions,
): Promise<CcldFetchResult> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? CCLD_DEFAULT_MAX_PAGES));
  const timeoutMs = opts.timeoutMs ?? CCLD_TIMEOUT_MS;
  const secrets = [cred.cano, cred.appKey, cred.appSecret, opts.token];
  const pages: ParsedCcldPage[] = [];
  let cont: CcldContinuation = { fk100: "", nk100: "" };
  let isFirst = true;
  let unreadPages = false;

  for (let n = 0; n < maxPages; n++) {
    const params = new URLSearchParams({ CANO: cred.cano, ...buildCcldParams(q, cont) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${KIS_CCLD_BASE}${KIS_CCLD_PATH}?${params.toString()}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${opts.token}`,
          appkey: cred.appKey,
          appsecret: cred.appSecret,
          tr_id: q.window.trId,
          custtype: "P",
          "content-type": "application/json",
          ...(isFirst ? {} : { tr_cont: "N" }),
        },
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      redactKisSecrets(e, secrets);
      return finish(pages, false, {
        kind: aborted ? "timeout" : "network", httpStatus: 0, rtCd: null, msgCd: null, msg1: null,
      });
    } finally {
      clearTimeout(timer);
    }
    let body: Record<string, unknown> | null = null;
    try { body = (await res.json()) as Record<string, unknown>; } catch { body = null; }
    const page = parseCcldResponse(res.status, body, res.headers?.get?.("tr_cont") ?? null);
    if (body === null) {
      return finish(pages, false, { kind: "unparseable", httpStatus: res.status, rtCd: null, msgCd: null, msg1: null });
    }
    if (!page.ok) {
      const kind = classifyCcldFailure(page, res.status);
      return finish(pages, false, {
        kind, httpStatus: res.status, rtCd: page.rtCd,
        msgCd: page.msgCd ? redactKisSecrets(page.msgCd, secrets, { genericPatterns: false }) : null,
        msg1: page.msg1 ? redactKisSecrets(page.msg1, secrets).slice(0, 120) : null,
      });
    }
    pages.push(page);
    if (!page.hasMore) break;
    if (n === maxPages - 1) { unreadPages = true; break; }
    cont = page.next ?? { fk100: "", nk100: "" };
    isFirst = false;
  }
  return finish(pages, unreadPages, null);

  function finish(
    ps: ParsedCcldPage[],
    unread: boolean,
    failure: CcldFetchResult["failure"],
  ): CcldFetchResult {
    const rows = ps.flatMap((p) => p.rows);
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (r.row.orderNo && r.row.orderDate) {
        const k = `${r.row.orderDate}:${r.row.orderNo}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    return {
      complete: failure === null && !unread && ps.length > 0,
      pages: ps,
      unreadPages: unread,
      failure,
      rows,
      duplicateOrderKeys: [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k),
    };
  }
}
