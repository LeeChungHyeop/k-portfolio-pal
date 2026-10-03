import { describe, it, expect } from "vitest";
import {
  buildDailySnapshotRows,
  kstDateString,
  kstMonthString,
  kstTimeString,
  SNAPSHOT_UPSERT_CONFLICT,
  type SnapshotAccountInput,
  type SnapshotPrice,
} from "./snapshot";

const TICKERS = new Map<string, string>([
  ["TIGER 미국S&P500", "360750"],
  ["KIWOOM 200TR", "294400"],
]);

function prices(entries: Array<[string, number, string?]>): Map<string, SnapshotPrice> {
  return new Map(entries.map(([t, p, at]) => [t, { price: p, fetchedAt: at ?? "2026-10-01T06:40:00.000Z" }]));
}

const account = (over: Partial<SnapshotAccountInput> = {}): SnapshotAccountInput => ({
  familyCode: "soye",
  profile: "hyeobi",
  accountType: "retirement",
  history: [
    {
      date: "2026-09-01",
      rowQuantitiesSnap: { us: 10 },
      rowEtfSnap: { us: "TIGER 미국S&P500" },
    },
    {
      date: "2026-10-01",
      rowQuantitiesSnap: { us: 100, kr: 2 },
      rowEtfSnap: { us: "TIGER 미국S&P500", kr: "KIWOOM 200TR" },
    },
  ],
  cashBalance: 3_621,
  ...over,
});

describe("buildDailySnapshotRows — 금액 정의", () => {
  const px = prices([["360750", 25_965], ["294400", 146_370]]);

  it("ETF 평가액 = 마지막 확정 history 의 수량 x 시세", () => {
    const { rows } = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].market_value).toBe(100 * 25_965 + 2 * 146_370);
    expect(rows[0].holding_count).toBe(2);
  });

  it("총자산 = ETF 평가액 + 실제 예수금", () => {
    const { rows } = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01");
    expect(rows[0].cash_balance).toBe(3_621);
    expect(rows[0].total_asset_value).toBe(rows[0].market_value + rows[0].cash_balance);
  });

  it("예수금 미입력은 0으로 본다", () => {
    const { rows } = buildDailySnapshotRows([account({ cashBalance: undefined })], TICKERS, px, "2026-10-01");
    expect(rows[0].cash_balance).toBe(0);
    expect(rows[0].total_asset_value).toBe(rows[0].market_value);
  });

  it("오래된 history(2026-09-01) 수량을 쓰지 않는다 — 마지막 확정 기록만", () => {
    const { rows } = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01");
    expect(rows[0].market_value).not.toBe(10 * 25_965);
  });

  it("외부 입출금(cashflow)을 행에 담지 않는다 — source of truth 는 앱의 장부다", () => {
    const { rows } = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01");
    // 장부를 나중에 고쳐도 stale 해지지 않도록, 스냅샷에는 평가액만 남긴다.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "account_type", "cash_balance", "family_code", "holding_count",
      "market_value", "price_fetched_at", "profile", "snapshot_date", "total_asset_value",
    ]);
    expect("net_cashflow" in rows[0]).toBe(false);
  });

  it("평가에 쓴 시세 중 가장 오래된 조회시각을 남긴다", () => {
    const { rows } = buildDailySnapshotRows(
      [account()],
      TICKERS,
      prices([["360750", 25_965, "2026-10-01T06:40:00.000Z"], ["294400", 146_370, "2026-10-01T06:30:00.000Z"]]),
      "2026-10-01",
    );
    expect(rows[0].price_fetched_at).toBe("2026-10-01T06:30:00.000Z");
  });
});

describe("buildDailySnapshotRows — 틀린 값을 만들지 않는 규칙", () => {
  it("신선한 시세가 없는 종목이 하나라도 있으면 그 계좌의 행을 만들지 않는다", () => {
    const partial = prices([["360750", 25_965]]); // KIWOOM 200TR 시세 없음
    const { rows, skipped } = buildDailySnapshotRows([account()], TICKERS, partial, "2026-10-01");
    expect(rows).toHaveLength(0);
    expect(skipped[0].reason).toContain("시세 없음/오래됨");
  });

  it("스냅샷 평가금액(rowHoldingsSnap) 으로 폴백하지 않는다", () => {
    const withFallback: SnapshotAccountInput = account({
      history: [{
        date: "2026-10-01",
        rowQuantitiesSnap: { us: 100 },
        rowEtfSnap: { us: "알 수 없는 ETF" },
        // rowHoldingsSnap 이 있어도 쓰지 않는다
        ...({ rowHoldingsSnap: { us: 99_999_999 } } as object),
      }],
    });
    const { rows } = buildDailySnapshotRows([withFallback], TICKERS, prices([["360750", 1]]), "2026-10-01");
    expect(rows).toHaveLength(0);
  });

  it("history 가 없으면 건너뛴다", () => {
    const { rows, skipped } = buildDailySnapshotRows([account({ history: [] })], TICKERS, prices([]), "2026-10-01");
    expect(rows).toHaveLength(0);
    expect(skipped[0].reason).toBe("history 없음");
  });

  it("확정 보유수량이 비어 있으면 건너뛴다", () => {
    const { rows, skipped } = buildDailySnapshotRows(
      [account({ history: [{ date: "2026-10-01", rowQuantitiesSnap: {} }] })],
      TICKERS, prices([["360750", 1]]), "2026-10-01",
    );
    expect(rows).toHaveLength(0);
    expect(skipped[0].reason).toBe("확정 보유수량 없음");
  });

  it("_shared / _meta 같은 예약 프로필은 계좌로 보지 않는다", () => {
    const { rows, skipped } = buildDailySnapshotRows(
      [account({ profile: "_shared" })],
      TICKERS, prices([["360750", 25_965], ["294400", 146_370]]), "2026-10-01",
    );
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(0); // 건너뛴 게 아니라 대상이 아니다
  });

  it("수량 0 이하인 행은 평가에서 제외한다", () => {
    const { rows } = buildDailySnapshotRows(
      [account({
        history: [{
          date: "2026-10-01",
          rowQuantitiesSnap: { us: 100, kr: 0 },
          rowEtfSnap: { us: "TIGER 미국S&P500", kr: "KIWOOM 200TR" },
        }],
      })],
      TICKERS, prices([["360750", 25_965]]), "2026-10-01",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].holding_count).toBe(1);
    expect(rows[0].market_value).toBe(100 * 25_965);
  });
});

