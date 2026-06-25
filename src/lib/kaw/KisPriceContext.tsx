import React, { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePortfolioStore, getOrDefaultLibrary } from "./store";

export interface KisPriceCtx {
  prices: Record<string, number>;
  successCount: number;
  totalCount: number;
  configured: boolean;
  isLoading: boolean;
  refetch: () => void;
}

const KisPriceContext = createContext<KisPriceCtx>({
  prices: {},
  successCount: 0,
  totalCount: 0,
  configured: true,
  isLoading: false,
  refetch: () => {},
});

async function batchFetchPrices(tickers: string[]): Promise<{ prices: Record<string, number>; configured: boolean }> {
  if (!tickers.length) return { prices: {}, configured: true };
  const res = await fetch("/api/kis/price", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tickers }),
  });
  if (res.status === 503) return { prices: {}, configured: false };
  if (!res.ok) throw new Error(`KIS price fetch failed: ${res.status}`);
  const prices = await res.json() as Record<string, number>;
  return { prices, configured: true };
}

export function KisPriceProvider({ children }: { children: React.ReactNode }) {
  const { state } = usePortfolioStore();
  const library = getOrDefaultLibrary(state);

  const allTickers = useMemo(
    () => [...new Set(
      library.map((d) => d.ticker).filter((t): t is string => typeof t === "string" && t.length === 6),
    )],
    // state.assetLibrary 변경 시에만 재계산
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.assetLibrary],
  );

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["kis-prices", [...allTickers].sort().join(",")],
    queryFn: () => batchFetchPrices(allTickers),
    enabled: allTickers.length > 0,
    // 실패 종목 있으면 30초, 전부 성공이면 10분 간격으로 자동 재시도
    refetchInterval: (query) => {
      const prices = query.state.data?.prices;
      if (!prices) return 30_000;
      const hasFailed = allTickers.some((t) => !prices[t]);
      return hasFailed ? 30_000 : 600_000;
    },
    staleTime: 25_000,
    retry: 1,
    retryDelay: 5_000,
  });

  const prices = data?.prices ?? {};
  const configured = data?.configured ?? true;
  const successCount = allTickers.filter((t) => !!prices[t]).length;
  const totalCount = allTickers.length;

  return (
    <KisPriceContext.Provider value={{ prices, successCount, totalCount, configured, isLoading, refetch }}>
      {children}
    </KisPriceContext.Provider>
  );
}

export function useKisPriceContext(): KisPriceCtx {
  return useContext(KisPriceContext);
}
