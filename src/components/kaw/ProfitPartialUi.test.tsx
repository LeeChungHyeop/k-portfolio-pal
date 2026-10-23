// @vitest-environment jsdom
// 부분 성과 UI — 요약 칩 하나, 상태 한 문장, '전체 기간 미확정'과 '확인 구간 성과'의 분리, 부분 막대 구분과 선택.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BarShape,
  PeriodDetail,
  ProfitResultsPanel,
  ProfitSummaryChip,
  detailStatus,
  groupExcludedDays,
  periodOptionLabel,
  type ProfitSummary,
} from "./ProfitAnalysisSection";
import type { PartialPerformance, PeriodResult } from "@/lib/kaw/profit-analysis";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const normal: PeriodResult = {
  key: "2026-09", label: "2026.09", openDate: "2026-09-01", closeDate: "2026-09-30",
  beginningTotal: 10_000_000, endingTotal: 10_100_000, netCashflow: 0, knownProfit: 100_000,
  incomeLowerBound: 0, incomeUpperBound: 0, incomeHeadroom: 0, averageCapital: 10_000_000,
  returnPctLow: 1, returnPctHigh: 1, holdingsSources: ["ledger"], cashQuality: "derived",
  span: "full", exact: true, estimated: false, denominatorEstimated: false, estimateReasons: [], estimatedDates: [],
  partial: null,
};

const partialOct: PartialPerformance = {
  runs: [
    { openDate: "2026-10-01", closeDate: "2026-10-01", tradingDays: 1, beginningTotal: 2000, endingTotal: 2020, netCashflow: 0, knownProfit: 20, averageCapital: 2000, returnPctLow: 1, returnPctHigh: 1, denominatorEstimated: false },
    { openDate: "2026-10-15", closeDate: "2026-10-20", tradingDays: 4, beginningTotal: 2047, endingTotal: 2143, netCashflow: 0, knownProfit: 96, averageCapital: 2047, returnPctLow: 4.6897, returnPctHigh: 4.6897, denominatorEstimated: true },
  ],
  includedDates: ["2026-10-01", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"],
  excludedDays: [
    { date: "2026-10-02", reasons: ["exit_date_unconfirmed"] }, { date: "2026-10-06", reasons: ["exit_date_unconfirmed"] },
    { date: "2026-10-07", reasons: ["exit_date_unconfirmed"] }, { date: "2026-10-08", reasons: ["exit_date_unconfirmed"] },
    { date: "2026-10-12", reasons: ["exit_date_unconfirmed"] },
    { date: "2026-10-13", reasons: ["exit_price_proxy", "exit_date_unconfirmed"] },
    { date: "2026-10-14", reasons: ["cash_error_not_cancelled"] },
  ],
  measuredDays: 5, totalDays: 12, unmeasuredBreaks: 0, unpricedDays: [], knownProfit: 116, returnPctLow: 5.7366, returnPctHigh: 5.7366,
  denominatorEstimated: true, basis: "linked-modified-dietz",
};
const oct: PeriodResult = {
  ...normal, key: "2026-10", label: "2026.10", openDate: "2026-10-01", closeDate: "2026-10-20",
  exact: false, estimated: true, estimateReasons: ["exit_price_proxy", "exit_date_unconfirmed", "cash_error_not_cancelled"],
  estimatedDates: ["2026-10-13"], returnPctLow: 3.1, returnPctHigh: 3.1, knownProfit: 300, span: "in-progress", partial: partialOct,
};

const mounted: { root: Root; el: HTMLElement }[] = [];
function mount(node: React.ReactElement): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  mounted.push({ root, el });
  return el;
}
afterEach(() => {
  while (mounted.length) {
    const { root, el } = mounted.pop()!;
    act(() => root.unmount());
    el.remove();
  }
});
const has = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) !== null;
const text = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

