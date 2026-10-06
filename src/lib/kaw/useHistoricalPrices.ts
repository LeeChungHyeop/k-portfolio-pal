// 과거 종가 **구간** 조회 훅 — 과거 성과 복원(historical-performance.ts) 전용.
//
// 브라우저는 네이버에 직접 붙지 않는다. Worker 의 인증된 POST /api/naver/history-series 만
// 쓴다(기존 /api/data · /api/snapshots 와 같은 세션 토큰 경로).
//
// ## 네트워크 호출 구조
//
// 요청은 **화면당 1회**다. 서버가 종목당 1회 요청으로 구간 전체를 받아오므로
// (kis-server.ts fetchNaverHistorySeries), 거래일 수에 비례해 호출이 늘지 않는다.
//
// 과거 종가는 **바뀌지 않는 사실**이라 캐시를 길게 잡는다. queryKey 에 ticker set 과
// from/to 가 들어 있어서, 같은 계획이면 Dashboard 가 다시 render 돼도 재요청하지 않는다.
// scope(전체/계좌별)나 기간(일간/월간/연간) 토글은 queryKey 에 넣지 않는다 —
// 그 토글들은 이미 받아온 timeline 을 client-side 에서 재집계할 뿐이다.
import { useQuery } from "@tanstack/react-query";
import { getSessionToken } from "./auth";
import type { PriceSeriesByTicker, ReconstructionPlan } from "./historical-performance";

interface SeriesResponse {
  series?: Record<string, Array<{ date?: unknown; price?: unknown }>>;
}

/** 서버 응답 → ticker → (날짜 → 종가). 쓸 수 없는 값은 **키를 만들지 않는다**(0 금지). */
export function toPriceSeriesByTicker(body: SeriesResponse): PriceSeriesByTicker {
  const out: PriceSeriesByTicker = {};
  for (const [ticker, points] of Object.entries(body?.series ?? {})) {
    if (!Array.isArray(points)) continue;
    const byDate: Record<string, number> = {};
    for (const p of points) {
      const date = typeof p?.date === "string" ? p.date : "";
      const price = typeof p?.price === "number" ? p.price : Number(p?.price);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(price) || !(price > 0)) continue;
      byDate[date] = price;
    }
    if (Object.keys(byDate).length) out[ticker] = byDate;
  }
  return out;
}

async function fetchHistorySeries(plan: ReconstructionPlan): Promise<PriceSeriesByTicker> {
  const token = getSessionToken();
  if (!token) return {};
  const res = await fetch("/api/naver/history-series", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tickers: plan.tickers, from: plan.fromDate, to: plan.toDate }),
  });
  // fail closed — 받지 못한 가격은 그 날짜 복원 행을 만들지 않는 쪽으로 끝난다.
  if (!res.ok) return {};
  return toPriceSeriesByTicker((await res.json()) as SeriesResponse);
}

export function useHistoricalPriceSeries(plan: ReconstructionPlan | null, enabled: boolean) {
  return useQuery({
    queryKey: [
      "kaw-history-series",
      plan?.fromDate ?? "",
      plan?.toDate ?? "",
      plan?.tickers.join(",") ?? "",
    ],
    queryFn: () => fetchHistorySeries(plan!),
    enabled: enabled && !!plan && plan.tickers.length > 0,
    // 과거 종가는 변하지 않는다 — 세션 내 재요청을 사실상 없앤다.
    staleTime: 12 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
