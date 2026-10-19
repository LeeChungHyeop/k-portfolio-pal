/**
 * mock 시나리오 · 승인 인터페이스(닫힘) · 운영 코드 격리를 고정한다.
 *   1. mock 은 운영 코드가 import 하지 않는다
 *   2. mock 시나리오가 의도한 상태를 만든다 (화면 mock 과 테스트가 같은 데이터를 본다)
 *   3. 승인 인터페이스는 설계뿐이다 — 서버 라우트·네트워크·화면 활성 경로가 없다
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createMockExecRequest, EXEC_MOCK_SCENARIO_TEXT, type ExecMockScenario } from "./kis-execution-mock";
import { APPROVAL_API_ENABLED, requestApproval } from "./kis-execution-approval";

const SRC = path.resolve(import.meta.dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const prodFiles = walk(SRC).filter((f) => !f.endsWith("kis-execution-mock.ts"));

describe("mock 격리", () => {
  it("운영 코드(테스트·mock 제외)가 mock 을 import 하지 않는다", () => {
    const offenders = prodFiles.filter((f) => /kis-execution-mock/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("mock 이 실제 네트워크 · 저장소를 쓰지 않는다", () => {
    const code = readFileSync(path.join(SRC, "lib/kaw/kis-execution-mock.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/fetch\(|supabase|localStorage|sessionStorage/);
  });
});

describe("시나리오", () => {
  it("모든 시나리오에 설명이 있다", () => {
    expect(Object.keys(EXEC_MOCK_SCENARIO_TEXT).sort()).toEqual(
      ["empty", "failed_account", "list_absent", "network_error", "not_configured", "ok_incomplete", "ok_matches", "ok_with_residual"],
    );
  });
  const run = async (s: ExecMockScenario) => createMockExecRequest(s, 0).request({ start: "2026-10-13", end: "2026-10-16" });

  it("ok_with_residual: 신규 2 · 체결 없는 주문 1 · 이전 증권사 보유 잔존 경고", async () => {
    const r = await run("ok_with_residual");
    if (r.kind !== "response" || r.data.state !== "ok") throw new Error("state");
    expect(r.data.totals.byStatus).toMatchObject({ new: 2, no_execution: 1 });
    expect(r.data.impact.priorBrokerResidual).toEqual({ "360750": 297, "367380": 81 });
  });
  it("ok_incomplete: 불완전", async () => {
    const r = await run("ok_incomplete");
    if (r.kind !== "response" || r.data.state !== "ok") throw new Error("state");
    expect(r.data.query.complete).toBe(false);
  });
  it("ok_matches: 일치 + 중복 가능성", async () => {
    const r = await run("ok_matches");
    if (r.kind !== "response" || r.data.state !== "ok") throw new Error("state");
    expect(r.data.totals.byStatus.matches).toBe(1);
    expect(r.data.totals.byStatus.possible_duplicate).toBe(1);
  });
  it("empty / list_absent 를 구분한다", async () => {
    const e = await run("empty"); const a = await run("list_absent");
    if (e.kind !== "response" || e.data.state !== "ok" || a.kind !== "response" || a.data.state !== "ok") throw new Error("state");
    expect(e.data.query.listState).toBe("empty");
    expect(a.data.query.listState).toBe("list_absent");
  });
  it("실패 · 설정 없음 · 네트워크", async () => {
    expect((await run("not_configured")).kind).toBe("not_configured");
    expect((await run("network_error")).kind).toBe("network_error");
    const f = await run("failed_account");
    expect(f.kind === "response" && f.data.state === "query_failed" && f.data.failure.kind).toBe("account");
  });
  it("호출 기록이 남는다", async () => {
    const m = createMockExecRequest("empty", 0);
    await m.request({ start: "2026-10-13", end: "2026-10-16" });
    expect(m.calls).toEqual([{ start: "2026-10-13", end: "2026-10-16" }]);
  });
});

describe("승인 인터페이스 — 설계뿐이고 닫혀 있다", () => {
  it("항상 not_enabled 를 돌려주고 네트워크를 타지 않는다", async () => {
    const f = vi.fn(); const orig = globalThis.fetch; globalThis.fetch = f as never;
    try {
      expect(APPROVAL_API_ENABLED).toBe(false);
      const r = await requestApproval({
        start: "2026-10-13", end: "2026-10-16", orderKeys: ["20261014#1"],
        transferEvidence: { mode: "sold_then_cash_transfer", exitEvidenceInLedger: true, postTransferObservation: true, cashReceived: { date: "2026-10-14", amount: 1, basis: "user_confirmed" } },
      });
      expect(r).toEqual({ ok: false, reason: "not_enabled" });
      expect(f).not.toHaveBeenCalled();
    } finally { globalThis.fetch = orig; }
  });
  it("서버의 체결 라우트는 preview 와 apply 둘뿐이고, apply 는 서버 플래그(기본 꺼짐) 뒤에 있다 (Phase 4-C-2)", () => {
    const server = readFileSync(path.join(SRC, "server.ts"), "utf8");
    const routes = [...server.matchAll(/\/api\/kis\/executions\/([a-z]+)/g)].map((m) => m[1]);
    expect([...new Set(routes)].sort()).toEqual(["apply", "preview"]);
    expect(server).not.toMatch(/executions\/approve|executions\/import/);
    const apply = readFileSync(path.join(SRC, "lib/kaw/kis-ledger-apply-server.ts"), "utf8");
    // 플래그 확인이 KIS 호출·DB 읽기보다 앞선다
    expect(apply.indexOf("isLedgerApplyEnabled(env)")).toBeGreaterThan(-1);
    expect(apply.indexOf("isLedgerApplyEnabled(env)")).toBeLessThan(apply.indexOf("queryKisExecutions("));
    expect(apply.indexOf("isLedgerApplyEnabled(env)")).toBeLessThan(apply.indexOf("readBundle("));
  });
  it("화면은 승인 함수를 호출하지 않는다 (버튼은 disabled 고정)", () => {
    const panel = readFileSync(path.join(SRC, "components/kaw/KisExecutionImportPanel.tsx"), "utf8");
    expect(panel).not.toMatch(/requestApproval|kis-execution-approval/);
    expect(panel).toMatch(/<Button[^>]*\bdisabled\b[^>]*data-testid="exec-approve-button"/);
  });
});