describe("detailStatus / groupExcludedDays", () => {
  it("상태 4종과 월/연 문구", () => {
    expect(detailStatus(normal).level).toBe("confirmed");
    expect(detailStatus({ ...normal, exact: false, denominatorEstimated: true }).level).toBe("approx");
    expect(detailStatus(oct).level).toBe("partial");
    expect(detailStatus(oct).headline).toContain("가격 확인일 기준 5/12");
    expect(detailStatus(oct).headline).toContain("미확정 구간을 제외한 부분 성과");
    expect(detailStatus(oct).headline).toContain("전체 월 기간은 미확정");
    expect(detailStatus({ ...oct, partial: null }).level).toBe("unconfirmed");
    expect(detailStatus({ ...oct, key: "2026", partial: partialOct }).headline).toContain("전체 연 기간은 미확정");
  });

  it("제외 날짜는 사유가 같고 사이에 확인된 날이 없는 연속 묶음으로 줄어든다", () => {
    expect(groupExcludedDays(partialOct).map((g) => [g.from, g.to, g.days, g.reasons.join("+")])).toEqual([
      ["2026-10-02", "2026-10-12", 5, "exit_date_unconfirmed"],
      ["2026-10-13", "2026-10-13", 1, "exit_price_proxy+exit_date_unconfirmed"],
      ["2026-10-14", "2026-10-14", 1, "cash_error_not_cancelled"],
    ]);
  });
});

describe("요약 칩 — 헤더에는 하나만", () => {
  const sum = (o: Partial<ProfitSummary> = {}): ProfitSummary => ({
    nonExact: 0, estimated: 0, partial: 0, denominatorEstimated: 0, anchorUsed: false, pending: false, unknown: false, total: 5, ...o,
  });
  it("경고가 여럿이어도 칩은 하나이고, 종류별 내역은 펼침 안에 있다 (배지 없음)", () => {
    const el = mount(
      <ProfitSummaryChip summary={sum({ estimated: 2, partial: 1, denominatorEstimated: 3, anchorUsed: true, pending: true, unknown: true })} />,
    );
    expect(el.querySelectorAll('[data-testid="summary-chip"]')).toHaveLength(1);
    expect(el.querySelectorAll("span[title]")).toHaveLength(0); // 개별 경고 배지를 늘어놓지 않는다
    expect(el.querySelector("summary")!.textContent).toContain("일부 구간 미확정");
    const items = [...el.querySelectorAll('[data-testid="summary-details"] li')].map((l) => l.textContent!);
    expect(items).toHaveLength(5);
    expect(items[0]).toContain("추정 포함 2개 구간");
    expect(items[0]).toContain("그중 1개 구간은 미확정 구간을 제외한 부분 성과(월/연 전체 수익률 아님)");
    expect(items.join()).toContain("분모 추정 3개 구간");
    expect(el.querySelector("details")!.hasAttribute("open")).toBe(false); // 기본은 접힘
  });

  it("추정이 없고 근사값 안내만 있으면 '일부 근사값', 아무것도 없으면 칩이 없다", () => {
    expect(mount(<ProfitSummaryChip summary={sum({ denominatorEstimated: 1 })} />).querySelector("summary")!.textContent).toContain("일부 근사값");
    expect(has(mount(<ProfitSummaryChip summary={sum()} />), "summary-chip")).toBe(false);
    expect(has(mount(<ProfitSummaryChip summary={sum({ estimated: 1, total: 0 })} />), "summary-chip")).toBe(false);
  });

  it("부분 성과가 없는 추정 구간은 '막대를 그리지 않는다'고 안내한다", () => {
    const el = mount(<ProfitSummaryChip summary={sum({ estimated: 1 })} />);
    expect(text(el, "summary-details")).toContain("막대를 그리지 않습니다");
  });
});

