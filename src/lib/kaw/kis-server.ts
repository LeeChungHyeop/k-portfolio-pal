// KIS Open API — server-side only (Cloudflare Workers)
// Credentials: set KIS_APP_KEY / KIS_APP_SECRET as Cloudflare Workers secrets

export interface TickerResult {
  price: number;
  source: "kis" | "naver" | "failed";
  error?: string;
}

interface KisToken { access_token: string; expires_at: number; }

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const KIS_TOKEN_KV_KEY = "kis:token";

// Worker 격리(isolate) 내 메모리 캐시. 같은 요청이 같은 warm 인스턴스에 다시 걸릴 때 KV 왕복을 줄여줌.
let _token: KisToken | null = null;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// KIS는 앱키당 토큰 발급 요청 자체를 분당 1회 정도로 엄격히 제한한다.
// Cloudflare Workers는 요청마다 다른(콜드) isolate에 배정될 수 있어, 메모리 캐시(_token)만 믿으면
// isolate마다 각자 새 토큰을 발급받으려다 이 제한에 걸려 "새로고침해도 전부 실패"하는 경우가 생긴다.
// KV에 토큰을 공유 저장해서 isolate가 바뀌어도 같은 토큰을 재사용하도록 한다.
async function getToken(appKey: string, appSecret: string, kv?: KVLike): Promise<string> {
  const now = Date.now();
  if (_token && _token.expires_at > now + 60_000) return _token.access_token;

  if (kv) {
    const cached = await kv.get(KIS_TOKEN_KV_KEY).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as KisToken;
        if (parsed.expires_at > now + 60_000) {
          _token = parsed;
          return parsed.access_token;
        }
      } catch { /* 손상된 캐시는 무시하고 새로 발급 */ }
    }
  }

  const res = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KIS token error ${res.status}: ${body}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  const expiresInSec = json.expires_in ?? 86400;
  _token = {
    access_token: json.access_token,
    expires_at: now + expiresInSec * 1000,
  };
  if (kv) {
    // 만료 60초 전에 미리 갱신되도록 TTL을 살짝 짧게 잡는다
    await kv.put(KIS_TOKEN_KV_KEY, JSON.stringify(_token), { expirationTtl: Math.max(60, expiresInSec - 60) }).catch(() => {});
  }
  return _token.access_token;
}

const MARKET_CODES = ["J", "Q"] as const;

async function fetchSingleKisPrice(
  code: string,
  token: string,
  appKey: string,
  appSecret: string,
): Promise<{ price: number; error?: string }> {
  const headers = {
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    "content-type": "application/json",
    tr_id: "FHKST01010100",
  };

  for (let i = 0; i < MARKET_CODES.length; i++) {
    if (i > 0) await delay(100);
    const mktDiv = MARKET_CODES[i];
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=${mktDiv}&FID_INPUT_ISCD=${code}`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const d = await res.json() as { output?: { stck_prpr?: string }; rt_cd?: string; msg1?: string };
      if (d.rt_cd !== "0") continue;
      const price = parseInt(d.output?.stck_prpr ?? "0", 10);
      if (price > 0) return { price };
    } catch {
      continue;
    }
  }
  return { price: 0, error: "KIS: J/Q 모두 0 반환" };
}

function parseKoreanPrice(raw: unknown): number {
  if (typeof raw === "number") return isNaN(raw) ? 0 : Math.round(raw);
  const cleaned = String(raw ?? "").replaceAll(",", "").replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n);
}

async function fetchNaverPrice(ticker: string): Promise<{ price: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://m.stock.naver.com/api/stock/${ticker}/basic`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          "Referer": "https://m.stock.naver.com/",
          "Accept": "application/json",
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) return { price: 0, error: `Naver HTTP ${res.status}` };
    const d = await res.json() as Record<string, unknown>;
    // 여러 필드명 시도: 현재가 > 마감가 > 종가
    const raw = d.closePrice ?? d.stockEndPrice ?? d.currentPrice ?? d.stockPrice ?? "0";
    const price = parseKoreanPrice(raw);
    return price > 0 ? { price } : { price: 0, error: "Naver: 가격 0 또는 필드 불일치" };
  } catch (e) {
    return { price: 0, error: `Naver: ${String(e).slice(0, 80)}` };
  }
}

