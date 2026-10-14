/**
 * 승인형 주문 화면 구조 계약 — 소스 검증 (테스트 런타임이 node 라 렌더링하지 않는다).
 * 실제 화면 확인은 격리된 mock 환경(npm run mock:order)에서 한다.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const PANEL = read("OrderApprovalPanel.tsx");
const CARD = read("OrderApprovalCard.tsx");
const ACCOUNT = read("AccountPage.tsx");
const CLIENT = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "lib", "kaw", "order-client.ts"), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("OrderApprovalCard (운영 감싸개)", () => {
  it("AccountPage 에서 계좌 id 와 함께 한 번 그려진다", () => {
    expect(ACCOUNT).toContain("import { OrderApprovalCard }");
    expect(ACCOUNT.match(/<OrderApprovalCard accountId=\{accountId\} \/>/g)).toHaveLength(1);
  });

  it("flag·계좌 게이트를 통과해야만 패널을 그리고, 운영 API 를 넣는다", () => {
    expect(CARD).toContain("orderUiGate(");
    expect(CARD).toMatch(/if \(!gate\.visible\) return null;/);
    expect(CARD).toContain("api={LIVE_ORDER_API}");
    expect(CARD).not.toContain("order-mock-api");
  });
});

describe("OrderApprovalPanel", () => {
  const code = stripComments(PANEL);

  it("주문 요청(api.submit)은 onSubmit 안에서만, begin_submit 관문 뒤에 한 번 호출된다", () => {
    expect(code.match(/api\.submit\(/g)).toHaveLength(1);
    const submit = code.slice(code.indexOf("const onSubmit"), code.indexOf("const onInquire"));
    expect(submit).toContain("api.submit(");
    expect(submit.indexOf('type: "begin_submit"')).toBeGreaterThan(-1);
    expect(submit.indexOf('type: "begin_submit"')).toBeLessThan(submit.indexOf("api.submit("));
  });

  it("onSubmit 은 최종 승인 단계의 버튼에만 연결되고 두 확인 체크가 있어야 켜진다", () => {
    expect(code.match(/onClick=\{onSubmit\}/g)).toHaveLength(1);
    const finalBlock = code.slice(code.indexOf('flow.phase === "final" && ('));
    expect(finalBlock).toContain("onClick={onSubmit}");
    expect(code).toMatch(/disabled=\{busy \|\| !ack\.details \|\| !ack\.unsupported\}/);
  });

  it("수동 해소는 api.resolve 만 부르고 주문을 보내지 않는다", () => {
    const resolve = code.slice(code.indexOf("const onResolve"), code.indexOf("const view ="));
    expect(resolve).toContain("api.resolve(");
    expect(resolve).not.toMatch(/api\.(submit|prepare)\(/);
    expect(code).toMatch(/view\.canResolve && resolveOpen/);
  });

  it("자동 호출이 없다 — effect 안에서 api 를 부르지 않는다", () => {
    for (const m of code.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) {
      expect(m[1]).not.toMatch(/api\.(prepare|submit|status|resolve)\(/);
    }
  });

  it("재시도 루프가 없고 submit 경로는 클라이언트에 한 곳이다", () => {
    expect(code + stripComments(CLIENT)).not.toMatch(/retry|setInterval\([^)]*api\./i);
    expect(stripComments(CLIENT).match(/\/api\/kis\/order\/submit/g)).toHaveLength(1);
  });

  it("승인 토큰을 저장하지 않는다 (의도 id 만)", () => {
    expect(code).not.toMatch(/storage\.set\([^)]*token/i);
    expect(code).toContain("lastIntentKey");
    expect(stripComments(CLIENT)).not.toMatch(/localStorage|sessionStorage/);
  });

  it("주문 내용(종목·수량·가격)을 바꾸는 입력이 없다 — 텍스트 입력은 수동 해소의 주문번호뿐", () => {
    expect(code).not.toMatch(/<Input\b|<select/);
    const resultAt = code.indexOf('flow.phase === "done" && i && view');
    expect(resultAt).toBeGreaterThan(-1);
    const orderPart = code.slice(0, resultAt);
    expect(orderPart.match(/<input/g) ?? []).toHaveLength(2); // 최종 승인 체크 2개
    expect(orderPart.match(/type="checkbox"/g) ?? []).toHaveLength(2);
    const resolvePart = code.slice(code.indexOf('data-testid="order-resolve"'));
    expect(resolvePart.match(/type="text"/g) ?? []).toHaveLength(1);
    expect(resolvePart).toContain('inputMode="numeric"');
  });

  it("패널은 운영 store·Supabase 를 import 하지 않는다 (mock 에서 그릴 수 있다)", () => {
    expect(PANEL).not.toMatch(/@\/lib\/kaw\/store|supabase|data-server/);
  });

  it("모바일: 세로 배치·전체 폭 버튼·44px 터치 영역·줄바꿈·2열 상세(Tailwind v4 문법)", () => {
    expect(PANEL).toContain("flex flex-col gap-2 sm:flex-row");
    expect(PANEL).toContain("w-full sm:w-auto");
    expect(PANEL).toContain("min-h-11");
    expect(PANEL).toContain("break-words");
    expect(PANEL).toContain("grid-cols-[auto_1fr]");
    expect(PANEL).not.toMatch(/overflow-x|min-w-\[\d{3,}|grid-cols-\[auto,1fr\]/);
  });

  it("접수·불명을 체결로 쓰지 않는다", () => {
    expect(CLIENT).toContain("체결된 것은 아닙니다");
    expect(CLIENT).toContain("executionConfirmed: false");
  });
});
