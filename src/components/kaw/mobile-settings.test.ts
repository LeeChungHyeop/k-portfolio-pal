/**
 * 모바일(≈390px) 설정 화면 레이아웃 계약 — 소스 구조 검증.
 *
 * 이 저장소의 테스트 런타임은 node 환경이라 React 를 렌더링하지 않는다
 * (`vitest.config.ts` 참고). 그래서 benchmark-ui.test.ts 와 같은 방식으로
 * "모바일에서 깨지지 않게 하려고 일부러 넣은 클래스"를 소스에서 고정한다.
 * 리팩터링하다 이 클래스들이 사라지면 아이폰에서 조용히 다시 깨지기 때문이다.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), "utf8");

const SETTINGS = read("SettingsPage.tsx");
const APP = read("App.tsx");
const SIDEBAR = read("Sidebar.tsx");
const STYLES = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "styles.css"),
  "utf8",
);

/** `export function SettingsPage(` 부터 다음 최상위 선언 전까지 */
function settingsShell(): string {
  const start = SETTINGS.indexOf("export function SettingsPage(");
  expect(start).toBeGreaterThan(-1);
  const end = SETTINGS.indexOf("// Draft types for InvestmentTab", start);
  expect(end).toBeGreaterThan(start);
  return SETTINGS.slice(start, end);
}

/** `function ContributionScheduleCard(` 본문 */
function contributionCard(): string {
  const start = SETTINGS.indexOf("function ContributionScheduleCard(");
  expect(start).toBeGreaterThan(-1);
  const end = SETTINGS.indexOf("export function SettingsPage(", start);
  expect(end).toBeGreaterThan(start);
  return SETTINGS.slice(start, end);
}

/** `function MonthPickerField(` 본문 */
function monthPickerField(): string {
  const start = SETTINGS.indexOf("function MonthPickerField(");
  expect(start).toBeGreaterThan(-1);
  const end = SETTINGS.indexOf("function ContributionScheduleCard(", start);
  expect(end).toBeGreaterThan(start);
  return SETTINGS.slice(start, end);
}

