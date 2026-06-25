import { useQuery } from "@tanstack/react-query";

export interface KisPriceResult {
  prices: Record<string, number>;
  configured: boolean; // false = server has no KIS credentials
}

async function fetchPrices(tickers: string[]): Promise<KisPriceResult> {
  if (!tickers.length) return { prices: {}, configured: true };

  const res = await fetch("/api/kis/price", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tickers }),
  });

  if (res.status === 503) {
    // Server told us credentials aren't set up
    return { prices: {}, configured: false };
  }
  if (!res.ok) throw new Error(`KIS price fetch failed: ${res.status}`);

  const prices = await res.json() as Record<string, number>;
  return { prices, configured: true };
}

export function useKisPrices(tickers: string[], enabled: boolean) {
  return useQuery({
    queryKey: ["kis-prices", [...tickers].sort().join(",")],
    queryFn: () => fetchPrices(tickers),
    enabled: enabled && tickers.length > 0,
    refetchInterval: 600_000,  // 10분
    staleTime: 595_000,        // 10분 - 5초
    retry: 2,
    retryDelay: 3_000,
  });
}