describe("상세 카드 — 전체 기간 미확정과 확인 구간 성과를 분리", () => {
  it("정상(원장 기준 확정) 구간은 기존 UI 그대로다: 상태 문장·접힘 없음", () => {
    const el = mount(<PeriodDetail r={normal} />);
    expect(has(el, "period-detail")).toBe(false);
    expect(has(el, "status-headline")).toBe(false);
    expect(has(el, "provenance-details")).toBe(false);
    expect(el.textContent).toContain("원장 기준");
    expect(el.textContent).toContain("+1.00%");
  });

  it("부분 성과: 상태 한 문장 + 전체 월 수익률 '미확정' + 확인 구간 성과 상자가 따로 보인다", () => {
    const el = mount(<PeriodDetail r={oct} />);
    expect(text(el, "status-headline")).toContain("가격 확인일 기준 5/12");
    expect(text(el, "whole-period")).toContain("전체 월 수익률");
    expect(text(el, "whole-period")).toContain("미확정");
    const box = text(el, "partial-box");
    expect(box).toContain("부분 성과 · 미확정 구간 제외 · 월 전체 수익률 아님");
    expect(box).toContain("확인 구간 연결수익률 (분모 근사)"); // 분모 추정 run 포함
    expect(box).toContain("+5.74%");
    expect(box).toContain("확인 구간 손익 합계");
    expect(box).toContain("확인 구간 손익 합계+116");
    expect(box).toContain("커버리지 (가격 확인일 기준)확인 5/12 (42%) · 제외 7일");
  });

  it("포함 run 의 날짜, 제외 날짜와 사유가 표시된다", () => {
    const runs = text(mount(<PeriodDetail r={oct} />), "partial-runs");
    expect(runs).toContain("확인 10/01 (1일)");
    expect(runs).toContain("확인 10/15 ~ 10/20 (4일)");
    expect(runs).toContain("제외 10/02 ~ 10/12 (5일) · 매도일 불확실");
    expect(runs).toContain("제외 10/13 (1일) · 추정 청산가 · 매도일 불확실");
    expect(runs).toContain("제외 10/14 (1일) · 현금 오차 상쇄 불가");
  });

  it("월 전체를 대표하지 않는다는 안내와, 제외 기간을 0% 로 확정한 것이 아니라는 안내가 있다", () => {
    const d = text(mount(<PeriodDetail r={oct} />), "partial-disclaimer");
    expect(d).toContain("계산에 넣지 않았을 뿐 수익률 0% 로 가정하거나 확정한 것이 아닙니다");
    expect(d).toContain("월 전체 수익률이 아닙니다");
    expect(d).toContain("가격이 확인된 거래일 기준");
    expect(d).not.toContain("하루뿐");
  });

  it("하루만 확인된 구간은 대표성이 매우 낮다고 안내한다 / 연간은 '연' 문구", () => {
    const one: PartialPerformance = { ...partialOct, runs: [partialOct.runs[0]], includedDates: ["2026-10-01"], measuredDays: 1, denominatorEstimated: false };
    const el = mount(<PeriodDetail r={{ ...oct, key: "2026", label: "2026년", partial: one }} />);
    expect(text(el, "partial-disclaimer")).toContain("확인된 거래일이 하루뿐이라 대표성이 매우 낮습니다");
    expect(text(el, "partial-disclaimer")).toContain("연 전체 수익률이 아닙니다");
    expect(text(el, "partial-box")).toContain("부분 성과 · 미확정 구간 제외 · 연 전체 수익률 아님");
  });

  it("부분 수익률이 계산 불가(null)이면 '계산 불가' — 0.00% 가 아니다", () => {
    const el = mount(<PeriodDetail r={{ ...oct, partial: { ...partialOct, returnPctLow: null, returnPctHigh: null } }} />);
    expect(text(el, "partial-box")).toContain("계산 불가");
    expect(text(el, "partial-box")).not.toContain("0.00%");
  });

  it("실제 0% 부분 수익률은 +0.00% 로 보인다", () => {
    const el = mount(<PeriodDetail r={{ ...oct, partial: { ...partialOct, returnPctLow: 0, returnPctHigh: 0 } }} />);
    expect(text(el, "partial-box")).toContain("+0.00%");
  });

  it("평가 불가일에 숨은 추정으로 갈린 run 은 미확인 구간 안내를 보인다", () => {
    const el = mount(<PeriodDetail r={{ ...oct, partial: { ...partialOct, unmeasuredBreaks: 1 } }} />);
    expect(text(el, "partial-disclaimer")).toContain("미확인 구간이 1곳");
  });

  it("분모 추정·미관측 수입·현금 품질 경고는 상세(근거 자세히) 안에 유지된다", () => {
    const el = mount(<PeriodDetail r={{ ...oct, cashQuality: "anchor-implied", holdingsSources: ["ledger", "anchor"] }} />);
    const details = el.querySelector('[data-testid="provenance-details"]')!;
    expect(details.hasAttribute("open")).toBe(false);
    for (const t of ["추정 포함 · 미확정", "리밸런싱 기록 기준", "리밸런싱 기록 보유수량"]) expect(details.textContent).toContain(t);
    expect(has(el, "estimate-notice")).toBe(true);
    expect(details.textContent).toContain("미관측 현금수입");
    // 헤더(상세 밖)에는 경고 배지가 반복되지 않는다 — 상태 한 문장만
    const outside = el.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="provenance-details"]')!.remove();
    expect(outside.textContent).not.toContain("리밸런싱 기록 기준");
    expect(outside.textContent).not.toContain("추정 포함 · 미확정");
  });

  it("부분 성과가 없는 미확정 구간: 상태 문장은 '확인 가능한 연속 구간이 없어 참고값만', 막대 없음 안내", () => {
    const el = mount(<PeriodDetail r={{ ...oct, partial: null }} />);
    expect(text(el, "status-headline")).toContain("확인 가능한 연속 구간이 없어 참고값만 있습니다");
    expect(has(el, "partial-box")).toBe(false);
    expect(text(el, "whole-period")).toContain("미확정");
  });

  it("분모 추정만 있는 구간(손익 상쇄 입증): '근사값' 한 문장, 숫자 표는 그대로 보이고 확정 문구는 없다", () => {
    const el = mount(<PeriodDetail r={{ ...normal, exact: false, denominatorEstimated: true }} />);
    expect(text(el, "status-headline")).toContain("근사값");
    expect(has(el, "partial-box")).toBe(false);
    expect(has(el, "whole-period")).toBe(false);
    expect(el.textContent).toContain("기간 수익률 (분모 추정)");
    expect(el.textContent).not.toContain("수익금 확정");
  });
});