// ── Naver 과거 종가 조회 (KIS 불필요) ──────────────────────────────────────
//
// 조회 경로는 3단이다.
//
//   1) m.stock.naver.com 모바일 JSON **pagination** — 주 경로.
//      `?pageSize=60&page=N` 으로 과거를 거슬러 간다. 예전에는 pageSize/page 를 지정하지 않아
//      **최근 20 거래일만** 받았고, 그래서 1년 전 날짜는 이 경로에서 늘 실패했다.
//   2) api.finance.naver.com/siseJson.naver — 날짜 구간을 직접 주는 JSON. 1회 요청으로 끝난다.
//   3) finance.naver.com/item/sise_day HTML 파싱 — 레거시. **현재 HTTP 410 Gone 이라 사실상 죽은
//      경로다**(실측). 되살아날 수도 있어 마지막 보조로만 남긴다 — 여기에 의존하지 않는다.
//
// pageSize 는 **60이 상한**이다(실측: 61 이상은 HTTP 400).
export const NAVER_MOBILE_PAGE_SIZE = 60;
/** 한 종목당 모바일 JSON 요청 상한 — Cloudflare subrequest 한도를 지키기 위한 안전장치 */
export const NAVER_MAX_PAGE_STEPS = 8;

export interface NaverPriceRow {
  localTradedAt: string; // YYYY-MM-DD
  closePrice: string;
  /**
   * 시가. **두 source 모두 실제로 주는 값이다**(2026-10-08 실측):
   *   · siseJson 헤더가 `['날짜','시가','고가','저가','종가',…]` 이라 5개 숫자 중 2번째
   *   · 모바일 JSON 응답에 `openPrice` 필드가 있다 (쉼표 포함 문자열)
   * **전일 종가를 시가로 대신 쓰지 않는다** — 없으면 그 행을 버린다(fail closed).
   */
  openPrice?: string;
}

/**
 * 시작 페이지 추정. 페이지당 60 거래일이고 주당 약 5 거래일이므로,
 * 목표일까지의 달력 일수에서 대략적인 페이지를 집어 **1~2회 요청으로 끝나게** 한다.
 * 틀려도 pagination 이 앞뒤로 조정하므로 정확성보다 단순함을 택한다.
 */
export function estimateNaverStartPage(targetISO: string, now: Date = new Date()): number {
  const t = Date.parse(`${targetISO}T00:00:00Z`);
  if (!Number.isFinite(t)) return 1;
  const calendarDays = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
  const tradingDays = Math.floor((calendarDays * 5) / 7);
  return Math.max(1, Math.min(60, 1 + Math.floor(tradingDays / NAVER_MOBILE_PAGE_SIZE)));
}

/**
 * "목표일 또는 그 이전 가장 최근 거래일의 종가"를 모바일 JSON pagination 으로 찾는다(순수 로직).
 *
 * 페이지는 날짜 내림차순이고 페이지끼리도 연속이다. 그래서 목표일이 현재 페이지 구간보다
 * 과거면 더 깊이(page+1), 페이지의 최신일보다도 최신이면 더 얕게(page-1) 간다.
 * **찾으면 즉시 멈춘다** — 무조건 N페이지를 훑지 않는다.
 *
 * 되돌아간 뒤 다시 깊이 들어가는 왕복(진동)은 하지 않는다. 얕게 가다가 목표일이 그 페이지
 * 구간보다 과거로 벗어나면, 직전에 찾아둔 후보(candidate)가 정답이다.
 *
 * @param loadPage 해당 페이지 행 목록. 실패/비정상 응답은 null (그 즉시 중단).
 */
