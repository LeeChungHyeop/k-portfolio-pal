import React, { createContext, useContext, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePortfolioStore, getOrDefaultLibrary } from "./store";
import type { TickerResult } from "./kis-server";

export interface TickerMeta {
  source: "kis" | "naver" | "failed";
  timestamp: string; // ISO string (UTC)
  error?: string;
}

export interface KisPriceCtx {
  prices: Record<string, number>;
  meta: Record<string, TickerMeta>;
  successCount: number;
  totalCount: number;
  configured: boolean;
  isLoading: boolean;
  retryingTickers: Set<string>;
  refetch: () => void;
  refetchSingleTicker: (ticker: string) => Promise<void>;
}

const KisPriceContext = createContext<KisPriceCtx>({
  prices: {},
  meta: {},
  successCount: 0,
  totalCount: 0,
  configured: true,
  isLoading: false,
  retryingTickers: new Set(),
  refetch: () => {},
  refetchSingleTicker: async () => {},
});

interface ServerResponse {
  results: Record<string, TickerResult>;
  timestamp: string;
}

async function batchFetchPrices(tickers: string[]): Promise<{
  prices: Record<string, number>;
  meta: Record<string, TickerMeta>;
  configured: boolean;
}> {
  if (!tickers.length) return { prices: {}, meta: {}, configured: true };

  const res = await fetch("/api/kis/price", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tickers }),
  });

  if (res.status === 503) return { prices: {}, meta: {}, configured: false };
  if (!res.ok) throw new Error(`KIS price fetch failed: ${res.status}`);

  const data = await res.json() as ServerResponse;
  const prices: Record<string, number> = {};
  const meta: Record<string, TickerMeta> = {};

  for (const [ticker, result] of Object.entries(data.results)) {
    if (result.price > 0) prices[ticker] = result.price;
    meta[ticker] = {
      source: result.source,
      timestamp: data.timestamp,
      error: result.error,
    };
  }

  return { prices, meta, configured: true };
}

// KRX 운영시간 체크 (한국시간 평일 09:00 ~ 15:30)
function isKrxMarketOpen(): boolean {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const day = kst.getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const mins = kst.getHours() * 60 + kst.getMinutes();
  return mins >= 9 * 60 && mins < 15 * 60 + 30;
}

export function KisPriceProvider({ children }: { children: React.ReactNode }) {
  const { state } = usePortfolioStore();
  const library = getOrDefaultLibrary(state);
  const queryClient = useQueryClient();

  const allTickers = useMemo(
    () => [...new Set(
      library.map((d) => d.ticker).filter((t): t is string => typeof t === "string" && t.length === 6),
    )],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.assetLibrary],
  );

  const queryKey = useMemo(() => ["kis-prices", [...allTickers].sort().join(",")], [allTickers]);

  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => batchFetchPrices(allTickers),
    enabled: allTickers.length > 0,
    refetchInterval: (query) => {
      // 장 마감 후·주말·야간에는 폴링 중지
      if (!isKrxMarketOpen()) return false;
      const prices = query.state.data?.prices;
      if (!prices) return 30_000;
      const hasFailed = allTickers.some((t) => !prices[t]);
      return hasFailed ? 30_000 : 300_000;
    },
    staleTime: 25_000,
    retry: 1,
    retryDelay: 5_000,
  });

  // 개별 종목 재시도 — 해당 ticker만 요청 후 쿼리 캐시 머지
  const [retryingTickers, setRetryingTickers] = useState<Set<string>>(new Set());

  const refetchSingleTicker = useCallback(async (ticker: string) => {
    setRetryingTickers((prev) => new Set([...prev, ticker]));
    try {
      const result = await batchFetchPrices([ticker]);
      queryClient.setQueryData(queryKey, (old: typeof data | undefined) => {
        if (!old) return result;
        return {
          ...old,
          prices: { ...old.prices, ...result.prices },
          meta: { ...old.meta, ...result.meta },
        };
      });
    } finally {
      setRetryingTickers((prev) => {
        const next = new Set(prev);
        next.delete(ticker);
        return next;
      });
    }
  }, [queryClient, queryKey]);

  const prices = data?.prices ?? {};
  const meta = data?.meta ?? {};
  const configured = data?.configured ?? true;
  const successCount = allTickers.filter((t) => !!prices[t]).length;
  const totalCount = allTickers.length;

  return (
    <KisPriceContext.Provider value={{
      prices, meta, successCount, totalCount, configured, isLoading,
      retryingTickers, refetch, refetchSingleTicker,
    }}>
      {children}
    </KisPriceContext.Provider>
  );
}

export function useKisPriceContext(): KisPriceCtx {
  return useContext(KisPriceContext);
}