describe("부분 성과의 의미 — 전체 수익률로 오인되지 않게", () => {
  it("분모 추정이 포함되면 '근사값' 안내가 있고, 포함되지 않으면 없다", () => {
    expect(text(mount(<PeriodDetail r={oct} />), "partial-disclaimer")).toContain("수익률은 근사값입니다");
    const clean: PartialPerformance = { ...partialOct, denominatorEstimated: false };
    expect(text(mount(<PeriodDetail r={{ ...oct, partial: clean }} />), "partial-disclaimer")).not.toContain("근사값");
  });

  it("제외 구간을 수익률 0% 로 확정한 것처럼 쓰지 않는다 — '가정하거나 확정한 것이 아닙니다'", () => {
    const box = text(mount(<PeriodDetail r={oct} />), "partial-box");
    expect(box).toContain("수익률 0% 로 가정하거나 확정한 것이 아닙니다");
    expect(box).not.toContain("0% 로 간주");
    expect(box).not.toContain("전체 수익률은 +");
  });

  it("기본 화면(접히지 않은 부분)에 '부분 성과'와 '월 전체 수익률 아님'이 모두 보인다", () => {
    const el = mount(<PeriodDetail r={oct} />);
    const outside = el.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="provenance-details"]')!.remove();
    expect(outside.textContent).toContain("부분 성과");
    expect(outside.textContent).toContain("미확정 구간 제외");
    expect(outside.textContent).toContain("월 전체 수익률 아님");
    expect(outside.textContent).toContain("전체 월 수익률");
    expect(outside.textContent).toContain("미확정");
  });

  it("커버리지는 가격 확인일 기준이고, 평가 불가일은 분모에 없다고 따로 안내한다", () => {
    const missing: PartialPerformance = { ...partialOct, measuredDays: 4, totalDays: 11, unpricedDays: ["2026-10-16"] };
    const el = mount(<PeriodDetail r={{ ...oct, partial: missing }} />);
    expect(text(el, "partial-box")).toContain("커버리지 (가격 확인일 기준)확인 4/11");
    const d = text(el, "partial-disclaimer");
    expect(d).toContain("가격이 없어 평가하지 못한 1일(10/16)은 분모에 들어 있지 않아");
    expect(d).toContain("실제 거래일 기준 커버리지는 이보다 낮을 수 있습니다");
    expect(text(mount(<PeriodDetail r={oct} />), "partial-disclaimer")).not.toContain("평가하지 못한");
  });
});