export async function findNaverClosePriceByPaging(
  targetISO: string,
  startPage: number,
  loadPage: (page: number) => Promise<NaverPriceRow[] | null>,
  parsePrice: (raw: unknown) => number,
): Promise<{ price: number; pagesRead: number; error?: string }> {
  let page = Math.max(1, startPage);
  let pagesRead = 0;
  let candidate = 0; // 지금까지 찾은 "목표일 이하 중 가장 최근" 종가
  let movedShallower = false;

  while (page >= 1 && pagesRead < NAVER_MAX_PAGE_STEPS) {
    const rows = await loadPage(page);
    pagesRead++;
    if (rows === null) {
      return { price: candidate, pagesRead, error: candidate > 0 ? undefined : "모바일 JSON 응답 실패" };
    }
    if (!rows.length) {
      // 상장 이력보다 깊이 들어갔다 — 데이터가 나올 때까지 얕은 쪽으로 계속 돌린다
      // (추정이 2페이지 이상 빗나가도 포기하지 않는다). 1페이지가 비면 데이터 자체가 없다.
      // 되돌아가는 방향이므로 MAX_STEPS 안에서 반드시 끝난다.
      if (page > 1) {
        page--;
        movedShallower = true;
        continue;
      }
      break;
    }

    const newest = rows[0].localTradedAt;
    const oldest = rows[rows.length - 1].localTradedAt;

    if (targetISO < oldest) {
      if (movedShallower) break; // 왕복 방지
      page++;
      continue;
    }

    // 내림차순이라 목표일 이하 첫 항목이 "가장 최근"이다
    const hit = rows.find((r) => r.localTradedAt <= targetISO);
    if (!hit) {
      if (movedShallower) break;
      page++;
      continue;
    }
    const price = parsePrice(hit.closePrice);
    if (!(price > 0)) break; // 값이 비정상이면 성공으로 보지 않는다

    if (hit !== rows[0] || page === 1) return { price, pagesRead };

    // 목표일이 이 페이지 최신일보다도 최신이다 → 한 페이지 얕게 더 가까운 거래일이 있는지 본다
    candidate = price;
    page--;
    movedShallower = true;
  }

  return {
    price: candidate,
    pagesRead,
    error: candidate > 0 ? undefined : "모바일 JSON: 목표일 이전 종가 없음",
  };
}

/** YYYYMMDD 에서 n일 전 YYYYMMDD */
function shiftYmd(ymd: string, days: number): string {
  const t = Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(t)) return ymd;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * siseJson.naver 응답 파싱. 정식 JSON 이 아니라 작은따옴표가 섞인 배열 텍스트라서
 * `JSON.parse` 가 통하지 않는다 → 행 패턴을 직접 긁는다.
 *   [['날짜', '시가', ...], ["20250901", 55670, 55870, 55070, 55205, 116920, 0.0], ...]
 * **시가는 2번째, 종가는 5번째 숫자다**(헤더 순서: 날짜·시가·고가·저가·종가·거래량·외국인소진율).
 * 예전에는 시가(m[2])를 캡처하고도 버렸다 — 수익 분석이 "장 시작 → 장 마감"을 쓰므로
 * 이제 보존한다. 추가 네트워크 요청은 없다.
 */
export function parseNaverSiseJson(text: string): NaverPriceRow[] {
  const out: NaverPriceRow[] = [];
  const re = /\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = m[1];
    out.push({
      localTradedAt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      closePrice: m[5],
      openPrice: m[2],
    });
  }
  // 내림차순(최신 먼저)으로 맞춘다 — 모바일 JSON 과 같은 순서로 다루기 위해
  return out.sort((a, b) => b.localTradedAt.localeCompare(a.localTradedAt));
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

const MOBILE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  Referer: "https://m.stock.naver.com/",
  Accept: "application/json",
};

