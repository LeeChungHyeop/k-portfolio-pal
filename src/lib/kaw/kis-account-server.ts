// KIS Open API — 실계좌 **read-only** 조회 (server-only)
//
// 이 모듈은 조회(GET)만 한다. 주문 계열 엔드포인트는 의도적으로 하나도 들어 있지 않으며
// POST 요청도 하지 않는다 (토큰 발급 POST 는 kis-server.ts 쪽 책임).
// 이 불변식은 테스트가 소스 텍스트를 직접 검사해 고정한다.
//
// 보안 주의:
//   - 계좌번호(CANO)는 GET query string 에 들어간다. 따라서 **전체 URL / params 객체 /
//     raw 응답을 로그로 남기지 않는다.** 이 모듈 안에는 console 호출이 하나도 없다.
//   - 호출자는 출력 전 `redactKisSecrets()` 를 거쳐야 한다.
//
// 토큰 로직은 kis-server.ts 의 `getKisAccessToken` 을 재사용한다 (중복 구현 금지).

const KIS_BASE = "https://openapi.koreainvestment.com:9443";

/** 연금저축펀드 계좌상품코드 (비밀값 아님) */
export const PENSION_SAVINGS_PRODUCT_CODE = "22";
/** 개인형 IRP 계좌상품코드 (비밀값 아님) */
export const IRP_PRODUCT_CODE = "29";

export const KIS_PATH_INQUIRE_BALANCE = "/uapi/domestic-stock/v1/trading/inquire-balance";
export const KIS_PATH_PENSION_PRESENT_BALANCE = "/uapi/domestic-stock/v1/trading/pension/inquire-present-balance";
export const KIS_PATH_PENSION_DEPOSIT = "/uapi/domestic-stock/v1/trading/pension/inquire-deposit";

export const TR_ID_INQUIRE_BALANCE = "TTTC8434R";
export const TR_ID_PENSION_PRESENT_BALANCE = "TTTC2202R";
export const TR_ID_PENSION_DEPOSIT = "TTTC0506R";
/** 진단용 fallback (이번 PoC 필수 호출 아님) — pension/inquire-balance */
export const TR_ID_PENSION_BALANCE = "TTTC2208R";

export interface KisAccountCredentials {
  appKey: string;
  appSecret: string;
  /** 계좌번호 앞 8자리 (종합계좌번호). 절대 로그에 남기지 않는다. */
  cano: string;
}

/** KIS 응답의 공통 판정 결과 */
export interface KisAccountReadResult {
  ok: boolean;
  httpStatus: number;
  rtCd?: string;
  msgCd?: string;
  msg1?: string;
  /** 네트워크/파싱 단계 실패 사유 (HTTP 응답 자체를 못 받은 경우) */
  transportError?: string;
}

/** Shadow Mode 에서 재사용할 수 있는 최소 normalized 보유종목 */
export interface KisHolding {
  ticker: string | null;
  name: string | null;
  quantity: number | null;
}

export interface KisBalanceSnapshot extends KisAccountReadResult {
  holdings: KisHolding[];
  holdingsCount: number;
  /** 예수금. 필드가 없거나 파싱 불가면 null (0 과 구분한다) */
  cash: number | null;
  /** 계좌 요약에서 읽어낸 숫자 필드들 (없으면 null) */
  summary: Record<string, number | null>;
}

// ── 숫자 파싱 ────────────────────────────────────────────────────────────────
//
// KIS 값은 "1,234" / "0" / "0000000001234" 처럼 string 으로 온다.
// 파싱 불가/필드 없음은 **null** 이다 — NaN 을 0 으로 숨기지 않는다.

export function parseKisNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replaceAll(",", "");
  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 후보 키들을 순서대로 보며 처음으로 파싱되는 숫자를 쓴다. 전부 실패면 null. */
export function pickKisNumber(obj: unknown, keys: readonly string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in rec)) continue;
    const n = parseKisNumber(rec[key]);
    if (n !== null) return n;
  }
  return null;
}

