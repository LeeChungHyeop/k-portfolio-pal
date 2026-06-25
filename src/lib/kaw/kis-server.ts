// KIS Open API — server-side only (Cloudflare Workers)
// Credentials: set KIS_APP_KEY / KIS_APP_SECRET as Cloudflare Workers secrets

interface KisToken { access_token: string; expires_at: number; }

let _token: KisToken | null = null;

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

// J(KOSPI) → Q(KOSDAQ) → ETF 순으로 fallback
const MARKET_CODES = ["J", "Q", "ETF"] as const;

async function fetchSinglePrice(
  code: string,
  token: string,
  appKey: string,
  appSecret: string,
): Promise<number> {
  const headers = {
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    "content-type": "application/json",
  };

  for (const mktDiv of MARKET_CODES) {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=${mktDiv}&FID_INPUT_ISCD=${code}`;
      const res = await fetch(url, { headers: { ...headers, tr_id: "FHKST01010100" } });
      if (!res.ok) continue;
      const d = await res.json() as { output?: { stck_prpr?: string }; rt_cd?: string };
      if (d.rt_cd !== "0") continue; // KIS 오류 코드
      const price = parseInt(d.output?.stck_prpr ?? "0", 10);
      if (price > 0) return price;
    } catch {
      continue;
    }
  }
  return 0;
}

export async function fetchKisPrices(
  tickers: string[],
  appKey: string,
  appSecret: string,
): Promise<Record<string, number>> {
  const token = await getToken(appKey, appSecret);
  const results: Record<string, number> = {};

  // 순차 처리로 rate limit 방지 (KIS API 권장: 초당 20건)
  for (const ticker of tickers) {
    const code = ticker.replace(/\D/g, "").slice(0, 6).padStart(6, "0");
    const price = await fetchSinglePrice(code, token, appKey, appSecret);
    if (price > 0) results[ticker] = price;
    // 50ms 간격으로 rate limit 방어
    await new Promise((r) => setTimeout(r, 50));
  }

  return results;
}
