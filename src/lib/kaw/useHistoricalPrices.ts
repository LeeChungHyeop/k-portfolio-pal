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
  series?: Record<string, Array<{ date?: unknown; price?: unknown; open?: unknown }>>;
}

/** 한 거래일의 시가·종가. 수익 분석(장 시작 → 장 마감)이 쓰는 모양. */
export interface PriceBar {
  open: number;
  close: number;
}

/**
 * ticker → (YYYY-MM-DD → bar). **open·close 가 둘 다 유효한 날짜만 키가 있다** —
 * 하나라도 없으면 그 날짜를 만들지 않는다(fail closed). 0 을 채우지 않는다.
 */
export type PriceBarsByTicker = Record<string, Record<string, PriceBar>>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pos = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 서버 응답 → ticker → (날짜 → bar). **open·close 가 둘 다 유효할 때만** 키를 만든다.
 * 시가가 없다고 전일 종가나 종가로 대신 채우지 않는다 — 그러면 그 날 장중 손익이
 * 0 이나 갭 포함 값으로 왜곡된다.
 */
export function toPriceBarsByTicker(body: SeriesResponse): PriceBarsByTicker {
  const out: PriceBarsByTicker = {};
  for (const [ticker, points] of Object.entries(body?.series ?? {})) {
    if (!Array.isArray(points)) continue;
    const byDate: Record<string, PriceBar> = {};
    for (const p of points) {
      const date = typeof p?.date === "string" ? p.date : "";
      if (!ISO.test(date)) continue;
      const close = pos(p?.price);
      const open = pos(p?.open);
      if (close === null || open === null) continue;
      byDate[date] = { open, close };
    }
    if (Object.keys(byDate).length) out[ticker] = byDate;
  }
  return out;
}

/**
 * 서버 응답 → ticker → (날짜 → 종가). 기존 과거 복원 경로(`historical-performance.ts`)가
 * 쓰는 모양이고 **동작이 바뀌지 않았다** — 시가가 없어도 종가만 있으면 키가 생긴다.
 * 수익 분석은 이쪽을 쓰지 않고 `toPriceBarsByTicker` 를 쓴다.
 */
export function toPriceSeriesByTicker(body: SeriesResponse): PriceSeriesByTicker {
  const out: PriceSeriesByTicker = {};
  for (const [ticker, points] of Object.entries(body?.series ?? {})) {
    if (!Array.isArray(points)) continue;
    const byDate: Record<string, number> = {};
    for (const p of points) {
      const date = typeof p?.date === "string" ? p.date : "";
      if (!ISO.test(date)) continue;
      const price = pos(p?.price);
      if (price === null) continue;
      byDate[date] = price;
    }
    if (Object.keys(byDate).length) out[ticker] = byDate;
  }
  return out;
}

async function fetchHistoryRaw(plan: ReconstructionPlan): Promise<SeriesResponse> {
  const token = getSessionToken();
  if (!token) return {};
  const res = await fetch("/api/naver/history-series", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tickers: plan.tickers, from: plan.fromDate, to: plan.toDate }),
  });
  // fail closed — 받지 못한 가격은 그 날짜 평가를 만들지 않는 쪽으로 끝난다.
  if (!res.ok) return {};
  return (await res.json()) as SeriesResponse;
}

/**
 * 두 훅이 **같은 queryKey** 를 쓴다 — 요청은 1회이고 `select` 로 모양만 달리 꺼낸다.
 * 그래서 기존 종가 경로와 새 bar 경로가 같은 화면에 공존해도 네트워크 호출이 늘지 않는다.
 */
function historyQueryKey(plan: ReconstructionPlan | null) {
  return [
    "kaw-history-series",
    plan?.fromDate ?? "",
    plan?.toDate ?? "",
    plan?.tickers.join(",") ?? "",
  ] as const;
}

const HISTORY_QUERY_OPTIONS = {
  // 과거 가격은 변하지 않는다 — 세션 내 재요청을 사실상 없앤다.
  staleTime: 12 * 60 * 60_000,
  gcTime: 24 * 60 * 60_000,
  refetchOnWindowFocus: false,
  retry: 1,
} as const;

export function useHistoricalPriceSeries(plan: ReconstructionPlan | null, enabled: boolean) {
  return useQuery({
    queryKey: historyQueryKey(plan),
    queryFn: () => fetchHistoryRaw(plan!),
    select: toPriceSeriesByTicker,
    enabled: enabled && !!plan && plan.tickers.length > 0,
    ...HISTORY_QUERY_OPTIONS,
  });
}

/** 수익 분석용 — 시가·종가 bar. 위 훅과 같은 요청을 공유한다. */
export function useHistoricalPriceBars(plan: ReconstructionPlan | null, enabled: boolean) {
  return useQuery({
    queryKey: historyQueryKey(plan),
    queryFn: () => fetchHistoryRaw(plan!),
    select: toPriceBarsByTicker,
    enabled: enabled && !!plan && plan.tickers.length > 0,
    ...HISTORY_QUERY_OPTIONS,
  });
}
