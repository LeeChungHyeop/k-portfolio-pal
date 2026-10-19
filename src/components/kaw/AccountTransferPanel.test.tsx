// @vitest-environment jsdom
// 계좌 이전 확정 · 잔고 관측 화면 (Phase 4-C-1) — 실제 컴포넌트를 렌더링하고 클릭·입력으로 검증한다.
//
// 지키는 것:
//   1. 마운트 시 자동으로 하는 일은 DB 상태 조회뿐이다 (관측 · 확정은 호출되지 않는다)
//   2. 승인 체크 없이는 관측/확정 버튼이 눌리지 않고, 눌러도 요청하지 않는다
//   3. 추정 매도는 '추정 — 실제 체결 아님'으로 보이고, 승인 문구가 그 사실을 밝힌다
//   4. 확정 요청에는 approved: true · 사용자가 입력한 금액 · 선택한 이탈 근거가 그대로 실린다 (금액을 미리 채우지 않는다)
//   5. 대사는 차이의 크기만 보여 주고 '원인 미확정'으로 표시한다 — 74,194원 · 335원
//   6. 확인 불가/체결 없음과 별개로, 원금 10,500,000원 불변을 보여 준다
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountTransferPanel } from "./AccountTransferPanel";
import type { TransferStateResponse } from "@/lib/kaw/kis-transfer-compose";
import type { ConfirmPayload, ObserveResult, TransferOutcome } from "@/lib/kaw/kis-transfer-client";
import type { TransferRecord } from "@/lib/kaw/account-transfer-record";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OBS = {
  captureId: "cap:bai:kis:2026-10-19:abc", accountInstanceId: "bai:kis", broker: "kis", sourceType: "kis_inquire_balance",
  observedAt: "2026-10-19T06:00:00.000Z", stateAsOf: "2026-10-19", stateAsOfBasis: "observation_date" as const,
  holdings: { "360750": 230, "367380": 64 }, holdingsCompleteness: "unknown" as const, cash: 2_318_828, actor: "hyeobi",
};
const EXIT = (id: string, ticker: string, name: string, q: number, amount: number, basis: "user_attested_estimate" | "broker_execution", sel: boolean) => ({
  txId: id, ticker, etfName: name, side: "sell" as const, quantity: q, price: Math.round(amount / q), amount, eventDate: basis === "user_attested_estimate" ? "2026-10-13" : "2026-10-02",
  source: basis === "user_attested_estimate" ? "user_attested_liquidation_price_proxy" : "miraeasset_capture_qty_price_reconstructed",
  importBatchId: "imp:x", tradeDateEvidence: "exact-sale-date-unknown", basis, defaultSelected: sel,
});

function okState(over: Partial<Extract<TransferStateResponse, { state: "ok" }>> = {}): Extract<TransferStateResponse, { state: "ok" }> {
  return {
    state: "ok",
    target: { instanceId: "bai:kis", label: "한국투자증권 연금저축", activeFrom: "2026-10-14", productCode: "22" },
    fromCandidates: [],
    exitCandidates: [
      EXIT("s1", "360750", "TIGER 미국S&P500", 297, 7_695_270, "user_attested_estimate", true),
      EXIT("s2", "367380", "ACE 미국나스닥100", 81, 2_564_460, "user_attested_estimate", true),
      EXIT("r1", "0181B0", "다른 종목", 252, 2_638_440, "broker_execution", false),
    ],
    records: [],
    observation: OBS,
    ledger: { derivedCash: 10_219_264, principal: 10_500_000, kisBuyAmountInLedger: 0, priorBrokerResidual: {} },
    checklist: [
      { id: "target_registered", label: "새 증권사(한국투자 연금저축) 계좌가 등록돼 있다", ok: true },
      { id: "prior_exit_in_ledger", label: "이전 증권사 보유가 원장에서 이탈 처리돼 있다", ok: true },
      { id: "observation_recorded", label: "새 증권사 잔고 관측이 기록돼 있다", ok: true },
      { id: "transfer_confirmed", label: "계좌 이전(매도 후 현금 이전)이 확정돼 있다", ok: false },
    ],
    canObserve: true, canConfirm: true, ...over,
  };
}
const RECORD: TransferRecord = {
  version: 1, kind: "sold_then_cash_transfer", logicalAccountType: "pension",
  toInstanceId: "bai:kis", toBroker: "kis", toProductCode: "22", fromInstanceId: null, fromBroker: "miraeasset", fromLabel: "미래에셋 연금저축",
  anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793, date: null, basis: "user_confirmed" },
  exitEvidence: [{ txId: "s1", ticker: "360750", etfName: "TIGER 미국S&P500", side: "sell", quantity: 297, price: 25910, amount: 7_695_270, eventDate: "2026-10-13",
    source: "user_attested_liquidation_price_proxy", importBatchId: "imp:x", tradeDateEvidence: "exact-sale-date-unknown", basis: "user_attested_estimate" }],
  containsEstimates: true, principalEffect: "none", createsCashflow: false,
  observation: { captureId: OBS.captureId, stateAsOf: OBS.stateAsOf, observedAt: OBS.observedAt },
  approval: { actor: "hyeobi", at: "2026-10-19T06:10:00.000Z", note: null },
};