function pickString(obj: unknown, keys: readonly string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

// ── redaction ───────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";

/**
 * 출력 직전에 민감값을 가린다.
 *
 * 1. 명시적으로 넘긴 비밀값(CANO / AppKey / AppSecret / access token)을 모두 치환
 * 2. 남아 있을 수 있는 **8자리 이상 연속 숫자**(계좌번호 패턴)와 긴 토큰 문자열도 치환
 *
 * msg1 같은 KIS 메시지 문자열에도 계좌번호가 섞일 수 있으므로 반드시 이 함수를 거친다.
 */
export function redactKisSecrets(
  text: unknown,
  secrets: readonly (string | undefined)[] = [],
  opts: { genericPatterns?: boolean } = {},
): string {
  let out = typeof text === "string" ? text : String(text ?? "");
  // 긴 비밀값을 먼저 치환해야 짧은 값이 부분 치환해 버리는 일이 없다
  const uniq = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= 4))]
    .sort((a, b) => b.length - a.length);
  for (const s of uniq) out = out.split(s).join(REDACTED);
  if (opts.genericPatterns === false) return out;
  // 계좌번호 패턴: 구분자(-)가 섞인 형태까지 포함해 8자리 이상 숫자 덩어리
  out = out.replace(/\d[\d-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? REDACTED : m));
  // 남은 긴 영숫자 덩어리(토큰/키 형태)
  out = out.replace(/[A-Za-z0-9_-]{40,}/g, REDACTED);
  return out;
}

// ── 공통 authenticated GET ───────────────────────────────────────────────────

interface KisRawResponse {
  httpStatus: number;
  body: Record<string, unknown> | null;
  transportError?: string;
}

/**
 * KIS 인증 GET. 공식 샘플과 동일한 header 구성.
 * **URL / params / body 를 로그로 남기지 않는다** (CANO 가 query string 에 있음).
 */
async function kisAuthorizedGet(
  path: string,
  trId: string,
  params: Record<string, string>,
  cred: KisAccountCredentials,
  token: string,
  trCont?: string,
): Promise<KisRawResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    appkey: cred.appKey,
    appsecret: cred.appSecret,
    tr_id: trId,
    custtype: "P",
    "content-type": "application/json",
  };
  if (trCont) headers.tr_cont = trCont;

  const url = `${KIS_BASE}${path}?${new URLSearchParams(params).toString()}`;

  try {
    const res = await fetch(url, { method: "GET", headers });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body };
  } catch (e) {
    return { httpStatus: 0, body: null, transportError: redactKisSecrets(e, [cred.cano, cred.appKey, cred.appSecret, token]) };
  }
}

/** HTTP 2xx + rt_cd === "0" 만 성공으로 본다. */
function toReadResult(raw: KisRawResponse, cred: KisAccountCredentials, token: string): KisAccountReadResult {
  const secrets = [cred.cano, cred.appKey, cred.appSecret, token];
  const body = raw.body ?? {};
  const rtCd = typeof body.rt_cd === "string" ? body.rt_cd : undefined;
  const httpOk = raw.httpStatus >= 200 && raw.httpStatus < 300;
  return {
    ok: httpOk && rtCd === "0",
    httpStatus: raw.httpStatus,
    rtCd,
    // msg_cd 는 "40910000" 같은 8자리 진단 코드다 — 계좌번호 패턴에 걸려 지워지면
    // 원인 판단이 불가능해지므로 명시 비밀값만 치환한다.
    msgCd: typeof body.msg_cd === "string"
      ? redactKisSecrets(body.msg_cd, secrets, { genericPatterns: false })
      : undefined,
    msg1: typeof body.msg1 === "string" ? redactKisSecrets(body.msg1, secrets) : undefined,
    transportError: raw.transportError,
  };
}

function toArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (v && typeof v === "object") return [v as Record<string, unknown>];
  return [];
}

const TICKER_KEYS = ["pdno", "prdt_no"] as const;
const NAME_KEYS = ["prdt_name", "prdt_abrv_name", "hldg_prdt_name"] as const;
const QTY_KEYS = ["hldg_qty", "cblc_qty", "hldg_cblc_qty", "ord_psbl_qty"] as const;

function normalizeHoldings(rows: Record<string, unknown>[]): KisHolding[] {
  return rows.map((r) => ({
    ticker: pickString(r, TICKER_KEYS),
    name: pickString(r, NAME_KEYS),
    quantity: pickKisNumber(r, QTY_KEYS),
  }));
}

