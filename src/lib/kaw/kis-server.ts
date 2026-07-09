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
async function fetchNaverHistoryPrice(ticker: string, date: string): Promise<{ price: number; error?: string }> {
  // date: YYYYMMDD
  const targetISO = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const targetDot = `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`;

  // 1) 최근 20 거래일 JSON API (빠름)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://m.stock.naver.com/api/stock/${ticker}/price?code=${ticker}`,
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
    if (res.ok) {
      const data = await res.json() as Array<{ localTradedAt: string; closePrice: string }>;
      // 정확한 날짜 우선, 없으면 타겟 이전 가장 최근 거래일 종가
      const entry = data
        .filter(d => d.localTradedAt <= targetISO)
        .sort((a, b) => b.localTradedAt.localeCompare(a.localTradedAt))[0];
      if (entry) {
        const price = parseKoreanPrice(entry.closePrice);
        if (price > 0) return { price };
      }
    }
  } catch { /* fall through to HTML */ }

  // 2) HTML 파싱 (오래된 날짜 fallback)
  // 날짜 차이로 페이지 추정 (실측: finance.naver.com sise_day 1페이지 = 10거래일).
  // 공휴일 등으로 추정치가 어긋날 수 있어 넉넉한 범위로 탐색한다.
  const targetDate = new Date(targetISO);
  const today = new Date();
  const daysDiff = Math.max(0, Math.floor((today.getTime() - targetDate.getTime()) / 86400000));
  const approxPage = Math.max(1, Math.floor(daysDiff * 5 / 7 / 10));
  const pageFrom = Math.max(1, approxPage - 3);
  const pageTo = approxPage + 10;

  for (let page = pageFrom; page <= pageTo; page++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://finance.naver.com/item/sise_day.nhn?code=${ticker}&page=${page}`,
        {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://finance.naver.com/",
          },
        },
      );
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      // 페이지에서 모든 날짜 추출 → 타겟 이하 중 가장 최근 날짜의 종가 사용
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

  return { price: 0, error: "Naver history: 해당일 이전 종가 없음 (너무 오래된 날짜)" };
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