async function fetchNaverHistoryPrice(ticker: string, date: string): Promise<{ price: number; error?: string }> {
  // date: YYYYMMDD
  const targetISO = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const errors: string[] = [];

  // 1) 모바일 JSON pagination (주 경로)
  try {
    const paged = await findNaverClosePriceByPaging(
      targetISO,
      estimateNaverStartPage(targetISO),
      async (page) => {
        const res = await fetchJson(
          `https://m.stock.naver.com/api/stock/${ticker}/price?pageSize=${NAVER_MOBILE_PAGE_SIZE}&page=${page}`,
          MOBILE_HEADERS,
        );
        if (!res.ok) return null;
        try {
          const data = await res.json();
          return Array.isArray(data) ? (data as NaverPriceRow[]) : null;
        } catch {
          return null; // malformed JSON
        }
      },
      parseKoreanPrice,
    );
    if (paged.price > 0) return { price: paged.price };
    if (paged.error) errors.push(paged.error);
  } catch (e) {
    errors.push(`모바일 JSON: ${String(e).slice(0, 60)}`);
  }

  // 2) siseJson 날짜 구간 조회 (1회 요청). 휴장일을 감안해 2주 구간을 받아 목표일 이하 최신값을 쓴다.
  try {
    const res = await fetchJson(
      `https://api.finance.naver.com/siseJson.naver?symbol=${ticker}&requestType=1`
        + `&startTime=${shiftYmd(date, -14)}&endTime=${date}&timeframe=day`,
      { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
    );
    if (res.ok) {
      const rows = parseNaverSiseJson(await res.text());
      const hit = rows.find((r) => r.localTradedAt <= targetISO);
      const price = hit ? parseKoreanPrice(hit.closePrice) : 0;
      if (price > 0) return { price };
      errors.push("siseJson: 구간 내 종가 없음");
    } else {
      errors.push(`siseJson: HTTP ${res.status}`);
    }
  } catch (e) {
    errors.push(`siseJson: ${String(e).slice(0, 60)}`);
  }

  // 3) 레거시 HTML 파싱 — 실측 HTTP 410 Gone. 되살아날 경우를 위해서만 남겨둔다.
  const targetDate = new Date(targetISO);
  const today = new Date();
  const daysDiff = Math.max(0, Math.floor((today.getTime() - targetDate.getTime()) / 86400000));
  const approxPage = Math.max(1, Math.floor((daysDiff * 5) / 7 / 10));
  const pageFrom = Math.max(1, approxPage - 1);
  const pageTo = approxPage + 2;

  for (let page = pageFrom; page <= pageTo; page++) {
    try {
      const res = await fetchJson(
        `https://finance.naver.com/item/sise_day.nhn?code=${ticker}&page=${page}`,
        { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
      );
      if (!res.ok) break; // 410 이면 다음 페이지도 마찬가지다 — 더 두드리지 않는다
      const html = await res.text();
      const dateRe = /(\d{4})\.(\d{2})\.(\d{2})/g;
      const candidates: Array<{ iso: string; dotEnd: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = dateRe.exec(html)) !== null) {
        const iso = `${m[1]}-${m[2]}-${m[3]}`;
        if (iso <= targetISO) candidates.push({ iso, dotEnd: m.index + m[0].length });
      }
      candidates.sort((a, b) => b.iso.localeCompare(a.iso));
      for (const c of candidates) {
        const after = html.slice(c.dotEnd, c.dotEnd + 400);
        const pm = after.match(/>([\d,]+)</);
        if (pm) {
          const price = parseKoreanPrice(pm[1]);
          if (price > 0) return { price };
        }
      }
    } catch { continue; }
  }

  return {
    price: 0,
    error: `Naver history(${targetISO}): ${errors.slice(0, 2).join(" / ") || "종가 없음"}`,
  };
}

export async function fetchNaverHistoryPrices(
  tickers: string[],
  date: string,
): Promise<{ results: Record<string, TickerResult>; timestamp: string }> {
  const results: Record<string, TickerResult> = {};
  const timestamp = new Date().toISOString();

  for (const ticker of tickers) {
    const { price, error } = await fetchNaverHistoryPrice(ticker, date);
    results[ticker] = price > 0
      ? { price, source: "naver" }
      : { price: 0, source: "failed", error };
    await delay(80);
  }

  return { results, timestamp };
}

// ── Naver 과거 종가 "날짜 범위" 조회 (과거 성과 복원 전용) ──────────────────
//
// `fetchNaverHistoryPrices` 는 **한 날짜**용이다. 과거 1년의 매 거래일 평가액을 복원하려면
// 거래일 × 종목 수만큼 그 함수를 부르게 되는데(수백~수천 요청), Cloudflare subrequest 한도에
// 걸리고 네이버에도 무례하다. 그래서 여기서는 **종목당 1회 요청으로 구간 전체**를 받는다.
//
//   1) api.finance.naver.com/siseJson.naver — `startTime`/`endTime` 로 구간을 직접 준다.
//      응답에 구간 내 모든 거래일이 들어 있다. **주 경로이며 종목당 요청 1회로 끝난다.**
//   2) 실패하면 m.stock.naver.com 모바일 JSON pagination 으로 폴백한다. 페이지(60 거래일)를
//      fromDate 에 닿을 때까지 거슬러 가고, `NAVER_MAX_PAGE_STEPS` 로 상한을 둔다.
//
// 휴장일을 만들어내지 않는다 — **응답에 있는 거래일만** 돌려준다. 가격이 0 이하거나 파싱이
// 안 되는 행은 버린다(fail closed). 받은 값이 비면 빈 배열이고, 호출자는 그 종목이 들어간
// 날짜의 평가액을 만들지 않는다.

/** 한 종목의 한 거래일 종가 */
export interface HistoryPricePoint {
  /** YYYY-MM-DD */
  date: string;
  price: number;
}

/**
 * 한 종목의 한 거래일 **bar**. 수익 분석(장 시작 → 장 마감)이 쓰는 모양이다.
 * `open` 과 `close` 가 **둘 다 유효할 때만** 만들어진다 — 하나라도 없으면 그 날짜 행을
 * 버린다(fail closed). 전일 종가로 시가를 대신하지 않는다.
 */
export interface HistoryBarPoint {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  close: number;
}

/**
 * 한 번에 조회할 수 있는 종목 수 상한.
 * 원장 16종목 + 원장에 없는 보유종목(367380)으로 **17종목**이 필요하다 — 20 은 여유가
 * 3개뿐이라 32 로 올렸다. 네이버 요청은 종목당 1회이므로 subrequest 여유는 충분하다.
 */
export const HISTORY_SERIES_MAX_TICKERS = 32;
/** 한 번에 조회할 수 있는 구간 길이 상한(달력 일수) — 약 6년 */
export const HISTORY_SERIES_MAX_DAYS = 2200;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 구간 조회 요청이 받아들일 수 있는 범위인가. 받아들일 수 없으면 사유 문자열, 괜찮으면 null.
 * 순수 함수라 endpoint 와 테스트가 같은 판정을 쓴다.
 */
export function historySeriesRangeError(
  tickers: readonly string[],
  fromDate: string,
  toDate: string,
): string | null {
  if (!tickers.length) return "종목이 비어 있습니다";
  if (tickers.length > HISTORY_SERIES_MAX_TICKERS) {
    return `종목 수 상한(${HISTORY_SERIES_MAX_TICKERS}) 초과`;
  }
  if (!ISO_DATE_RE.test(fromDate) || !ISO_DATE_RE.test(toDate)) return "날짜 형식 오류";
  if (fromDate > toDate) return "fromDate 가 toDate 보다 늦습니다";
  const days = Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000,
  );
  if (!Number.isFinite(days)) return "날짜 형식 오류";
  if (days > HISTORY_SERIES_MAX_DAYS) return `구간 상한(${HISTORY_SERIES_MAX_DAYS}일) 초과`;
  return null;
}