const CASH_KEYS = ["dnca_tot_amt", "dnca_tota", "prvs_rcdl_excc_amt", "tot_dncl_amt", "dncl_amt"] as const;
const SUMMARY_KEYS = [
  "dnca_tot_amt",
  "dnca_tota",
  "prvs_rcdl_excc_amt",
  "tot_evlu_amt",
  "nass_amt",
  "scts_evlu_amt",
  "evlu_pfls_smtl_amt",
  "pchs_amt_smtl_amt",
] as const;

function buildSummary(rows: Record<string, unknown>[]): Record<string, number | null> {
  const summary: Record<string, number | null> = {};
  for (const key of SUMMARY_KEYS) {
    const present = rows.some((r) => key in r);
    if (present) summary[key] = pickKisNumber(rows.find((r) => key in r), [key]);
  }
  return summary;
}

function toSnapshot(
  raw: KisRawResponse,
  cred: KisAccountCredentials,
  token: string,
  opts: { holdingsField: string; summaryField: string },
): KisBalanceSnapshot {
  const meta = toReadResult(raw, cred, token);
  const body = raw.body ?? {};
  const holdingRows = meta.ok ? toArray(body[opts.holdingsField]) : [];
  const summaryRows = meta.ok ? toArray(body[opts.summaryField]) : [];
  const holdings = normalizeHoldings(holdingRows);
  return {
    ...meta,
    holdings,
    holdingsCount: holdings.length,
    cash: summaryRows.length ? pickKisNumber(summaryRows[0], CASH_KEYS) : null,
    summary: buildSummary(summaryRows),
  };
}

// ── 연금저축 (22) 잔고 ───────────────────────────────────────────────────────

/**
 * 연금저축펀드 계좌 잔고. 공식 inquire_balance 샘플의 필수 파라미터를 그대로 쓴다.
 * 빈 계좌(holdings 0건 / cash 0)도 정상 성공이다.
 */
export async function fetchPensionSavingsBalance(
  cred: KisAccountCredentials,
  token: string,
): Promise<KisBalanceSnapshot> {
  const raw = await kisAuthorizedGet(
    KIS_PATH_INQUIRE_BALANCE,
    TR_ID_INQUIRE_BALANCE,
    {
      CANO: cred.cano,
      ACNT_PRDT_CD: PENSION_SAVINGS_PRODUCT_CODE,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "01",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    },
    cred,
    token,
  );
  return toSnapshot(raw, cred, token, { holdingsField: "output1", summaryField: "output2" });
}

// ── IRP (29) ────────────────────────────────────────────────────────────────

/** IRP 체결기준잔고. output1=보유종목, output2=계좌요약. 빈 계좌도 정상. */
export async function fetchIrpPresentBalance(
  cred: KisAccountCredentials,
  token: string,
): Promise<KisBalanceSnapshot> {
  const raw = await kisAuthorizedGet(
    KIS_PATH_PENSION_PRESENT_BALANCE,
    TR_ID_PENSION_PRESENT_BALANCE,
    {
      CANO: cred.cano,
      ACNT_PRDT_CD: IRP_PRODUCT_CODE,
      USER_DVSN_CD: "00",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    },
    cred,
    token,
  );
  return toSnapshot(raw, cred, token, { holdingsField: "output1", summaryField: "output2" });
}

export interface KisDepositResult extends KisAccountReadResult {
  cash: number | null;
}

/** IRP 예수금. output 에서 dnca_tota 등을 안전하게 파싱. 0 도 정상. */
export async function fetchIrpDeposit(
  cred: KisAccountCredentials,
  token: string,
): Promise<KisDepositResult> {
  const raw = await kisAuthorizedGet(
    KIS_PATH_PENSION_DEPOSIT,
    TR_ID_PENSION_DEPOSIT,
    {
      CANO: cred.cano,
      ACNT_PRDT_CD: IRP_PRODUCT_CODE,
      ACCA_DVSN_CD: "00",
    },
    cred,
    token,
  );
  const meta = toReadResult(raw, cred, token);
  const rows = meta.ok ? toArray((raw.body ?? {}).output) : [];
  return { ...meta, cash: rows.length ? pickKisNumber(rows[0], CASH_KEYS) : null };
}
