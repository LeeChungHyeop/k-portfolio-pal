// @vitest-environment jsdom
// 체결 → 거래원장 반영 승인 화면 (Phase 4-C-2) — 실제 컴포넌트를 렌더링하고 클릭으로 검증한다.
//
// 지키는 것:
//   1. 각 거래의 종목 · 체결일 · 수량 · 평균가 · 금액 · 중복 여부와 합계(294주 · 7,974,630원)가 보인다
//   2. 승인 체크 없이는 버튼이 눌리지 않고, 서버 플래그가 꺼져 있으면(enabled=false) 승인 자체가 막힌다
//   3. 승인은 한 번의 요청에만 쓰인다 (요청 후 승인이 풀리고, 연타해도 한 번만 호출된다)
//   4. applied 가 아니면 성공으로 안내하지 않는다 (plan_changed · already_applied · 오류)
//   5. 예수금 차이는 원인 미확정으로 보이고, 원금 불변과 반영 후 보유 일치가 보인다
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KisLedgerApplySection } from "./KisLedgerApplySection";
import type { ApplyView } from "@/lib/kaw/kis-execution-compose";
import type { ApplyOutcome } from "@/lib/kaw/kis-ledger-apply-client";
import { reconcileTransfer } from "@/lib/kaw/transfer-reconciliation";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RANGE = { start: "2026-10-14", end: "2026-10-19" };
const HASH = "k1|abcdef0123456789";
const recon = reconcileTransfer({ transferAmount: 10_293_793, kisBuyAmount: 7_974_630, kisBuyAmountAlreadyInLedger: 0, ledgerDerivedCash: 10_219_264, observedCash: 2_318_828, principalBefore: 10_500_000, principalAfter: 10_500_000 });

function view(over: Partial<ApplyView> = {}): ApplyView {
  return {
    eligible: true, flagEnabled: true, enabled: true, alreadyApplied: false, blockers: [],
    plan: {
      planHash: HASH, batchId: "imp:kis_api_daily_ccld:x",
      rows: [
        { ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", tradeDate: "2026-10-14", quantity: 230, price: 25985, amount: 5_976_550, orderNoTail: "6700", duplicate: "none" },
        { ticker: "367380", etfName: "ACE 미국나스닥100", side: "buy", tradeDate: "2026-10-14", quantity: 64, price: 31220, amount: 1_998_080, orderNoTail: "1700", duplicate: "none" },
      ],
      totalQuantity: 294, totalAmount: 7_974_630,
      holdings: { before: {}, after: { "360750": 230, "367380": 64 }, observed: { "360750": 230, "367380": 64 }, matches: true },
      principal: { before: 10_500_000, after: 10_500_000, unchanged: true },
      reconciliation: recon,
      observation: { captureId: "cap:x", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" },
      transfer: { anchorDate: "2026-10-13", amount: 10_293_793, approvedAt: "2026-10-19T08:57:45.000Z", containsEstimates: true },
    },
    ...over,
  };
}

let root: Root; let host: HTMLDivElement;
async function mount(v: ApplyView, onApply?: (r: { start: string; end: string; planHash: string }) => Promise<ApplyOutcome>) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(React.createElement(KisLedgerApplySection, { apply: v, range: RANGE, onApply })); });
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
async function click(el: HTMLElement) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); }
const btn = () => $("apply-button") as HTMLButtonElement;
const applied: ApplyOutcome = { kind: "applied", batchId: "imp:kis_api_daily_ccld:x", inserted: 2, holdingsAfter: { "360750": 230, "367380": 64 } };
beforeEach(() => { document.body.innerHTML = ""; });

