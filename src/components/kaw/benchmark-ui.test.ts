/**
 * 구조 검증 테스트.
 *
 * 이 저장소의 테스트 런타임은 node 환경(순수 계산 로직 전용, `vitest.config.ts` 참고)이라
 * React 렌더링을 돌리지 않는다. 그래서 "사이드바에 내부 페이지가 없다 / 비교 차트는
 * LineChart 하나다" 같은 UI 계약은 **소스 구조**로 고정한다 — 기존 backtest.test.ts 의
 * 구조 검증 블록과 같은 방식이다.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), "utf8");

const SIDEBAR = read("Sidebar.tsx");
const APP = read("App.tsx");
const SETTINGS = read("SettingsPage.tsx");
const DASHBOARD = read("Dashboard.tsx");
const INDEX_COMPARISON = read("IndexComparison.tsx");
const CHART = read("PortfolioBenchmarkChart.tsx");

/** `const NAV = [ ... ];` 블록만 떼어낸다 */
function navBlock(): string {
  const start = SIDEBAR.indexOf("const NAV = [");
  expect(start).toBeGreaterThan(-1);
  const end = SIDEBAR.indexOf("];", start);
  return SIDEBAR.slice(start, end);
}

describe("사이드바: 내부 페이지는 일반 메뉴가 아니다", () => {
  const nav = navBlock();

  it("NAV 는 대시보드 + 계좌 4개 뿐이다", () => {
    const ids = [...nav.matchAll(/id: "([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["dashboard", "retirement", "isa", "pension", "irp"]);
  });

  it("NAV 에 dashboard-old / compare 가 없다", () => {
    expect(nav).not.toContain("dashboard-old");
    expect(nav).not.toContain('"compare"');
  });

  it("Page 타입은 두 페이지를 그대로 유지한다 (삭제가 아니라 숨김)", () => {
    expect(SIDEBAR).toContain('export type Page = "dashboard" | "dashboard-old" | "compare"');
  });
});

describe("App: owner-only 내부 도구 게이트", () => {
  it("내부 페이지 목록이 한 곳에 정의돼 있다", () => {
    expect(APP).toContain('const INTERNAL_PAGES: readonly Page[] = ["dashboard-old", "compare"]');
  });

  it("hyeobi 이고 데모 세션이 아닐 때만 접근 가능하다", () => {
    expect(APP).toContain('const canAccessInternalTools = currentUser === "hyeobi" && !demoProfileId');
  });

  it("navigate 자체에서 막는다 — UI hide 만으로 끝내지 않는다", () => {
    expect(APP).toContain(
      'setPage(INTERNAL_PAGES.includes(p) && !canAccessInternalTools ? "dashboard" : p)',
    );
  });

  it("렌더 경로도 게이트를 통과한 페이지만 본다 (page 직접 비교가 남아 있지 않다)", () => {
    expect(APP).toContain(
      'const allowedPage = INTERNAL_PAGES.includes(page) && !canAccessInternalTools ? "dashboard" : page',
    );
    expect(APP).toContain('allowedPage === "dashboard-old" && <LegacyDashboard');
    expect(APP).toContain('allowedPage === "compare"    && <IndexComparison />');
    expect(APP).not.toMatch(/\{page === "/);
  });

  it("두 페이지의 렌더링은 삭제되지 않았다", () => {
    expect(APP).toContain("<LegacyDashboard");
    expect(APP).toContain("<IndexComparison />");
  });

  it("설정 화면에 게이트 판정 결과를 명시적으로 넘긴다", () => {
    expect(APP).toContain("canAccessInternalTools={canAccessInternalTools}");
    expect(APP).toContain("onNavigate={navigate}");
  });
});

describe("설정: 내부 도구 카드", () => {
  it("카드가 있고 두 페이지로 이동한다", () => {
    expect(SETTINGS).toContain("function InternalToolsCard");
    expect(SETTINGS).toContain("내부 도구");
    expect(SETTINGS).toContain('page: "dashboard-old", label: "구형 대시보드 열기"');
    expect(SETTINGS).toContain('page: "compare", label: "지수비교 전체화면 열기"');
  });

  it("canAccessInternalTools 가 참일 때만 렌더된다 (기본값은 false)", () => {
    expect(SETTINGS).toContain("canAccessInternalTools = false");
    expect(SETTINGS).toContain("{mainTab === \"data\" && canAccessInternalTools && onNavigate && (");
  });
});

describe("대시보드: 공용 benchmark 섹션", () => {
  it("공용 컴포넌트를 쓴다", () => {
    expect(DASHBOARD).toContain(
      'import { PortfolioBenchmarkSection } from "@/components/kaw/PortfolioBenchmarkChart"',
    );
    expect(DASHBOARD).toContain("<PortfolioBenchmarkSection />");
  });

  it("KPI(Section A) 바로 아래, 자산 구성(Section C) 위에 온다", () => {
    // JSX 쪽 섹션 주석 기준 (파일 위쪽 계산 블록에도 같은 이름의 주석이 있다)
    const a = DASHBOARD.indexOf("{/* ── Section A");
    const b = DASHBOARD.indexOf("<PortfolioBenchmarkSection />");
    const c = DASHBOARD.indexOf("{/* ── Section C");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("제목과 설명 문구", () => {
    expect(CHART).toContain("내 포트폴리오 vs 시장");
    expect(CHART).toContain("리밸런싱 기록 기준 비교");
  });
});

describe("지수비교 전체화면: 같은 컴포넌트 재사용", () => {
  it("공용 컴포넌트를 full 표현으로 쓴다", () => {
    expect(INDEX_COMPARISON).toContain(
      'import { PortfolioBenchmarkChart } from "@/components/kaw/PortfolioBenchmarkChart"',
    );
    expect(INDEX_COMPARISON).toContain('<PortfolioBenchmarkChart presentation="full" />');
  });

  it("계산/hook 이 중복으로 남아 있지 않다", () => {
    expect(INDEX_COMPARISON).not.toContain("useEnsureGrowthBacktest");
    expect(INDEX_COMPARISON).not.toContain("currentBacktestOf");
    expect(INDEX_COMPARISON).not.toContain("recharts");
  });

  it("hook 은 공용 컴포넌트 한 곳에서만 호출된다", () => {
    expect((CHART.match(/useEnsureGrowthBacktest\(/g) ?? []).length).toBe(4); // 계좌 4개
  });
});

describe("비교 차트: 금액 단일 LineChart", () => {
  it("BarChart 기반 지수비교가 사라졌다", () => {
    expect(CHART).not.toContain("BarChart");
    expect(CHART).not.toContain("<Bar ");
  });

  it("LineChart 는 하나뿐이고 이중 Y축이 없다", () => {
    expect((CHART.match(/<LineChart/g) ?? []).length).toBe(1);
    expect((CHART.match(/<YAxis/g) ?? []).length).toBe(1);
    expect(CHART).not.toContain("yAxisId");
  });

  it("Y축은 금액(원)이다 — 수익률을 별도 line 으로 그리지 않는다", () => {
    expect(CHART).toContain("tickFormatter={fmtAxis}");
    expect(CHART).not.toContain('dataKey="actualPct"');
    expect(CHART).not.toContain('dataKey="growthPct"');
  });

  it("일반 비교선 4개 (실제 / 성장형 / KOSPI200 / S&P500)", () => {
    const names = [...CHART.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["실제(커스텀)", "케이올웨더 성장형", "KOSPI200 비교", "S&P500 비교"]);
  });

  it("계좌 탭 4개를 그대로 쓴다", () => {
    expect(CHART).toContain("ACCOUNT_IDS.map((id) => (");
    expect(CHART).toContain("<TabsTrigger key={id} value={id}>");
  });

  it("보간하지 않는다 — 각 series 자신의 point 만 연결(connectNulls)", () => {
    // JSX prop 으로 2번 (일반 4선 공통 + DB선)
    expect((CHART.match(/^\s+connectNulls$/gm) ?? []).length).toBe(2);
  });

  it("모바일 touch tooltip 을 위해 recharts 기본 interaction 을 유지한다", () => {
    expect(CHART).toContain("<Tooltip content={<BenchmarkTooltip />} />");
    expect(CHART).toContain("activeDot={{ r: 4 }}");
  });
});

describe("DB 유지 가정선", () => {
  it("퇴직연금 탭에만 그린다", () => {
    expect(CHART).toContain('id === "retirement" && (');
    expect(CHART).toContain('dataKey="dbValue"');
    expect(CHART).toContain('out[id] = id === "retirement" ? withDbBenchmark(merged) : merged');
  });

  it("데이터는 독립 파일에서 온다 — backtestGrowth 에 넣지 않는다", () => {
    expect(CHART).toContain('from "@/lib/kaw/retirement-db-benchmark"');
    const backtest = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "lib", "kaw", "backtest.ts"),
      "utf8",
    );
    expect(backtest).not.toContain("retirement-db-benchmark");
    expect(backtest).not.toContain("dbValue");
  });

  it("DB 에는 투자 수익률 % 가 없다", () => {
    // SERIES(수익률 있는 일반 비교선)에 db 가 들어 있지 않다
    const seriesBlock = CHART.slice(CHART.indexOf("const SERIES = ["), CHART.indexOf("] as const;"));
    expect(seriesBlock).not.toContain("db");
    expect(CHART).toContain("DB 예상 퇴직급여 (추정)");
  });

  it("툴팁에 DC 대비 ± 금액이 있다", () => {
    expect(CHART).toContain("row.actualValue - row.dbValue");
    expect(CHART).toContain("DC 대비");
  });
});

describe("툴팁: 금액 + 누적수익률이 함께 있다", () => {
  it("series 별로 총액과 누적수익률을 같이 보여준다", () => {
    expect(CHART).toContain("{fmtWon(r.value!)}");
    expect(CHART).toContain("누적수익률");
    expect(CHART).toContain("{fmtPct(r.pct)}");
  });

  it("금액은 원 단위 locale formatting 이다", () => {
    expect(CHART).toContain('const fmtWon = (v: number) => `${Math.round(v).toLocaleString()}원`');
  });

  it("그 시점에 없는 series 는 툴팁에도 넣지 않는다", () => {
    expect(CHART).toContain("filter((r) => r.value !== null)");
  });
});