describe("월 선택 필드: 네이티브 컨트롤의 고유폭이 열을 밀지 못하게 한다", () => {
  const field = monthPickerField();

  it("실제 input[type=month] 는 absolute 라 레이아웃 흐름 밖에 있다", () => {
    expect(field).toContain('type="month"');
    expect(field).toMatch(/absolute inset-0[^"]*opacity-0/);
  });

  it("보이는 껍데기가 폭을 결정하고 넘치면 자른다", () => {
    expect(field).toContain("pointer-events-none absolute inset-0");
    expect(field).toContain("truncate tabular-nums");
    expect(field).toContain("relative mt-1 h-9 w-full min-w-0");
  });

  it("피커가 열려야 하므로 display:none / visibility:hidden 으로 숨기지 않는다", () => {
    // overflow-hidden 은 껍데기 자르기용이라 괜찮다. 숨기는 유틸리티만 금지.
    expect(field).not.toMatch(/className="[^"]*(?:^|\s)hidden(?:\s|")/);
    expect(field).not.toContain("invisible");
    expect(field).not.toContain("sr-only");
  });

  it("month 미지원 엔진(WebKit 등)에는 보이는 텍스트 입력 폴백이 있다", () => {
    expect(SETTINGS).toContain("function monthInputSupported()");
    expect(field).toContain("if (!supported)");
    expect(field).toContain('placeholder="2026-10"');
  });

  it("바깥으로 나가는 값은 어느 경로든 YYYY-MM 문자열 하나다", () => {
    expect(field).toContain("onChange: (v: string) => void");
    expect(field).toContain("onChange(e.target.value)");
  });
});

describe("설정 상단 탭: 모바일에서 한 줄을 유지한다", () => {
  const shell = settingsShell();

  it("탭 버튼은 whitespace-nowrap + shrink-0 이다 (\"데이터 관/리\" 줄바꿈 금지)", () => {
    const btn = shell.slice(shell.indexOf("rounded-t-lg"));
    expect(btn).toContain("whitespace-nowrap");
    expect(btn.slice(0, 200)).toContain("shrink-0");
  });

  it("탭 줄은 모바일에서만 가로 스크롤한다", () => {
    expect(shell).toContain("overflow-x-auto md:overflow-x-visible no-scrollbar");
  });

  it("탭 좌우 padding 은 모바일에서 줄고 md 이상은 기존(px-5) 그대로다", () => {
    expect(shell).toContain("px-3 md:px-5");
  });

  it("no-scrollbar 유틸리티가 실제로 정의돼 있다", () => {
    expect(STYLES).toContain(".no-scrollbar");
    expect(STYLES).toContain(".no-scrollbar::-webkit-scrollbar");
  });
});

describe("중첩 스크롤: 모바일에서는 main 하나만 세로 스크롤한다", () => {
  const shell = settingsShell();

  it("App 의 main 은 계속 유일한 바깥 스크롤러다", () => {
    expect(APP).toContain('<main className="flex-1 overflow-y-auto min-w-0">');
  });

  it("SettingsPage 루트의 h-full 은 md 이상에서만 걸린다", () => {
    expect(shell).toContain('className="flex flex-col md:h-full md:min-h-0"');
    expect(shell).not.toContain('className="flex flex-col h-full min-h-0"');
  });

  it("탭 콘텐츠의 overflow-y-auto 도 md 이상 전용이다", () => {
    expect(shell).toContain("flex-1 md:overflow-y-auto");
    expect(shell).not.toMatch(/flex-1 overflow-y-auto px-4/);
  });
});

describe("정기납입 카드: 모바일에서 input 이 겹치지 않는다", () => {
  const card = contributionCard();

  it("설정 네 필드는 하나의 2열 grid 안에 있다 (두 행의 열 경계가 어긋나지 않게)", () => {
    const grids = card.match(/className="grid grid-cols-2 gap-2 md:gap-3"/g) ?? [];
    expect(grids).toHaveLength(1);
    // 그 grid 하나 안에 네 라벨이 이 순서로 들어 있다
    const start = card.indexOf('className="grid grid-cols-2 gap-2 md:gap-3"');
    const block = card.slice(start);
    const order = ["매월 납입일", "입금 시점", "적용 시작월", "금액 (원)"]
      .map((l) => block.indexOf(l));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("적용 시작월을 1열 전체폭으로 내리지 않는다 (col-span 은 추가 버튼만)", () => {
    expect(card.match(/col-span-2/g)).toHaveLength(1);
    expect(card).toContain('className="col-span-2 h-9 w-full"');
  });

  it("grid 자식은 전부 min-w-0 이다", () => {
    // 네 필드 래퍼 + MonthPickerField/금액 input
    expect(card.match(/className="min-w-0"/g)).toHaveLength(4);
    expect(card).toContain("mt-1 h-9 w-full min-w-0");
  });

  it("카드 순서: 입력 grid → 현재 적용금액 → 안내문 → 금액 이력(최하단)", () => {
    const idx = [
      'className="grid grid-cols-2 gap-2 md:gap-3"',
      "현재 적용금액",
      "실제 입금은 계좌 화면의",
      "금액 이력",
    ].map((s) => card.indexOf(s));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("금액 이력 블록은 divider 뒤에 온다", () => {
    expect(card).toContain('className="space-y-1.5 pt-3 border-t"');
  });

  it("삭제/버전 로직은 그대로다", () => {
    expect(card).toContain("removeContributionAmountVersion(accountId, v.effectiveFrom)");
    expect(card).toContain("setContributionAmount(accountId, newFrom, Number(newAmount))");
    expect(card).toContain("!/^\\d{4}-\\d{2}$/.test(newFrom)");
  });

  it("입금 시점 select 의 저장값과 의미는 그대로다 (표시 문구만 모바일에서 축약)", () => {
    expect(card).toContain('<SelectItem value="same_day">당일 입금');
    expect(card).toContain('<SelectItem value="after_close">장마감 후 입금');
    expect(card).toContain('<span className="hidden md:inline"> (바로 사용)</span>');
    expect(card).toContain('<span className="hidden md:inline"> (다음 거래일부터)</span>');
    // 축약된 문구의 의미는 아래 설명 문단이 두 경우 모두 문장으로 채워준다
    expect(card).toContain("납입일 저녁 입금, 다음 거래일부터 매수 가능");
    expect(card).toContain("납입일 당일 입금, 그 날 바로 매수 가능");
  });
});

describe("모바일 카드 여백", () => {
  it("모든 Card 는 모바일 전용 padding 으로 시작한다 (p-5/p-6 바로 시작 금지)", () => {
    // p-6 md:p-8 은 허용 — 모바일 쪽이 이미 한 단계 작아진 것이다.
    const bare = [...SETTINGS.matchAll(/<Card className="(p-[0-9]+)(?= |")/g)]
      .map((m) => m[1])
      .filter((p) => p !== "p-4" && p !== "p-6");
    expect(bare).toEqual([]);
    expect(SETTINGS).not.toContain('<Card className="p-6 space-y');
    expect(SETTINGS).not.toContain('<Card className="p-5');
  });

  it("md 이상 여백은 그대로 유지된다", () => {
    expect(SETTINGS).toContain('<Card className="p-4 md:p-5');
    expect(SETTINGS).toContain('<Card className="p-4 md:p-6');
  });

  it("콘텐츠 세로 여백도 모바일에서 한 단계 작다", () => {
    expect(SETTINGS).toContain("py-4 md:py-6");
    expect(SETTINGS).toContain("space-y-4 md:space-y-6");
  });

  it("자산 테이블 헤더의 안내 문구는 모바일에서 줄어들 수 있다 (Card 밖으로 잘리지 않게)", () => {
    // Card 가 overflow-hidden 이라 shrink-0 이면 긴 경고 문구가 통째로 잘린다
    expect(SETTINGS).toContain('<div className="min-w-0 md:shrink-0">');
  });
});

describe("모바일 헤더 빌드 정보", () => {
  it("배포 추적은 유지하되 모바일 헤더는 축약형을 쓴다", () => {
    expect(SIDEBAR).toContain("export const DEPLOY_DATE =");
    expect(SIDEBAR).toContain("export const DEPLOY_DATE_SHORT =");
    expect(APP).toContain("{DEPLOY_DATE_SHORT}");
    expect(APP).not.toContain("{DEPLOY_DATE}");
  });

  it("사이드바(데스크톱)는 전체 문자열을 그대로 보여준다", () => {
    expect(SIDEBAR).toContain("최근배포일: {DEPLOY_DATE}");
  });
});