describe("같은 날 여러 번 돌아도 한 행만 — upsert 키", () => {
  const px = prices([["360750", 25_965], ["294400", 146_370]]);

  it("같은 입력이면 같은 PK 를 낸다 (upsert 로 덮어쓰기)", () => {
    const a = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01").rows[0];
    const b = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01").rows[0];
    const key = (r: typeof a) => [r.family_code, r.profile, r.account_type, r.snapshot_date].join("|");
    expect(key(a)).toBe(key(b));
    expect(a).toEqual(b);
  });

  it("시세가 바뀌면 같은 PK 에 새 금액이 들어간다 (행이 늘지 않는다)", () => {
    const later = buildDailySnapshotRows(
      [account()], TICKERS, prices([["360750", 26_000], ["294400", 146_370]]), "2026-10-01",
    ).rows[0];
    const earlier = buildDailySnapshotRows([account()], TICKERS, px, "2026-10-01").rows[0];
    expect(later.snapshot_date).toBe(earlier.snapshot_date);
    expect(later.market_value).not.toBe(earlier.market_value);
  });

  it("한 번의 실행에서 같은 PK 가 두 번 나오지 않는다", () => {
    const { rows } = buildDailySnapshotRows(
      [
        account({ accountType: "retirement" }),
        account({ accountType: "isa" }),
        account({ accountType: "pension" }),
        account({ accountType: "irp" }),
      ],
      TICKERS, px, "2026-10-01",
    );
    const keys = rows.map((r) => [r.family_code, r.profile, r.account_type, r.snapshot_date].join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(4);
  });

  it("upsert conflict 컬럼이 테이블 PK 와 같다", () => {
    expect(SNAPSHOT_UPSERT_CONFLICT).toBe("family_code,profile,account_type,snapshot_date");
  });
});

describe("KST 변환 — 스냅샷 날짜·슬롯 판정", () => {
  it("UTC 06:40 = 한국시간 15:40 (장 마감 후 마지막 cron 슬롯)", () => {
    const at = new Date("2026-10-01T06:40:00.000Z");
    expect(kstTimeString(at)).toBe("15:40");
    expect(kstDateString(at)).toBe("2026-10-01");
  });

  it("UTC 자정 직전은 한국시간으로 다음 날", () => {
    const at = new Date("2026-10-01T23:30:00.000Z");
    expect(kstDateString(at)).toBe("2026-10-02");
  });

  it("다른 cron 슬롯은 15:40 이 아니다 (스냅샷을 쓰지 않는 시각)", () => {
    expect(kstTimeString(new Date("2026-10-01T06:30:00.000Z"))).toBe("15:30");
    expect(kstTimeString(new Date("2026-10-01T00:00:00.000Z"))).toBe("09:00");
  });
});

describe("kstMonthString — 정기납입 적용 시작월(YYYY-MM)", () => {
  it("월 경계: UTC 2026-10-31 15:30 = KST 2026-11-01 00:30 → 2026-11", () => {
    const at = new Date("2026-10-31T15:30:00.000Z");
    expect(kstDateString(at)).toBe("2026-11-01");
    expect(kstMonthString(at)).toBe("2026-11");
    // UTC 로 그냥 자르면 이전 달이 나온다 — 이 버그를 막는 테스트다
    expect(at.toISOString().slice(0, 7)).toBe("2026-10");
  });

  it("그 달 마지막 순간: UTC 2026-11-01 14:59 = KST 2026-11-01 23:59 → 2026-11", () => {
    const at = new Date("2026-11-01T14:59:00.000Z");
    expect(kstMonthString(at)).toBe("2026-11");
  });

  it("낮 시간대는 UTC·KST 월이 같다", () => {
    expect(kstMonthString(new Date("2026-11-15T03:00:00.000Z"))).toBe("2026-11");
    expect(kstMonthString(new Date("2026-11-15T23:00:00.000Z"))).toBe("2026-11");
  });

  it("연 경계도 KST 기준으로 넘어간다: UTC 2026-12-31 15:00 → 2027-01", () => {
    expect(kstMonthString(new Date("2026-12-31T15:00:00.000Z"))).toBe("2027-01");
  });

  it("월말 UTC 오전은 아직 같은 달이다: UTC 2026-10-31 09:00 = KST 18:00 → 2026-10", () => {
    expect(kstMonthString(new Date("2026-10-31T09:00:00.000Z"))).toBe("2026-10");
  });
});