describe("계획 표시", () => {
  it("각 거래의 종목 · 체결일 · 수량 · 평균가 · 금액 · 중복 없음(신규)이 보인다", async () => {
    await mount(view(), vi.fn());
    const rows = $$("apply-row");
    expect(rows).toHaveLength(2);
    const t = rows.map((r) => r.textContent).join("\n");
    for (const s of ["TIGER 미국S&P500", "360750", "2026-10-14", "230주", "25,985원", "5,976,550원", "ACE 미국나스닥100", "367380", "64주", "31,220원", "1,998,080원", "주문 …6700", "주문 …1700"]) expect(t).toContain(s);
    expect(t.match(/원장 중복 없음\(신규\)/g)).toHaveLength(2);
  });

  it("합계 294주 · 7,974,630원 · 체결 0주 제외 · 수수료/세금은 비워 둔다는 안내", async () => {
    await mount(view(), vi.fn());
    const t = $("apply-totals")!.textContent!;
    expect(t).toContain("294주");
    expect(t).toContain("7,974,630원");
    expect(t).toContain("체결 0주 주문은 계획에 없습니다");
    expect(t).toContain("수수료·세금은 증권사가 주지 않아 비워 둡니다");
  });

  it("반영 후 원장 재생 보유가 한국투자 관측 보유와 일치하고, 원금은 변동 없다", async () => {
    await mount(view(), vi.fn());
    const h = $("apply-holdings")!.textContent!;
    expect(h).toContain("360750 230주, 367380 64주");
    expect($("apply-holdings-match")!.textContent).toBe("일치");
    expect(h).toContain("관측 기준일 2026-10-19");
    expect($("apply-principal")!.textContent).toBe("10,500,000원");
    expect(h).toContain("변동 없음");
  });

  it("예수금 차이는 원인 미확정으로만 보이고 메우지 않는다 (−335원 · +74,194원)", async () => {
    await mount(view(), vi.fn());
    const t = $("apply-recon")!.textContent!;
    expect(t).toContain("−335원");
    expect(t).toContain("+74,194원");
    expect(t.match(/원인 미확정/g)!.length).toBeGreaterThanOrEqual(2);
    expect(t).toContain("보정 거래·가상 입금·배당·이자를 만들지 않습니다");
  });

  it("승인 문구에 건수 · 수량 · 금액과 원금/보유수량/예수금 설정 불변이 들어 있다", async () => {
    await mount(view(), vi.fn());
    const label = ($("apply-approve") as HTMLElement).closest("label")!.textContent!;
    expect(label).toContain("실제 체결 2건");
    expect(label).toContain("294주");
    expect(label).toContain("7,974,630원");
    expect(label).toContain("바뀌지 않으며");
    expect(label).toContain("원인 미확정으로 남는 것을 이해합니다");
  });
});

