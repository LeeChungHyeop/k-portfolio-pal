/**
 * 428(구버전 저장 거부) 안내 — 터치 기기에서도 읽을 수 있어야 한다.
 *   · 툴팁(title)에만 있지 않고 본문 글자 + 새로고침 버튼이 있다
 *   · 문구가 "저장되지 않았다"를 분명히 말한다 (성공으로 오해하지 않게)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REFRESH_REQUIRED_MESSAGE } from "./store";

const sidebar = readFileSync(fileURLToPath(new URL("../../components/kaw/Sidebar.tsx", import.meta.url)), "utf8");

describe("428 새로고침 안내", () => {
  it("저장되지 않았음을 말하는 문구가 상수로 있다", () => {
    expect(REFRESH_REQUIRED_MESSAGE).toContain("저장되지 않았습니다");
    expect(REFRESH_REQUIRED_MESSAGE).toContain("새로고침");
  });
  it("사이드바가 그 상태를 본문 글자와 새로고침 버튼으로 보여준다", () => {
    const i = sidebar.indexOf("dbError === REFRESH_REQUIRED_MESSAGE");
    expect(i).toBeGreaterThan(-1);
    const block = sidebar.slice(i, i + 900);
    expect(block).toContain("저장되지 않았습니다");
    expect(block).toContain("window.location.reload()");
    expect(block).toContain('role="alert"');
  });
  it("새로고침은 사용자가 누를 때만 일어난다 (자동 reload 없음)", () => {
    expect(sidebar).not.toMatch(/useEffect\([^)]*reload/s);
    expect((sidebar.match(/window\.location\.reload\(\)/g) ?? []).length).toBe(1);
  });
});
