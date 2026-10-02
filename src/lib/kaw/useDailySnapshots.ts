// 일별 자산 스냅샷 읽기 훅 — 기간 성과(대시보드 Section D) 전용.
//
// 브라우저는 Supabase 에 직접 붙지 않는다. Worker 의 인증된 GET /api/snapshots 만 쓴다
// (기존 /api/data 와 같은 세션 토큰 경로).
//
// 돌아오는 것은 **날짜별 평가액만**이다. 외부 입출금은 스냅샷에 들어 있지 않고,
// 성과 계산 시점에 store 의 cashflow 장부(account.cashflows)를 별도 인자로 결합한다.
import { useQuery } from "@tanstack/react-query";
import { getSessionToken } from "./auth";
import type { DailySnapshotRow } from "./performance";

interface ServerRow {
  snapshot_date: string;
  account_type: string;
  market_value: number | string;
  cash_balance: number | string;
  total_asset_value: number | string;
}

/** 스냅샷 테이블이 아직 없을 때(= migration 003 미적용) 구분하기 위한 상태 */
export interface DailySnapshotsResult {
  rows: DailySnapshotRow[];
  /** 테이블이 없거나 서버가 조회하지 못한 경우 */
  unavailable: boolean;
}

const num = (v: number | string): number => (typeof v === "number" ? v : Number(v) || 0);

async function fetchSnapshots(): Promise<DailySnapshotsResult> {
  const token = getSessionToken();
  if (!token) return { rows: [], unavailable: false };

  const res = await fetch("/api/snapshots", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return { rows: [], unavailable: false };
  if (!res.ok) {
    // migration 003 을 아직 적용하지 않았으면 테이블이 없어서 500 이 온다.
    // 화면에서는 "데이터 축적 중"과 구분해 안내한다.
    return { rows: [], unavailable: true };
  }
  const body = (await res.json()) as { rows?: ServerRow[] };
  const rows = (body.rows ?? []).map((r) => ({
    snapshotDate: r.snapshot_date,
    accountId: r.account_type,
    marketValue: num(r.market_value),
    cashBalance: num(r.cash_balance),
    totalAssetValue: num(r.total_asset_value),
  }));
  return { rows, unavailable: false };
}

export function useDailySnapshots(enabled: boolean) {
  return useQuery({
    queryKey: ["kaw-daily-snapshots"],
    queryFn: fetchSnapshots,
    enabled,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
