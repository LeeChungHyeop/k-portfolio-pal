// KIS Open API — server-side only (Cloudflare Workers)
// Credentials: set KIS_APP_KEY / KIS_APP_SECRET as Cloudflare Workers secrets

export interface TickerResult {
  price: number;
  source: "kis" | "naver" | "failed";
  error?: string;
}

interface KisToken { access_token: string; expires_at: number; }

let _token: KisToken | null = null;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(appKey: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (_token && _token.expires_at > now + 60_000) return _token.access_token;

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
  _token = {
    access_token: json.access_token,
    expires_at: now + (json.expires_in ?? 86400) * 1000,
  };
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
    const raw = (d.closePrice ?? d.stockEndPrice ?? d.currentPrice ?? "0") as string;
    const price = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
    return price > 0 ? { price } : { price: 0, error: "Naver: price=0" };
  } catch (e) {
    return { price: 0, error: `Naver: ${String(e).slice(0, 80)}` };
  }
}

export async function fetchKisPrices(
  tickers: string[],
  appKey: string,
  appSecret: string,
): Promise<{ results: Record<string, TickerResult>; timestamp: string }> {
  const token = await getToken(appKey, appSecret);
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
