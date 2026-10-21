// @vitest-environment jsdom
// 수익 분석 상세 카드·차트 — 추정/분모 추정/현금 품질/보유수량 출처 경고는 서로 독립으로 보이고,
// 0% 와 null 은 다르게 보이며, null 슬롯도 클릭·select 로 선택된다.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BarChart, Bar, Cell, XAxis, YAxis, ReferenceLine } from "recharts";
import {
  BarShape,
  PeriodDetail,
  ProfitResultsPanel,
  periodOptionLabel,
  profitConfirmedStatement,
  selectionKeyFromChartEvent,
} from "./ProfitAnalysisSection";
import { barYDomain, type PeriodResult } from "@/lib/kaw/profit-analysis";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base: PeriodResult = {
  key: "2026-10-13", label: "10/13", openDate: "2026-10-13", closeDate: "2026-10-13",
  beginningTotal: 10_000_000, endingTotal: 10_100_000, netCashflow: 0, knownProfit: 100_000,
  incomeLowerBound: 0, incomeUpperBound: 0, incomeHeadroom: 0, averageCapital: 10_000_000,
  returnPctLow: 1, returnPctHigh: 1, holdingsSources: ["ledger"], cashQuality: "derived",
  span: "full", exact: true, estimated: false, denominatorEstimated: false, estimateReasons: [], estimatedDates: [],
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
const render = (r: PeriodResult) => mount(<PeriodDetail r={r} />);
const has = (el: HTMLElement, testId: string) => el.querySelector(`[data-testid="${testId}"]`) !== null;

describe("PeriodDetail — 확정 / 추정 / 분모 추정 / 현금 품질 / 보유수량 출처 (서로 독립)", () => {
  it("깨끗한 원장 구간: 원장 기준 badge 만, 경고·안내 없음", () => {
    const el = render(base);
    expect(el.textContent).toContain("원장 기준");
    expect(el.textContent).not.toContain("추정 포함");
    expect(el.textContent).not.toContain("분모 추정");
    expect(has(el, "estimate-notice")).toBe(false);
    expect(has(el, "denominator-notice")).toBe(false);
    expect(el.textContent).toContain("+1.00%");
  });

  it("추정 포함: 미확정 badge, 날짜·사유(가격/날짜/현금 상쇄 불가), 참고값 라벨, 상승/하락 색 없음", () => {
    const el = render({
      ...base, exact: false, estimated: true,
      estimateReasons: ["exit_price_proxy", "exit_date_unconfirmed", "cash_error_not_cancelled"],
      estimatedDates: ["2026-10-13"],
    });
    expect(el.textContent).toContain("추정 포함 · 미확정");
    expect(el.textContent).not.toContain("원장 기준");
    const notice = el.querySelector('[data-testid="estimate-notice"]')!.textContent!;
    expect(notice).toContain("2026-10-13");
    expect(notice).toContain("추정(가격 대용)");
    expect(notice).toContain("실제 매도 일자가 확인되지 않아");
    expect(notice).toContain("상쇄된다는 근거가 없습니다");
    expect(el.textContent).toContain("기간 수익률 (참고값 · 미확정)");
    expect(el.textContent).toContain("기간 손익 (계산 참고값 · 미확정)");
    expect(el.innerHTML).not.toContain("text-emerald-500");
    expect(el.innerHTML).not.toContain("text-rose-500");
    expect(el.textContent).toContain("+1.00%"); // 참고값은 지우지도 보정하지도 않는다
  });

  it("추정 청산대금과 미관측 현금수입의 불확실성은 별개로 안내된다 (잔차를 청산대금 상한으로 읽지 않는다)", () => {
    const el = render({ ...base, exact: false, estimated: true, estimateReasons: ["exit_price_proxy"], estimatedDates: ["2026-10-13"] });
    const note = el.querySelector('[data-testid="income-separate-note"]')!.textContent!;
    expect(note).toContain("별개");
    expect(note).toContain("청산대금 오차의 상한이 아닙니다");
  });

  it("분모만 추정 + 현금·보유 모두 원장 기준: '분모 추정' badge, 원장으로 계산된 값이라는 문구는 이 조합에서만", () => {
    const el = render({ ...base, exact: false, denominatorEstimated: true });
    expect(el.textContent).toContain("분모 추정");
    // exact=false 이므로 '원장 기준' badge 는 없다 (본문 문구와 구별하려고 badge 의 title 로 찾는다)
    expect(el.querySelector('span[title*="추정이 없는 구간입니다"]')).toBeNull();
    expect(has(el, "denominator-notice")).toBe(true);
    expect(has(el, "profit-confirmed")).toBe(true);
    expect(has(el, "profit-not-fully-confirmed")).toBe(false);
    expect(el.textContent).not.toContain("수익금 확정");
    expect(el.textContent).not.toContain("기간 손익은 확정입니다");
    expect(el.textContent).toContain("기간 수익률 (분모 추정)");
    expect(el.innerHTML).toContain("text-emerald-500"); // 손익은 참고값이 아니므로 정상 색
  });

  it.each([
    ["anchor-implied", "리밸런싱 기록 기준"],
    ["cashflow-pending", "입금 반영 대기"],
    ["unknown", "예수금 미확인"],
  ] as const)("분모 추정 + 현금 품질 %s: 현금 품질 badge 가 덮이지 않고, 손익 확정 문구는 나오지 않는다", (q, label) => {
    const el = render({ ...base, exact: false, denominatorEstimated: true, cashQuality: q });
    expect(el.textContent).toContain("분모 추정");
    expect(el.textContent).toContain(label);
    expect(has(el, "profit-confirmed")).toBe(false);
    expect(has(el, "profit-not-fully-confirmed")).toBe(true);
  });

  it("분모 추정 + 보유수량이 리밸런싱 기록: 보유수량 출처 안내가 따로 보이고 손익 확정 문구는 없다", () => {
    const el = render({ ...base, exact: false, denominatorEstimated: true, holdingsSources: ["ledger", "anchor"] });
    expect(el.textContent).toContain("분모 추정");
    expect(el.textContent).toContain("리밸런싱 기록 보유수량");
    expect(has(el, "profit-confirmed")).toBe(false);
    expect(has(el, "profit-not-fully-confirmed")).toBe(true);
  });

  it("경고는 동시에 모두 보인다: 추정 포함 + 예수금 미확인 + 리밸런싱 기록 보유수량 + 진행 중", () => {
    const el = render({
      ...base, exact: false, estimated: true, estimateReasons: ["exit_date_unconfirmed"], estimatedDates: ["2026-10-13"],
      cashQuality: "unknown", holdingsSources: ["anchor"], span: "in-progress",
    });
    for (const t of ["추정 포함 · 미확정", "예수금 미확인", "리밸런싱 기록 보유수량", "진행 중"]) {
      expect(el.textContent).toContain(t);
    }
  });

  it("profitConfirmedStatement 진리표 — 추정이 없고 현금 derived 이고 보유 전부 ledger 일 때만 true", () => {
    const ok = { ...base, denominatorEstimated: true };
    expect(profitConfirmedStatement(ok)).toBe(true);
    expect(profitConfirmedStatement({ ...ok, estimated: true })).toBe(false);
    for (const q of ["anchor-implied", "cashflow-pending", "unknown"] as const) {
      expect(profitConfirmedStatement({ ...ok, cashQuality: q })).toBe(false);
    }
    expect(profitConfirmedStatement({ ...ok, holdingsSources: ["ledger", "anchor"] })).toBe(false);
    expect(profitConfirmedStatement({ ...ok, holdingsSources: ["anchor"] })).toBe(false);
  });

  it("계산 불가(null)는 0% 가 아니라 '계산 불가' 로, 실제 0% 는 +0.00% 로 보인다", () => {
    const nul = render({ ...base, returnPctLow: null, returnPctHigh: null, averageCapital: 0 });
    expect(nul.textContent).toContain("계산 불가");
    expect(nul.textContent).not.toContain("0.00%");
    const zero = render({ ...base, knownProfit: 0, returnPctLow: 0, returnPctHigh: 0 });
    expect(zero.textContent).toContain("+0.00%");
    expect(zero.textContent).not.toContain("계산 불가");
  });
});

// ── 그래프의 null 처리 ──────────────────────────────────────────────────────

describe("막대 그래프의 null 처리", () => {
  it("Y축 범위: null 은 범위에 영향이 없고 0 은 기준선으로 포함, 전부 null 이어도 유한하다", () => {
    expect(barYDomain([null, null])).toEqual([0, 1]);
    expect(barYDomain([])).toEqual([0, 1]);
    const [lo, hi] = barYDomain([null, 2, null, -1]);
    expect(lo).toBeLessThan(-1);
    expect(hi).toBeGreaterThan(2);
    expect(barYDomain([0, 0])).toEqual([-1, 1]);
    expect(barYDomain([null, 3])[0]).toBeLessThanOrEqual(0);
  });

  it("null·0·양수·음수가 섞인 데이터를 Recharts 로 그려도 NaN 이 없고, 0 은 얇은 선으로 남고 null 은 아무것도 그리지 않는다", () => {
    const data = [
      { key: "a", bar: null as number | null }, { key: "b", bar: 0 as number | null },
      { key: "c", bar: 2 as number | null }, { key: "d", bar: -1 as number | null },
    ];
    const el = mount(
      <BarChart width={400} height={200} data={data}>
        <XAxis dataKey="key" />
        <YAxis domain={barYDomain(data.map((d) => d.bar))} />
        <ReferenceLine y={0} />
        <Bar dataKey="bar" shape={BarShape} isAnimationActive={false}>
          {data.map((d) => (<Cell key={d.key} fill={d.bar !== null && d.bar < 0 ? "#e34948" : "#1baf7a"} />))}
        </Bar>
      </BarChart>,
    );
    expect(el.innerHTML).not.toContain("NaN");
    expect(el.innerHTML).not.toContain("undefined");
    expect(el.querySelectorAll(".recharts-bar-rectangle path, .recharts-bar-rectangle rect").length).toBe(3);
  });
});

// ── 선택 동작: 실제 클릭 이벤트 + select ────────────────────────────────────

describe("선택 이벤트 해석 — 값(null)과 무관하다", () => {
  const rows = [{ key: "k0", label: "A" }, { key: "k1", label: "B" }];
  it("activePayload 가 있으면 그 key, 없으면 activeTooltipIndex, 그것도 없으면 activeLabel", () => {
    expect(selectionKeyFromChartEvent({ activePayload: [{ payload: { key: "k1" } }] }, rows)).toBe("k1");
    expect(selectionKeyFromChartEvent({ activePayload: [], activeTooltipIndex: 0 }, rows)).toBe("k0");
    expect(selectionKeyFromChartEvent({ activeTooltipIndex: "1" }, rows)).toBe("k1");
    expect(selectionKeyFromChartEvent({ activeLabel: "B" }, rows)).toBe("k1");
    expect(selectionKeyFromChartEvent({ activeTooltipIndex: 9 }, rows)).toBeNull();
    expect(selectionKeyFromChartEvent({}, rows)).toBeNull();
    expect(selectionKeyFromChartEvent(null, rows)).toBeNull();
  });
});

describe("ProfitResultsPanel — null 슬롯 선택 (실제 click / change 이벤트)", () => {
  const origRect = HTMLElement.prototype.getBoundingClientRect;
  let offsetDesc: PropertyDescriptor | undefined;
  beforeAll(() => {
    // jsdom 은 레이아웃이 없다 — Recharts 가 크기를 읽는 지점만 고정한다
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

  const result = (i: number, over: Partial<PeriodResult>): PeriodResult => ({
    ...base, key: `k${i}`, label: `L${i}`, openDate: `2026-10-0${i + 1}`, closeDate: `2026-10-0${i + 1}`, ...over,
  });
  const MIXED: PeriodResult[] = [
    result(0, { exact: false, estimated: true, estimateReasons: ["exit_price_proxy"], estimatedDates: ["2026-10-01"] }), // null
    result(1, { knownProfit: 0, returnPctLow: 0, returnPctHigh: 0 }), // 실제 0
    result(2, {}), // 양수
    result(3, { knownProfit: -50_000, returnPctLow: -0.5, returnPctHigh: -0.5 }), // 음수
  ];
  const ALL_NULL: PeriodResult[] = [0, 1, 2].map((i) =>
    result(i, { exact: false, estimated: true, estimateReasons: ["exit_date_unconfirmed"], estimatedDates: [`2026-10-0${i + 1}`] }));

  function Harness(p: { period: "daily" | "monthly" | "yearly"; metric: "pct" | "amount"; results: PeriodResult[] }) {
    const [key, setKey] = useState<string | null>(null);
    return <ProfitResultsPanel period={p.period} metric={p.metric} results={p.results} up="#1baf7a" down="#e34948" selectedKey={key} onSelect={setKey} />;
  }
  const detailLabel = (el: HTMLElement) => el.querySelector(".rounded-xl .font-semibold")?.textContent;

  function clickChart(wrapper: Element, chartX: number) {
    const ev = new MouseEvent("click", { bubbles: true, clientX: chartX, clientY: 100 });
    Object.defineProperty(ev, "pageX", { value: chartX });
    Object.defineProperty(ev, "pageY", { value: 100 });
    act(() => { wrapper.dispatchEvent(ev); });
  }
  const pick = (el: HTMLElement, key: string) => {
    const sel = el.querySelector('[data-testid="period-picker"]') as HTMLSelectElement;
    act(() => {
      sel.value = key;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("월간: 처음엔 마지막 구간, null/0/양수/음수 슬롯을 차례로 클릭하면 상세 카드가 그 구간으로 바뀐다", () => {
    const el = mount(<Harness period="monthly" metric="pct" results={MIXED} />);
    expect(detailLabel(el)).toBe("L3");
    const wrapper = el.querySelector(".recharts-wrapper")!;
    expect(wrapper).not.toBeNull();
    // 플롯 영역: 왼쪽 Y축 44px, 오른쪽 여백 8px → 슬롯 4개의 중심
    const left = 44, width = 400 - 44 - 8;
    for (const i of [0, 1, 2, 3, 0]) {
      clickChart(wrapper, Math.round(left + ((i + 0.5) * width) / 4));
      expect(detailLabel(el)).toBe(`L${i}`);
    }
    // null 슬롯(L0)의 상세에는 추정 사유가 보인다 — 막대가 없어도 사유를 확인할 수 있다
    expect(has(el, "estimate-notice")).toBe(true);
  });

  it("전부 null 이어도 모든 슬롯을 선택할 수 있고, 차트에는 막대가 하나도 그려지지 않는다", () => {
    const el = mount(<Harness period="monthly" metric="amount" results={ALL_NULL} />);
    expect(el.querySelectorAll(".recharts-bar-rectangle path, .recharts-bar-rectangle rect").length).toBe(0);
    expect(el.innerHTML).not.toContain("NaN");
    const wrapper = el.querySelector(".recharts-wrapper")!;
    const left = 56, width = 400 - 56 - 8; // metric=amount 는 Y축 56px
    for (const i of [1, 0, 2]) {
      clickChart(wrapper, Math.round(left + ((i + 0.5) * width) / 3));
      expect(detailLabel(el)).toBe(`L${i}`);
    }
  });

  it("구간 선택 select: null 슬롯도 고를 수 있고 옵션에 막대 없음 사유가 적힌다 (차트 hit-testing 과 무관)", () => {
    const el = mount(<Harness period="yearly" metric="pct" results={MIXED} />);
    const options = [...el.querySelectorAll("option")].map((o) => o.textContent);
    expect(options[0]).toBe("L0 · 추정 포함(막대 없음)");
    expect(options[1]).toBe("L1"); // 실제 0% — 막대 있음
    pick(el, "k0");
    expect(detailLabel(el)).toBe("L0");
    expect(el.textContent).toContain("추정 포함 · 미확정");
    pick(el, "k1");
    expect(detailLabel(el)).toBe("L1");
    expect(el.textContent).toContain("+0.00%");
  });

  it("metric 전환: 선택은 유지되고 옵션 문구만 바뀐다 (pct 계산 불가 ↔ 수익금 있음)", () => {
    const noPct = [result(0, { returnPctLow: null, returnPctHigh: null, averageCapital: 0 }), result(1, {})];
    const el = mount(<Harness period="monthly" metric="pct" results={noPct} />);
    expect([...el.querySelectorAll("option")][0].textContent).toBe("L0 · 계산 불가(막대 없음)");
    expect(periodOptionLabel(noPct[0], "amount")).toBe("L0");
    pick(el, "k0");
    expect(detailLabel(el)).toBe("L0");
    expect(el.textContent).toContain("계산 불가");
  });

  it("일간: 가로 스크롤 컨테이너 안의 차트에서도 null 슬롯 클릭이 선택된다 (스크롤 영역 존재)", () => {
    const n = 30;
    const daily = Array.from({ length: n }, (_, i) =>
      result(i, i % 3 === 0 ? { exact: false, estimated: true, estimateReasons: ["exit_date_unconfirmed"], estimatedDates: ["2026-10-01"] } : {}));
    const el = mount(<Harness period="daily" metric="pct" results={daily} />);
    const scroll = el.querySelector('[data-testid="daily-scroll"]')!;
    expect(scroll).not.toBeNull();
    const wrapper = scroll.querySelector(".recharts-wrapper")!;
    // 폭 = n × 12px(최소 슬롯), 숨은 Y축이라 왼쪽 여백 0, 오른쪽 4px
    const width = n * 12 - 4;
    for (const i of [0, 3, 4]) { // 0·3 은 null 슬롯
      clickChart(wrapper, Math.round(((i + 0.5) * width) / n));
      expect(detailLabel(el)).toBe(`L${i}`);
    }
  });
});
