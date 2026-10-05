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

  it("금액 추가 행은 모바일 2열 grid, sm 이상에서 한 줄로 돌아간다", () => {
    expect(card).toContain("grid grid-cols-2 gap-2 pt-1 border-t sm:flex sm:items-end");
  });

  it("추가 버튼은 모바일에서 full width 로 두 열을 차지한다", () => {
    expect(card).toContain('className="col-span-2 h-9 w-full sm:w-auto"');
  });

  it("두 input 모두 min-w-0 이라 grid 셀 밖으로 넘치지 않는다", () => {
    expect(card.match(/mt-1 h-9 w-full min-w-0/g)).toHaveLength(2);
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