const ok = <T,>(data: T): TransferOutcome<T> => ({ kind: "ok", data });
let root: Root; let host: HTMLDivElement;
async function mount(p: Partial<React.ComponentProps<typeof AccountTransferPanel>> = {}) {
  const loadState = p.loadState ?? vi.fn(async () => ok<TransferStateResponse>(okState()));
  const observe = p.observe ?? vi.fn(async () => ok<ObserveResult>({ state: "recorded", observation: OBS }));
  const confirm = p.confirm ?? vi.fn(async (_x: ConfirmPayload) => ok({ state: "confirmed" as const, record: RECORD }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(React.createElement(AccountTransferPanel, { loadState, observe, confirm, kisBuyAmount: p.kisBuyAmount ?? null })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { loadState, observe, confirm };
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
async function click(el: HTMLElement) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); }
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => { document.body.innerHTML = ""; });

describe("마운트 — 자동으로는 상태 조회만 한다", () => {
  it("상태 조회 1회 · 관측 · 확정은 호출되지 않는다", async () => {
    const { loadState, observe, confirm } = await mount();
    expect(loadState).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("거래원장 · 보유수량 · 예수금 설정 · 원금을 바꾸지 않으며 기록은 고칠 수 없다고 밝힌다", async () => {
    await mount();
    const d = $("transfer-disclaimer")!.textContent!;
    expect(d).toContain("거래원장 · 보유수량 · 예수금 설정 · 누적 납입원금을 바꾸지 않습니다");
    expect(d).toContain("고치거나 지울 수 없습니다");
    expect(d).toContain("신규 납입이 아닙니다");
  });

  it("권한이 없으면 안내만 보이고 아무 버튼도 없다", async () => {
    await mount({ loadState: vi.fn(async () => ({ kind: "forbidden" } as TransferOutcome<TransferStateResponse>)) });
    expect($("transfer-error")!.textContent).toContain("권한이 없습니다");
    expect($("obs-button")).toBeNull();
    expect($("confirm-button")).toBeNull();
  });

  it("한국투자 계좌가 없으면 등록 안내를 보인다", async () => {
    await mount({ loadState: vi.fn(async () => ok<TransferStateResponse>({ state: "no_target" })) });
    expect($("transfer-no-target")).toBeTruthy();
  });
});

describe("잔고 관측 — 승인 하에서만", () => {
  it("관측 기준 시각 · 증권사 기준일(현재 잔고=조회일) · 출처 · 보유 · 예수금이 보인다", async () => {
    await mount();
    const t = $("obs-summary")!.textContent!;
    expect(t).toContain("한국투자증권");
    expect(t).toContain("kis_inquire_balance");
    expect(t).toContain("2026-10-19");
    expect(t).toContain("현재 잔고 = 조회일");
    expect(t).toContain("360750 230주");
    expect(t).toContain("367380 64주");
    expect($("obs-cash")!.textContent).toBe("2,318,828원");
  });

  it("승인 체크 전에는 버튼이 비활성이고, 체크하면 1회 요청한다", async () => {
    const { observe } = await mount();
    const btn = $("obs-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await click(btn);
    expect(observe).not.toHaveBeenCalled();
    await click($("obs-approve") as HTMLElement);
    expect(btn.disabled).toBe(false);
    await click(btn);
    expect(observe).toHaveBeenCalledTimes(1);
    expect($("transfer-msg")!.textContent).toContain("관측 1건을 기록했습니다");
    expect($("transfer-msg")!.textContent).toContain("바꾸지 않았습니다");
  });

  it("기록 후에는 승인이 풀려 다시 눌러도 요청하지 않는다 (한 번의 승인 = 한 번의 조회)", async () => {
    const { observe } = await mount();
    await click($("obs-approve") as HTMLElement);
    await click($("obs-button") as HTMLElement);
    expect(($("obs-approve") as HTMLInputElement).checked).toBe(false);
    expect(($("obs-button") as HTMLButtonElement).disabled).toBe(true);
    await click($("obs-button") as HTMLElement);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("조회에 실패하면 자동으로 다시 시도하지 않고 기록하지 않았다고 알린다", async () => {
    const observe = vi.fn(async () => ok<ObserveResult>({ state: "query_failed", failure: "auth" }));
    await mount({ observe });
    await click($("obs-approve") as HTMLElement);
    await click($("obs-button") as HTMLElement);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(observe).toHaveBeenCalledTimes(1);
    expect($("transfer-msg")!.textContent).toContain("아무것도 기록하지 않았습니다");
  });
});

describe("이전 확정 — 추정 매도는 추정으로 보이고 승인 하에서만", () => {
  it("추정 매도에는 ‘추정 매도 — 실제 체결 아님’ 표시가 있고 기본 선택된다. 실제 체결은 선택되지 않는다", async () => {
    await mount();
    const rows = $$("exit-row");
    expect(rows).toHaveLength(3);
    expect($$("exit-estimate-badge")).toHaveLength(2);
    expect($$("exit-estimate-badge")[0].textContent).toContain("실제 체결 아님");
    const checks = rows.map((r) => (r.querySelector("input") as HTMLInputElement).checked);
    expect(checks).toEqual([true, true, false]);
    expect(rows[2].textContent).toContain("증권사 체결");
  });

  it("이전 금액을 미리 채우지 않는다 — 비어 있으면 확정할 수 없다", async () => {
    const { confirm } = await mount();
    expect(($("cash-amount") as HTMLInputElement).value).toBe("");
    await click($("confirm-approve") as HTMLElement);
    const btn = $("confirm-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await click(btn);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("승인 문구가 추정이 실제 체결이 아님 · 신규 납입이 아님 · 원장/보유수량/예수금 불변을 밝힌다", async () => {
    await mount();
    const label = ($("confirm-approve") as HTMLElement).closest("label")!.textContent!;
    expect(label).toContain("전량 매도한 뒤 현금으로 이전");
    expect(label).toContain("실제 체결이 아니라 사용자가 승인한 추정");
    expect(label).toContain("신규 납입이 아니고");
    expect(label).toContain("바꾸지 않음");
  });

  it("승인 + 금액 입력 후 확정하면 approved:true · 입력한 금액 · 선택한 이탈 근거 · 입고 일자 null 이 그대로 전송된다", async () => {
    const { confirm } = await mount();
    await type($("cash-amount") as HTMLInputElement, "10,293,793");
    await click($("confirm-approve") as HTMLElement);
    const btn = $("confirm-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await click(btn);
    expect(confirm).toHaveBeenCalledTimes(1);
    const p = (confirm as unknown as { mock: { calls: ConfirmPayload[][] } }).mock.calls[0][0];
    expect(p).toMatchObject({
      toInstanceId: "bai:kis", fromInstanceId: null, fromBroker: "miraeasset", fromLabel: "미래에셋 연금저축",
      anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793, date: null }, exitTxIds: ["s1", "s2"], approved: true,
    });
    expect($("transfer-msg")!.textContent).toContain("이력에 기록했습니다");
  });

  it("서버가 거절하면 거절 사유를 보이고 기록했다고 말하지 않는다", async () => {
    const confirm = vi.fn(async () => ({ kind: "rejected", code: "evidence_missing", message: "이전 증거가 부족합니다." } as TransferOutcome<never>));
    await mount({ confirm: confirm as never });
    await type($("cash-amount") as HTMLInputElement, "10293793");
    await click($("confirm-approve") as HTMLElement);
    await click($("confirm-button") as HTMLElement);
    expect($("transfer-msg")!.textContent).toContain("기록하지 않았습니다 — 이전 증거가 부족합니다.");
  });

  it("확정 조건이 안 되면 사유를 보이고 확정 버튼은 눌려도 요청하지 않는다", async () => {
    const { confirm } = await mount({ loadState: vi.fn(async () => ok<TransferStateResponse>(okState({ canConfirm: false, observation: null }))) });
    expect($("confirm-blocked")).toBeTruthy();
    await type($("cash-amount") as HTMLInputElement, "10293793");
    await click($("confirm-approve") as HTMLElement);
    expect(($("confirm-button") as HTMLButtonElement).disabled).toBe(true);
    await click($("confirm-button") as HTMLElement);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("확정된 뒤에는 기록(추정 포함 · 입고 일자 미확인 · 승인자)이 보이고 입력 폼은 없다", async () => {
    await mount({ loadState: vi.fn(async () => ok<TransferStateResponse>(okState({ records: [RECORD], canConfirm: false }))) });
    const t = $("transfer-record")!.textContent!;
    expect(t).toContain("수정할 수 없음");
    expect(t).toContain("미래에셋 연금저축");
    expect(t).toContain("(레지스트리 미등록)");
    expect(t).toContain("2026-10-13");
    expect(t).toContain("10,293,793원");
    expect(t).toContain("미확인");
    expect(t).toContain("추정 포함(실제 체결 아님)");
    expect(t).toContain("hyeobi");
    expect($("confirm-button")).toBeNull();
    expect($("cash-amount")).toBeNull();
  });
});

describe("자금 대사 — 차이의 크기만, 원인 미확정", () => {
  const withRecord = () => ok<TransferStateResponse>(okState({ records: [RECORD], canConfirm: false }));

  it("체결내역 조회 전에는 대사가 대기 상태다", async () => {
    await mount({ loadState: vi.fn(async () => withRecord()), kisBuyAmount: null });
    expect($("recon-pending")).toBeTruthy();
    expect($("recon-ledger_vs_observed")).toBeNull();
  });

  it("실제 수치: 기대 2,319,163 · 관측 2,318,828 → −335원, 원장 대비 +74,194원, 둘 다 원인 미확정", async () => {
    await mount({ loadState: vi.fn(async () => withRecord()), kisBuyAmount: 7_974_630 });
    expect($("recon-expected_vs_observed-diff")!.textContent).toBe("−335원");
    expect($("recon-ledger_vs_observed-diff")!.textContent).toBe("+74,194원");
    for (const id of ["recon-expected_vs_observed", "recon-ledger_vs_observed"]) {
      expect($(id)!.getAttribute("data-status")).toBe("unconfirmed");
      expect($(id)!.textContent).toContain("원인 미확정");
    }
    expect($("transfer-recon")!.textContent).toContain("2,319,163원");
  });

  it("원인을 이자 · 분배금 · 수수료 등으로 단정하지 않는다 (분류하지 않는다고만 밝힌다)", async () => {
    await mount({ loadState: vi.fn(async () => withRecord()), kisBuyAmount: 7_974_630 });
    const t = $("recon-not-classified")!.textContent!;
    expect(t).toContain("자동으로 분류하지 않는 항목");
    expect(t).toContain("수수료");
    expect(t).toContain("보정 거래는 만들지 않습니다");
    const body = $("transfer-recon")!.textContent!;
    expect(body).not.toMatch(/수수료(입니다|로 추정|때문)|이자(입니다|로 추정|때문)|분배금(입니다|으로 추정|때문)/);
  });

  it("누적 납입원금 10,500,000원 — 변동 없음", async () => {
    await mount({ loadState: vi.fn(async () => withRecord()), kisBuyAmount: 7_974_630 });
    expect($("recon-principal")!.textContent).toBe("10,500,000원");
    expect($("transfer-recon")!.textContent).toContain("변동 없음");
  });
});
