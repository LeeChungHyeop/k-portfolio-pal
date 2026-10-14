/**
 * 승인형 주문 화면 구조 계약 — 소스 검증 (테스트 런타임이 node 라 렌더링하지 않는다).
 * mobile-settings.test.ts 와 같은 방식이다.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const CARD = read("OrderApprovalCard.tsx");
const ACCOUNT = read("AccountPage.tsx");
const CLIENT = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "lib", "kaw", "order-client.ts"), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("OrderApprovalCard", () => {
  it("AccountPage 에서 연금저축 계좌 id 와 함께 한 번 그려진다", () => {
    expect(ACCOUNT).toContain('import { OrderApprovalCard }');
    expect(ACCOUNT.match(/<OrderApprovalCard accountId=\{accountId\} \/>/g)).toHaveLength(1);
  });

  it("주문 요청(requestSubmit)은 onSubmit 안에서만 호출되고, 그 앞에 begin_submit 관문이 있다", () => {
    const code = stripComments(CARD);
    expect(code.match(/requestSubmit\(/g)).toHaveLength(1);
    const submit = code.slice(code.indexOf("const onSubmit"), code.indexOf("const onInquire"));
    expect(submit).toContain("requestSubmit(");
    expect(submit.indexOf('type: "begin_submit"')).toBeGreaterThan(-1);
    expect(submit.indexOf('type: "begin_submit"')).toBeLessThan(submit.indexOf("requestSubmit("));
  });

  it("onSubmit 은 최종 승인 단계의 버튼에만 연결돼 있고 두 확인 체크가 있어야 켜진다", () => {
    const code = stripComments(CARD);
    expect(code.match(/onClick=\{onSubmit\}/g)).toHaveLength(1);
    const finalBlock = code.slice(code.indexOf('flow.phase === "final" && ('));
    expect(finalBlock).toContain("onClick={onSubmit}");
    expect(code).toMatch(/disabled=\{busy \|\| !ack\.details \|\| !ack\.unsupported\}/);
  });

  it("자동 호출이 없다 — 마운트 effect 안에서 요청 함수를 부르지 않는다", () => {
    const code = stripComments(CARD);
    for (const m of code.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) {
      expect(m[1]).not.toMatch(/request(Prepare|Submit|Status)\(/);
    }
    expect(code).not.toMatch(/setTimeout\([^)]*request/);
  });

  it("재주문·재시도 루프가 없다", () => {
    const code = stripComments(CARD) + stripComments(CLIENT);
    expect(code).not.toMatch(/retry|setInterval\([^)]*request/i);
    expect(stripComments(CLIENT).match(/\/api\/kis\/order\/submit/g)).toHaveLength(1);
  });

  it("승인 토큰을 저장소에 쓰지 않는다 (의도 id 만)", () => {
    const code = stripComments(CARD);
    expect(code).not.toMatch(/setItem\([^)]*token/i);
    expect(stripComments(CLIENT)).not.toMatch(/localStorage|sessionStorage/);
    expect(code).toContain("lastIntentKey");
  });

  it("입력 필드가 없다 — 종목·수량·가격을 사용자가 바꾸지 못한다", () => {
    const code = stripComments(CARD);
    expect(code).not.toMatch(/<Input|<textarea|<select/);
    // 체크박스(확인 동의) 2개 외의 input 이 없다
    expect((code.match(/<input/g) ?? []).length).toBe(2);
    expect((code.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });

  it("flag 가 꺼지거나 지원 안 되는 계좌면 null 을 돌려준다", () => {
    expect(CARD).toMatch(/if \(!gate\.visible \|\| !instance\) return null;/);
    expect(CARD).toContain("orderUiGate(");
  });

  it("모바일: 세로 배치·전체 폭 버튼·44px 터치 영역·줄바꿈", () => {
    expect(CARD).toContain("flex flex-col gap-2 sm:flex-row");
    expect(CARD).toContain("w-full sm:w-auto");
    expect(CARD).toContain("min-h-11");
    expect(CARD).toContain("break-words");
    expect(CARD).not.toMatch(/overflow-x|min-w-\[\d{3,}/);
  });

  it("접수·불명을 체결로 쓰지 않는다 (체결 표시는 describeOrder 결과만)", () => {
    expect(CLIENT).toContain("체결된 것은 아닙니다");
    expect(CLIENT).toContain("executionConfirmed: false");
  });
});
