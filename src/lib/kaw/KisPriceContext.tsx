import React, { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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
  refetch: () => void;
}

const KisPriceContext = createContext<KisPriceCtx>({
  prices: {},
  meta: {},
  successCount: 0,
  totalCount: 0,
  configured: true,
  isLoading: false,
  refetch: () => {},
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

export function KisPriceProvider({ children }: { children: React.ReactNode }) {
  const { state } = usePortfolioStore();
  const library = getOrDefaultLibrary(state);

  const allTickers = useMemo(
    () => [...new Set(
      library.map((d) => d.ticker).filter((t): t is string => typeof t === "string" && t.length === 6),
    )],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.assetLibrary],
  );

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["kis-prices", [...allTickers].sort().join(",")],
    queryFn: () => batchFetchPrices(allTickers),
    enabled: allTickers.length > 0,
    // 실패 종목 있으면 30초 재시도, 전부 성공이면 5분 간격
    refetchInterval: (query) => {
      const prices = query.state.data?.prices;
      if (!prices) return 30_000;
      const hasFailed = allTickers.some((t) => !prices[t]);
      return hasFailed ? 30_000 : 300_000;
    },
    staleTime: 25_000,
    retry: 1,
    retryDelay: 5_000,
  });

  const prices = data?.prices ?? {};
  const meta = data?.meta ?? {};
  const configured = data?.configured ?? true;
  const successCount = allTickers.filter((t) => !!prices[t]).length;
  const totalCount = allTickers.length;

  return (
    <KisPriceContext.Provider value={{ prices, meta, successCount, totalCount, configured, isLoading, refetch }}>
      {children}
    </KisPriceContext.Provider>
  );
}

export function useKisPriceContext(): KisPriceCtx {
  return useContext(KisPriceContext);
}