describe("승인 — 체크 없이는 반영하지 않는다", () => {
  it("체크 전에는 버튼이 비활성이고 눌러도 요청하지 않는다", async () => {
    const onApply = vi.fn();
    await mount(view(), onApply);
    expect(btn().disabled).toBe(true);
    await click(btn());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("체크 후 눌렀을 때만 계획 해시와 조회 기간을 실어 한 번 요청한다", async () => {
    const onApply = vi.fn(async () => applied);
    await mount(view(), onApply);
    await click($("apply-approve") as HTMLElement);
    expect(btn().disabled).toBe(false);
    await click(btn());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ start: "2026-10-14", end: "2026-10-19", planHash: HASH });
  });

  it("서버 플래그가 꺼져 있으면(enabled=false) 승인 체크도 반영도 막히고 사유가 보인다", async () => {
    const onApply = vi.fn();
    await mount(view({ enabled: false, flagEnabled: false, blockers: [{ code: "flag_off", message: "원장 반영 기능이 서버에서 켜져 있지 않습니다(KIS_LEDGER_APPLY_ENABLED)." }] }), onApply);
    expect(($("apply-approve") as HTMLInputElement).disabled).toBe(true);
    expect(btn().disabled).toBe(true);
    expect($("apply-blockers")!.textContent).toContain("서버에서 켜져 있지 않습니다");
    await click(btn());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("조건을 만족하지 않으면(eligible=false) 차단 사유가 나열되고 반영할 수 없다", async () => {
    await mount(view({ eligible: false, enabled: false, blockers: [{ code: "prior_residual", message: "이전 증권사 출처의 원장 보유가 남아 있습니다" }, { code: "holdings_mismatch", message: "반영 후 보유가 관측과 다릅니다" }] }), vi.fn());
    expect($("apply-blockers")!.querySelectorAll("li")).toHaveLength(2);
    expect(btn().disabled).toBe(true);
  });

  it("반영 대상이 없고 이미 반영돼 있으면 그 사실만 알린다", async () => {
    await mount(view({ eligible: false, enabled: false, alreadyApplied: true, plan: null, blockers: [{ code: "already_applied", message: "이미 같은 주문이 원장에 반영돼 있습니다." }] }), vi.fn());
    expect($("apply-already")).toBeTruthy();
    expect($("apply-plan")).toBeNull();
    expect(btn().disabled).toBe(true);
  });
});

describe("결과 — applied 가 아니면 성공으로 안내하지 않는다", () => {
  async function submit(outcome: ApplyOutcome) {
    const onApply = vi.fn(async () => outcome);
    await mount(view(), onApply);
    await click($("apply-approve") as HTMLElement);
    await click(btn());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return onApply;
  }

  it("applied: 완료 안내 + 버튼은 '반영 완료'로 잠기고, 원금·보유수량·예수금 설정 불변을 밝힌다", async () => {
    await submit(applied);
    const t = $("apply-msg")!.textContent!;
    expect(t).toContain("원장에 2건을 반영했습니다");
    expect(t).toContain("보유수량·예수금 설정과 누적 납입원금은 바꾸지 않았습니다");
    expect(btn().textContent).toBe("반영 완료");
    expect(btn().disabled).toBe(true);
  });

  it("applied 직후 다시 눌러도 요청하지 않는다 (승인은 한 번의 요청에만 쓰인다)", async () => {
    const onApply = await submit(applied);
    await click(btn());
    await click($("apply-approve") as HTMLElement);
    await click(btn());
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["plan_changed", "승인한 뒤 원장·체결·관측이 바뀌어 반영하지 않았습니다"],
    ["already_applied", "이미 같은 주문이 원장에 반영돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다"],
    ["busy", "같은 요청이 처리 중입니다"],
    ["holdings_mismatch", "반영 후 원장 재생 보유가 한국투자 관측 보유와 달라 전부 취소했습니다"],
  ])("rejected(%s)는 반영하지 않았다고 안내하고 성공 문구가 없다", async (code, text) => {
    await submit({ kind: "rejected", code, message: code === "holdings_mismatch" ? text : "서버 메시지" });
    const t = $("apply-msg")!.textContent!;
    expect(t).toContain("반영하지 않았습니다");
    expect(t).toContain(text);
    expect(t).not.toContain("반영했습니다(batch");
    expect(btn().textContent).toBe("원장에 반영");
  });

  it("rejected 후 승인이 풀려 다시 체크해야 한다 (재시도해도 자동으로 보내지 않는다)", async () => {
    const onApply = await submit({ kind: "rejected", code: "plan_changed", message: "x" });
    expect(($("apply-approve") as HTMLInputElement).checked).toBe(false);
    expect(btn().disabled).toBe(true);
    await click(btn());
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["query_failed", "체결 재조회에 실패해 반영하지 않았습니다"],
    ["unavailable", "DB 반영 함수(migration 012)가 아직 적용되지 않아 반영할 수 없습니다"],
    ["server_error", "반영 여부가 불확실하니 다시 조회해"],
    ["network_error", "반영 여부가 불확실하니 다시 조회해"],
    ["timeout", "반영 여부가 불확실하니 다시 조회해"],
  ])("%s 는 오류 안내이고 성공 문구가 없다", async (kind, text) => {
    await submit({ kind, ...(kind === "server_error" ? { status: 500 } : {}) } as ApplyOutcome);
    expect($("apply-msg")!.textContent).toContain(text);
    expect($("apply-msg")!.textContent).not.toContain("반영했습니다");
  });
});
