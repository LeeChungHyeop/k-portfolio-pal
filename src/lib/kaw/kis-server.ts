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

export async function fetchKisPrices(
  tickers: string[],
  appKey: string,
  appSecret: string,
): Promise<Record<string, number>> {
  const token = await getToken(appKey, appSecret);
  const results: Record<string, number> = {};

  await Promise.all(tickers.map(async (ticker) => {
    try {
      const code = ticker.replace(/\D/g, "").slice(0, 6).padStart(6, "0");
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`;
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: "FHKST01010100",
          "content-type": "application/json",
        },
      });
      if (!res.ok) return;
      const d = await res.json() as { output?: { stck_prpr?: string; hts_kor_isnm?: string } };
      const price = parseInt(d.output?.stck_prpr ?? "0", 10);
      if (price > 0) results[ticker] = price;
    } catch {
      // ticker failed — skip silently, caller sees missing key
    }
  }));

  return results;
}