describe("부분 성과 막대와 선택 (차트 패널)", () => {
  const origRect = HTMLElement.prototype.getBoundingClientRect;
  let offsetDesc: PropertyDescriptor | undefined;
  beforeAll(() => {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 400, height: 208, left: 0, top: 0, right: 400, bottom: 208, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    offsetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 400 });
    return () => {
      HTMLElement.prototype.getBoundingClientRect = origRect;
      if (offsetDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetDesc);
    };
  });

  const results = (): PeriodResult[] => [normal, oct]; // 확정 달, 부분 성과 달
  function Harness(p: { period: "monthly" | "yearly"; metric: "pct" | "amount"; results: PeriodResult[] }) {
    const [key, setKey] = useState<string | null>(null);
    return <ProfitResultsPanel period={p.period} metric={p.metric} results={p.results} up="#1baf7a" down="#e34948" selectedKey={key} onSelect={setKey} />;
  }
  const label = (el: HTMLElement) => el.querySelector(".rounded-xl .font-semibold")?.textContent;
  function click(wrapper: Element, x: number) {
    const ev = new MouseEvent("click", { bubbles: true, clientX: x, clientY: 100 });
    Object.defineProperty(ev, "pageX", { value: x });
    Object.defineProperty(ev, "pageY", { value: 100 });
    act(() => { wrapper.dispatchEvent(ev); });
  }
  const pick = (el: HTMLElement, key: string) => {
    const sel = el.querySelector('[data-testid="period-picker"]') as HTMLSelectElement;
    act(() => { sel.value = key; sel.dispatchEvent(new Event("change", { bubbles: true })); });
  };

  it("부분 성과 달은 점선·'부분' 막대로 그려지고 범례가 나온다. 확정 달만 있으면 범례가 없다", () => {
    const el = mount(<Harness period="monthly" metric="pct" results={results()} />);
    expect(el.querySelectorAll('[data-testid="partial-bar"]')).toHaveLength(1);
    const bar = el.querySelector('[data-testid="partial-bar"]')!;
    expect(bar.querySelector("path, rect")!.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(bar.textContent).toBe("부분");
    expect(text(el, "partial-legend")).toContain("미확정 구간을 제외한 부분 성과");
    expect(text(el, "partial-legend")).toContain("월/연 전체 수익률이 아닙니다");
    expect(text(el, "partial-legend")).toContain("근사값");
    expect(el.innerHTML).not.toContain("NaN");

    const only = mount(<Harness period="monthly" metric="pct" results={[normal]} />);
    expect(has(only, "partial-bar")).toBe(false);
    expect(has(only, "partial-legend")).toBe(false);
  });

  it("확정 막대 모양은 그대로다 — 점선·반투명이 아니다 (BarShape 직접 확인)", () => {
    const el = mount(
      <svg>
        <BarShape x={0} y={10} width={30} height={50} fill="#1baf7a" payload={{ bar: 1, barKind: "confirmed" }} />
        <BarShape x={40} y={10} width={30} height={50} fill="#1baf7a" payload={{ bar: 1, barKind: "partial" }} />
        <BarShape x={80} y={10} width={30} height={50} fill="#1baf7a" payload={{ bar: null, barKind: "none" }} />
        <BarShape x={120} y={10} width={30} height={0} fill="#1baf7a" payload={{ bar: 0, barKind: "confirmed" }} />
      </svg>,
    );
    expect(el.querySelectorAll('[data-testid="partial-bar"]')).toHaveLength(1);
    expect(el.querySelectorAll("[stroke-dasharray]")).toHaveLength(1);
    expect(el.querySelectorAll("rect[height='2']")).toHaveLength(1); // 실제 0% 는 얇은 선
  });

  it("월간과 연간 모두 부분 막대가 같은 방식으로 그려진다", () => {
    for (const period of ["monthly", "yearly"] as const) {
      const el = mount(<Harness period={period} metric="amount" results={[{ ...oct, key: period === "yearly" ? "2026" : "2026-10" }]} />);
      expect(el.querySelectorAll('[data-testid="partial-bar"]')).toHaveLength(1);
    }
  });

  it("부분 막대 슬롯 클릭으로 상세가 열린다 (null 슬롯 선택과 같은 경로)", () => {
    const el = mount(<Harness period="monthly" metric="pct" results={results()} />);
    expect(label(el)).toBe("2026.10"); // 처음엔 마지막 구간
    const wrapper = el.querySelector(".recharts-wrapper")!;
    const left = 44, width = 400 - 44 - 8;
    click(wrapper, Math.round(left + 0.5 * (width / 2)));
    expect(label(el)).toBe("2026.09");
    click(wrapper, Math.round(left + 1.5 * (width / 2)));
    expect(label(el)).toBe("2026.10");
    expect(has(el, "partial-box")).toBe(true);
  });

  it("모바일 대체 수단: 구간 선택 select 에 부분 성과가 적히고, 고르면 상세가 바뀐다", () => {
    const el = mount(<Harness period="monthly" metric="pct" results={results()} />);
    const options = [...el.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["2026.09", "2026.10 · 부분 성과(미확정 구간 제외, 가격 확인일 5/12)"]);
    pick(el, "2026-09");
    expect(label(el)).toBe("2026.09");
    expect(has(el, "partial-box")).toBe(false);
    pick(el, "2026-10");
    expect(has(el, "partial-box")).toBe(true);
  });

  it("metric 전환: 부분 막대는 수익금에서도 그려지고, 수익률이 null 이면 수익률 쪽만 막대가 없다", () => {
    const nullPct = { ...oct, partial: { ...partialOct, returnPctLow: null, returnPctHigh: null } };
    const pct = mount(<Harness period="monthly" metric="pct" results={[normal, nullPct]} />);
    expect(has(pct, "partial-bar")).toBe(false);
    expect([...pct.querySelectorAll("option")][1].textContent).toBe("2026.10 · 추정 포함(막대 없음)");
    const amt = mount(<Harness period="monthly" metric="amount" results={[normal, nullPct]} />);
    expect(amt.querySelectorAll('[data-testid="partial-bar"]')).toHaveLength(1);
    expect(periodOptionLabel(nullPct, "amount")).toBe("2026.10 · 부분 성과(미확정 구간 제외, 가격 확인일 5/12)");
  });

  it("부분 성과가 없고 전부 추정인 달은 막대가 없다 (0% 로 그리지 않는다)", () => {
    const el = mount(<Harness period="monthly" metric="pct" results={[{ ...oct, partial: null }]} />);
    expect(has(el, "partial-bar")).toBe(false);
    expect(el.querySelectorAll(".recharts-bar-rectangle path, .recharts-bar-rectangle rect")).toHaveLength(0);
    expect(has(el, "partial-legend")).toBe(false);
  });
});
