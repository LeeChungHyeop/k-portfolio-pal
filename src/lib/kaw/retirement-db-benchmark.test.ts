import { describe, it, expect } from "vitest";
import {
  RETIREMENT_DB_BENCHMARK,
  dbBenchmarkLabel,
  dbBenchmarkSortDate,
  dbBenchmarkByMonth,
} from "./retirement-db-benchmark";

describe("DB 유지 가정 데이터 (historical estimate)", () => {
  it("점 개수 / 첫 값 / 마지막 값", () => {
    expect(RETIREMENT_DB_BENCHMARK).toHaveLength(19);
    expect(RETIREMENT_DB_BENCHMARK[0]).toEqual({
      month: "2025-03",
      value: 60_923_460,
      asOfDate: "2025-03-25",
    });
    const last = RETIREMENT_DB_BENCHMARK[RETIREMENT_DB_BENCHMARK.length - 1];
    expect(last.month).toBe("2026-09");
    expect(last.value).toBe(86_097_152);
  });

  it("2026-10 이후는 아직 없다 (실제 급여가 확인되면 추가한다)", () => {
    expect(RETIREMENT_DB_BENCHMARK.some((p) => p.month >= "2026-10")).toBe(false);
  });

  it("월은 YYYY-MM 형식이고 중복 없이 오름차순이다", () => {
    const months = RETIREMENT_DB_BENCHMARK.map((p) => p.month);
    months.forEach((m) => expect(m).toMatch(/^\d{4}-\d{2}$/));
    expect(months).toEqual([...months].sort());
    expect(new Set(months).size).toBe(months.length);
  });

  it("실제 일자를 아는 점은 전환일(2025-03-25) 하나뿐이다 — 나머지는 월 단위 추정", () => {
    const dated = RETIREMENT_DB_BENCHMARK.filter((p) => p.asOfDate);
    expect(dated).toHaveLength(1);
    expect(dated[0].asOfDate).toBe("2025-03-25");
  });

  it("값은 전부 양수다 (중간에 내려가는 달은 있어도 된다 — 평균임금 변동)", () => {
    RETIREMENT_DB_BENCHMARK.forEach((p) => expect(p.value).toBeGreaterThan(0));
    // 2025-12 는 실제로 직전 달보다 낮다 (단조증가를 가정하지 않는다)
    const byMonth = dbBenchmarkByMonth();
    expect(byMonth.get("2025-12")!).toBeLessThan(byMonth.get("2025-11")!);
  });
});

describe("차트용 변환 helper", () => {
  it("라벨은 YYYY.MM (리밸런싱 기록 월 라벨과 같은 형식 → 같은 점으로 합쳐진다)", () => {
    expect(dbBenchmarkLabel("2025-03")).toBe("2025.03");
    expect(dbBenchmarkLabel("2026-09")).toBe("2026.09");
  });

  it("정렬 날짜는 월말이고, 실제 일자를 아는 점은 그 날짜를 쓴다", () => {
    expect(dbBenchmarkSortDate({ month: "2025-03", value: 1, asOfDate: "2025-03-25" })).toBe("2025-03-25");
    expect(dbBenchmarkSortDate({ month: "2025-04", value: 1 })).toBe("2025-04-30");
    expect(dbBenchmarkSortDate({ month: "2025-02", value: 1 })).toBe("2025-02-28");
    expect(dbBenchmarkSortDate({ month: "2024-02", value: 1 })).toBe("2024-02-29"); // 윤년
    expect(dbBenchmarkSortDate({ month: "2025-12", value: 1 })).toBe("2025-12-31");
  });

  it("정렬 날짜 순서가 월 순서와 같다", () => {
    const dates = RETIREMENT_DB_BENCHMARK.map(dbBenchmarkSortDate);
    expect(dates).toEqual([...dates].sort());
  });

  it("월 → 금액 맵에 없는 달은 undefined 다 (보간하지 않는다)", () => {
    const byMonth = dbBenchmarkByMonth();
    expect(byMonth.get("2025-03")).toBe(60_923_460);
    expect(byMonth.get("2025-02")).toBeUndefined(); // 전환 전
    expect(byMonth.get("2026-10")).toBeUndefined(); // 아직 없음
    expect(byMonth.size).toBe(RETIREMENT_DB_BENCHMARK.length);
  });
});
