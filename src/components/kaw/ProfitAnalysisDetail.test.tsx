// @vitest-environment jsdom
// 수익 분석 상세 카드 — 추정 포함 구간은 확정값처럼 보이지 않고, 0% 와 계산 불가(null)는 다르게 보인다.
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { BarShape, PeriodDetail } from "./ProfitAnalysisSection";
import type { PeriodResult } from "@/lib/kaw/profit-analysis";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base: PeriodResult = {
  key: "2026-10-13", label: "10/13", openDate: "2026-10-13", closeDate: "2026-10-13",
  beginningTotal: 10_000_000, endingTotal: 10_100_000, netCashflow: 0, knownProfit: 100_000,
  incomeLowerBound: 0, incomeUpperBound: 0, incomeHeadroom: 0, averageCapital: 10_000_000,
  returnPctLow: 1, returnPctHigh: 1, holdingsSources: ["ledger"], cashQuality: "derived",
  span: "full", exact: true, estimated: false, denominatorEstimated: false, estimateReasons: [], estimatedDates: [],
};

function render(r: PeriodResult): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  act(() => createRoot(el).render(<PeriodDetail r={r} />));
  return el;
}

describe("PeriodDetail — 확정 / 추정 포함 / 계산 불가 / 0%", () => {
  it("확정 구간: 원장 기준 badge, 추정 안내 없음", () => {
    const el = render(base);
    expect(el.textContent).toContain("원장 기준");
    expect(el.textContent).not.toContain("추정 포함");
    expect(el.querySelector('[data-testid="estimate-notice"]')).toBeNull();
    expect(el.textContent).toContain("+1.00%");
  });

  it("추정 포함 구간: 미확정 badge, 사유·날짜, 참고값 라벨, 손익·수익률에 상승/하락 색을 쓰지 않는다", () => {
    const el = render({
      ...base, exact: false, estimated: true,
      estimateReasons: ["exit_price_proxy", "exit_date_unconfirmed"], estimatedDates: ["2026-10-13"],
    });
    expect(el.textContent).toContain("추정 포함 · 미확정");
    expect(el.textContent).not.toContain("원장 기준");
    const notice = el.querySelector('[data-testid="estimate-notice"]')!;
    expect(notice.textContent).toContain("2026-10-13");
    expect(notice.textContent).toContain("추정(가격 대용)");
    expect(notice.textContent).toContain("실제 매도 일자가 확인되지 않았습니다");
    expect(el.textContent).toContain("기간 수익률 (참고값 · 미확정)");
    expect(el.textContent).toContain("기간 손익 (계산 참고값 · 미확정)");
    expect(el.innerHTML).not.toContain("text-emerald-500");
    expect(el.innerHTML).not.toContain("text-rose-500");
    // 참고값 자체는 숨기지도 보정하지도 않는다
    expect(el.textContent).toContain("+1.00%");
  });

  it("분모만 추정인 구간: 수익금은 확정 스타일 유지, 분모 추정 안내와 라벨, 원장 기준 badge 아님", () => {
    const el = render({ ...base, exact: false, denominatorEstimated: true });
    expect(el.textContent).toContain("수익금 확정 · 분모 추정");
    expect(el.textContent).not.toContain("원장 기준");
    expect(el.textContent).not.toContain("추정 포함 · 미확정");
    expect(el.querySelector('[data-testid="denominator-notice"]')!.textContent).toContain("상쇄");
    expect(el.querySelector('[data-testid="estimate-notice"]')).toBeNull();
    expect(el.textContent).toContain("기간 손익");
    expect(el.textContent).not.toContain("기간 손익 (계산 참고값");
    expect(el.textContent).toContain("기간 수익률 (분모 추정)");
    expect(el.innerHTML).toContain("text-emerald-500"); // 확정 손익은 정상 색
  });

  it("계산 불가(null)는 0% 가 아니라 '계산 불가' 로 보인다", () => {
    const el = render({ ...base, returnPctLow: null, returnPctHigh: null, averageCapital: 0 });
    expect(el.textContent).toContain("계산 불가");
    expect(el.textContent).not.toContain("0.00%");
  });

  it("실제 0% 는 0.00% 로 정상 표시된다", () => {
    const el = render({ ...base, knownProfit: 0, returnPctLow: 0, returnPctHigh: 0 });
    expect(el.textContent).toContain("+0.00%");
    expect(el.textContent).not.toContain("계산 불가");
  });
});

// ── 그래프의 null 처리 ──────────────────────────────────────────────────────

import { BarChart, Bar, Cell, XAxis, YAxis, ReferenceLine } from "recharts";
import { barYDomain } from "@/lib/kaw/profit-analysis";

describe("막대 그래프의 null 처리", () => {
  it("Y축 범위: null 은 범위에 영향이 없고 0 은 기준선으로 포함, 전부 null 이어도 유한하다", () => {
    expect(barYDomain([null, null])).toEqual([0, 1]);
    expect(barYDomain([])).toEqual([0, 1]);
    const [lo, hi] = barYDomain([null, 2, null, -1]);
    expect(lo).toBeLessThan(-1);
    expect(hi).toBeGreaterThan(2);
    expect(barYDomain([0, 0])).toEqual([-1, 1]); // 실제 0 만 있어도 범위가 깨지지 않는다
    expect(barYDomain([null, 3])[0]).toBeLessThanOrEqual(0); // 0 기준선 포함
  });

  it("null·0·양수·음수가 섞인 데이터를 Recharts 로 그려도 NaN 이 없고, 0 은 막대로 남고 null 은 생략된다", () => {
    const data = [
      { key: "a", bar: null as number | null },
      { key: "b", bar: 0 as number | null },
      { key: "c", bar: 2 as number | null },
      { key: "d", bar: -1 as number | null },
    ];
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() =>
      createRoot(el).render(
        <BarChart width={400} height={200} data={data}>
          <XAxis dataKey="key" />
          <YAxis domain={barYDomain(data.map((d) => d.bar))} />
          <ReferenceLine y={0} />
          <Bar dataKey="bar" shape={BarShape} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.bar !== null && d.bar < 0 ? "#e34948" : "#1baf7a"} />
            ))}
          </Bar>
        </BarChart>,
      ),
    );
    expect(el.innerHTML).not.toContain("NaN");
    expect(el.innerHTML).not.toContain("undefined");
    // 값이 있는 3개(0 은 얇은 선, 2, -1)만 그려지고 null 은 아무것도 그려지지 않는다
    const drawn = [...el.querySelectorAll(".recharts-bar-rectangle path, .recharts-bar-rectangle rect")];
    expect(drawn.length).toBe(3);
  });
});