/**
 * 네이버 응답 행들(날짜 내림차순) → 구간 안의 거래일 종가 series(날짜 오름차순).
 *
 * **fail closed**: 가격이 0 이하거나 숫자가 아니면 그 행을 버린다 — 0 을 종가로 넘기면
 * 그 날 평가액이 0원으로 계산된다. 같은 날짜가 두 번 오면 먼저 온 쪽(최신 응답 순서)을 쓴다.
 */
export function pickSeriesInRange(
  rows: readonly NaverPriceRow[],
  fromDate: string,
  toDate: string,
): HistoryPricePoint[] {
  // **종가 전용 경로다.** 시가 유무와 무관하게 동작한다 — 기존 과거 복원
  // (`historical-performance.ts`)의 계약을 바꾸지 않기 위해 `pickBarsInRange` 와
  // 따로 둔다. 수익 분석은 open 이 필수라 그쪽을 쓴다.
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const date = String(r?.localTradedAt ?? "");
    if (!ISO_DATE_RE.test(date)) continue;
    if (date < fromDate || date > toDate) continue;
    if (byDate.has(date)) continue;
    const price = parsePositivePrice(r.closePrice);
    if (price === null) continue;
    byDate.set(date, price);
  }
  return [...byDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 네이버 응답 행들 → 구간 안의 거래일 **bar**(날짜 오름차순).
 *
 * **fail closed 를 open 까지 확장한다**: open 또는 close 중 하나라도 숫자가 아니거나
 * 0 이하면 **그 날짜 행 전체를 버린다.** 시가가 없다고 전일 종가를 넣지 않는다 —
 * 그러면 그 날 "장 시작 → 장 마감" 손익이 오버나이트 갭까지 삼켜 틀린 값이 된다.
 * 같은 날짜가 두 번 오면 먼저 온 쪽(최신 응답 순서)을 쓴다.
 */
export function pickBarsInRange(
  rows: readonly NaverPriceRow[],
  fromDate: string,
  toDate: string,
): HistoryBarPoint[] {
  const byDate = new Map<string, HistoryBarPoint>();
  for (const r of rows) {
    const date = String(r?.localTradedAt ?? "");
    if (!ISO_DATE_RE.test(date)) continue;
    if (date < fromDate || date > toDate) continue;
    if (byDate.has(date)) continue;
    const close = parsePositivePrice(r.closePrice);
    const open = parsePositivePrice(r.openPrice);
    if (close === null || open === null) continue;
    byDate.set(date, { date, open, close });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 가격 문자열 → 양수. 쓸 수 없으면 `null`(0 을 돌려주지 않는다).
 *
 * `parseKoreanPrice` 는 숫자 아닌 문자를 떼어내므로 `"-100"` 이 100 이 된다. 음수 표기는
 * 가격으로 올 수 없는 값이니 **파싱 전에** 떨어낸다(공용 파서는 건드리지 않는다).
 */
function parsePositivePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string" && raw.includes("-")) return null;
  const n = parseKoreanPrice(raw);
  return n > 0 ? n : null;
}

/**
 * 모바일 JSON pagination 폴백 — 페이지(최신 먼저, 60 거래일)를 `fromDate` 에 닿을 때까지
 * 거슬러 간다. `loadPage` 가 null/빈 배열을 주면 거기서 멈춘다. 요청 수는
 * `NAVER_MAX_PAGE_STEPS` 로 묶여 있다(구간이 길어도 요청이 폭주하지 않는다).
 *
 * 로더를 주입받는 순수 로직이라 네트워크 없이 테스트한다.
 */
export async function collectNaverSeriesByPaging(
  fromDate: string,
  toDate: string,
  loadPage: (page: number) => Promise<NaverPriceRow[] | null>,
): Promise<HistoryBarPoint[]> {
  const collected: NaverPriceRow[] = [];
  for (let page = 1; page <= NAVER_MAX_PAGE_STEPS; page += 1) {
    const rows = await loadPage(page);
    if (rows === null || !rows.length) break;
    collected.push(...rows);
    const oldest = rows[rows.length - 1]?.localTradedAt ?? "";
    // 이 페이지가 이미 fromDate 이전까지 내려갔으면 더 깊이 들어갈 이유가 없다.
    if (oldest && oldest <= fromDate) break;
  }
  return pickBarsInRange(collected, fromDate, toDate);
}

const toYmd = (iso: string): string => iso.replaceAll("-", "");

async function fetchNaverSeriesForTicker(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<{ series: HistoryBarPoint[]; error?: string }> {
  const errors: string[] = [];

  // 1) siseJson 구간 조회 — 요청 1회로 구간 전체를 받는다 (주 경로)
  try {
    const res = await fetchJson(
      `https://api.finance.naver.com/siseJson.naver?symbol=${ticker}&requestType=1`
        + `&startTime=${toYmd(fromDate)}&endTime=${toYmd(toDate)}&timeframe=day`,
      { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
      8000,
    );
    if (res.ok) {
      const series = pickBarsInRange(parseNaverSiseJson(await res.text()), fromDate, toDate);
      if (series.length) return { series };
      errors.push("siseJson: 구간 내 시가·종가 없음");
    } else {
      errors.push(`siseJson: HTTP ${res.status}`);
    }
  } catch (e) {
    errors.push(`siseJson: ${String(e).slice(0, 60)}`);
  }

  // 2) 모바일 JSON pagination 폴백
  try {
    const series = await collectNaverSeriesByPaging(fromDate, toDate, async (page) => {
      const res = await fetchJson(
        `https://m.stock.naver.com/api/stock/${ticker}/price?pageSize=${NAVER_MOBILE_PAGE_SIZE}&page=${page}`,
        MOBILE_HEADERS,
      );
      if (!res.ok) return null;
      try {
        const data = await res.json();
        return Array.isArray(data) ? (data as NaverPriceRow[]) : null;
      } catch {
        return null; // malformed JSON
      }
    });
    if (series.length) return { series };
    errors.push("모바일 JSON: 구간 내 시가·종가 없음");
  } catch (e) {
    errors.push(`모바일 JSON: ${String(e).slice(0, 60)}`);
  }

  return { series: [], error: errors.slice(0, 2).join(" / ") || "시가·종가 없음" };
}

/**
 * 여러 종목의 날짜 구간 종가 series. **종목당 요청 1회(폴백 시 최대
 * `NAVER_MAX_PAGE_STEPS` 회)** 이고, 거래일 수에는 비례하지 않는다.
 *
 * 실패한 종목은 `series` 에 빈 배열로 남고 `failed` 에 사유가 들어간다 — 0원 가격을
 * 만들어 내지 않는다(호출자가 그 종목이 든 날짜를 건너뛴다).
 */
export async function fetchNaverHistorySeries(
  tickers: readonly string[],
  fromDate: string,
  toDate: string,
): Promise<{
  series: Record<string, HistoryBarPoint[]>;
  failed: Record<string, string>;
  timestamp: string;
}> {
  const series: Record<string, HistoryBarPoint[]> = {};
  const failed: Record<string, string> = {};
  const timestamp = new Date().toISOString();

  for (const ticker of [...new Set(tickers)]) {
    const r = await fetchNaverSeriesForTicker(ticker, fromDate, toDate);
    series[ticker] = r.series;
    if (r.error) failed[ticker] = r.error;
    await delay(80);
  }

  return { series, failed, timestamp };
}

export async function fetchKisPrices(
  tickers: string[],
  appKey: string,
  appSecret: string,
  kv?: KVLike,
): Promise<{ results: Record<string, TickerResult>; timestamp: string }> {
  const token = await getToken(appKey, appSecret, kv);
  const results: Record<string, TickerResult> = {};
  const timestamp = new Date().toISOString();

  for (const ticker of tickers) {
    const code = ticker.toUpperCase().slice(0, 6);

    // 1) KIS 시도
    const { price: kisPrice, error: kisErr } = await fetchSingleKisPrice(code, token, appKey, appSecret);

    if (kisPrice > 0) {
      results[ticker] = { price: kisPrice, source: "kis" };
    } else {
      // 2) Naver fallback
      const { price: naverPrice, error: naverErr } = await fetchNaverPrice(ticker);
      if (naverPrice > 0) {
        results[ticker] = { price: naverPrice, source: "naver" };
      } else {
        const errMsg = [kisErr, naverErr].filter(Boolean).join(" / ");
        results[ticker] = { price: 0, source: "failed", error: errMsg };
      }
    }

    // 종목 간 100ms 간격
    await delay(100);
  }

  return { results, timestamp };
}
