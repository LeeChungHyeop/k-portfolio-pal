// @vitest-environment jsdom
// 계좌 상태 동기화 승인 화면 (Phase 4-D) — 실제 컴포넌트를 렌더링하고 클릭으로 검증한다.
//
// 지키는 것:
//   1. 날짜가 섞이지 않는다: 보유수량 효력일 / 예수금 관측 기준일 / 오래된 관측 표시
//   2. 승인 체크 없이는 버튼이 눌리지 않고, 서버 플래그가 꺼져 있으면(enabled=false) 승인이 막힌다
//   3. 오래된 관측은 별도 승인이 있어야 한다. 승인은 한 번의 요청에만 쓰이고 연타해도 한 번만 호출된다
//   4. applied 가 아니면 성공으로 안내하지 않는다. 성공하면 서버 상태를 다시 불러온다(onApplied)
//   5. 원금 불변 · 변경되지 않는 것 · 원인 미확정 · 영향받는 기존 스냅샷 경고가 보인다
//   6. 기존 동기화 기록은 읽기 전용 목록으로 보이고 리밸런싱 이력이 아님이 표시된다
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrokerSyncPanel } from "./BrokerSyncPanel";
import type { SyncApplyOutcome, SyncPreviewData, SyncPreviewOutcome } from "@/lib/kaw/kis-sync-client";
import type { BrokerSyncRecord } from "@/lib/kaw/broker-sync-basis";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = "s1|abcdef0123456789";
function data(over: Partial<SyncPreviewData> = {}, planOver: Record<string, unknown> = {}): SyncPreviewData {
  return {
    enabled: true, flagEnabled: true, eligible: true, alreadySynced: false, needsStaleApproval: false, blockers: [], today: "2026-10-20",
    balance: { liveAttempted: true, failure: null, source: "kis_live_read", stateAsOf: "2026-10-20", observedAt: "2026-10-20T00:30:00.000Z" },
    plan: {
      planHash: HASH, recordId: "bsync:x", holdingsEffectiveFrom: "2026-10-14",
      rows: [
        { rowId: "kr", etfName: "TIGER 미국S&P500", ticker: "360750", quantityBefore: 297, quantityAfter: 230 },
        { rowId: "us", etfName: "ACE 미국나스닥100", ticker: "367380", quantityBefore: 81, quantityAfter: 64 },
      ],
      cash: { before: 29_296, after: 2_330_000, stateAsOf: "2026-10-20", observedAt: "2026-10-20T00:30:00.000Z", source: "kis_live_read", fresh: true },
      principal: { amount: 10_500_000, unchanged: true },
      untouched: { historyCount: 12, cashflowCount: 7, baseAmount: 10_500_000 },
      reconciliation: { lines: [{ id: "cash", label: "예수금 차이", difference: 74_194, status: "unconfirmed" }] },
      incomeRangeUpper: 16_078,
      affectedSnapshotDates: ["2026-10-14", "2026-10-19"],
      transfer: { anchorDate: "2026-10-13", amount: 10_293_793 },
      ...planOver,
    } as never,
    ...over,
  };
}
const staleData = () => data({
  needsStaleApproval: true, eligible: false,
  blockers: [{ code: "balance_stale", message: "증권사 잔고의 기준일(2026-10-19)이 오늘(2026-10-20)이 아닙니다" }],
  balance: { liveAttempted: true, failure: "auth_or_transport", source: "stored_observation", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" },
}, { cash: { before: 29_296, after: 2_318_828, stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z", source: "stored_observation", fresh: false } });

const ok = (d: SyncPreviewData): SyncPreviewOutcome => ({ kind: "ok", data: d });
const applied: SyncApplyOutcome = { kind: "applied", recordId: "bsync:x", revision: 6 };

let root: Root; let host: HTMLDivElement;
async function mount(opts: { preview?: ReturnType<typeof vi.fn>; apply?: ReturnType<typeof vi.fn>; onApplied?: ReturnType<typeof vi.fn>; syncs?: BrokerSyncRecord[] }) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(BrokerSyncPanel, {
      syncs: opts.syncs ?? [], preview: (opts.preview ?? vi.fn()) as never, apply: (opts.apply ?? vi.fn()) as never, onApplied: opts.onApplied as never,
    }));
  });
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
async function click(el: HTMLElement) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); }
const applyBtn = () => $("sync-apply-button") as HTMLButtonElement;
beforeEach(() => { document.body.innerHTML = ""; });

describe("확인 · 표시", () => {
  it("처음에는 아무것도 호출하지 않는다 (자동 호출 없음)", async () => {
    const preview = vi.fn(); const apply = vi.fn();
    await mount({ preview, apply });
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect($("sync-result")).toBeNull();
  });

  it("[증권사 잔고 읽고 확인] 은 live=true, [저장된 관측으로 확인] 은 live=false 로 호출한다", async () => {
    const preview = vi.fn(async () => ok(data()));
    await mount({ preview });
    await click($("sync-check-live")!);
    expect(preview).toHaveBeenLastCalledWith({ live: true, staleObservationApproved: false });
    await click($("sync-check-stored")!);
    expect(preview).toHaveBeenLastCalledWith({ live: false, staleObservationApproved: false });
  });

  it("종목별 변경 전/후 수량과 날짜가 분리돼 보인다: 효력일 ≠ 예수금 관측 기준일", async () => {
    await mount({ preview: vi.fn(async () => ok(data({ balance: { liveAttempted: true, failure: null, source: "kis_live_read", stateAsOf: "2026-10-20", observedAt: "2026-10-20T00:30:00.000Z" } }))) });
    await click($("sync-check-live")!);
    const rows = $$("sync-row").map((r) => r.textContent);
    expect(rows[0]).toContain("297주"); expect(rows[0]).toContain("230주");
    expect(rows[1]).toContain("81주"); expect(rows[1]).toContain("64주");
    expect($("sync-dates")!.textContent).toContain("2026-10-14");
    expect($("sync-dates")!.textContent).toContain("매수 체결일");
    const cash = $("sync-cash")!.textContent!;
    expect(cash).toContain("29,296원"); expect(cash).toContain("2,330,000원"); expect(cash).toContain("2026-10-20");
    expect(cash).toContain("2026-10-14 의 잔고가 아닙니다");
    expect($("sync-balance-source")!.textContent).toContain("방금 증권사에서 읽음");
  });

  it("원금 불변 · 변경되지 않는 것 · 원인 미확정 · 가능 범위(확정 아님)가 보인다", async () => {
    await mount({ preview: vi.fn(async () => ok(data())) });
    await click($("sync-check-live")!);
    expect($("sync-principal")!.textContent).toContain("10,500,000원");
    expect(host.textContent).toContain("이력 12건");
    expect(host.textContent).toContain("현금흐름 7건");
    expect($("sync-recon")!.textContent).toContain("원인 미확정");
    expect($("sync-income-range")!.textContent).toContain("16,078원");
    expect($("sync-income-range")!.textContent).toContain("확정된 수입이 아닙니다");
  });

  it("영향받는 기존 스냅샷 날짜를 경고하되 고치지 않는다고 알린다", async () => {
    await mount({ preview: vi.fn(async () => ok(data())) });
    await click($("sync-check-live")!);
    const t = $("sync-affected")!.textContent!;
    expect(t).toContain("2026-10-14"); expect(t).toContain("2026-10-19");
    expect(t).toContain("고치지 않고 그대로 보존");
  });

  it("라이브 읽기에 실패하면 저장된 관측임과 기준일, 재시도하지 않았음을 보인다", async () => {
    await mount({ preview: vi.fn(async () => ok(staleData())) });
    await click($("sync-check-live")!);
    const src = $("sync-balance-source")!.textContent!;
    expect(src).toContain("저장된 관측"); expect(src).toContain("2026-10-19");
    expect(src).toContain("자동으로 다시 시도하지 않았습니다");
    expect($("sync-stale")!.textContent).toContain("현재 시점의 잔고가 아닙니다");
  });

  it("서버 플래그가 꺼져 있으면 계획은 보이지만 승인이 막힌다", async () => {
    await mount({ preview: vi.fn(async () => ok(data({ enabled: false, flagEnabled: false }))) });
    await click($("sync-check-live")!);
    expect($("sync-plan")).toBeTruthy();
    expect(($("sync-approve") as HTMLInputElement).disabled).toBe(true);
    expect($("sync-flag-off")).toBeTruthy();
    expect(applyBtn().disabled).toBe(true);
  });

  it("차단 사유가 있으면 그대로 보인다 (원장 재생 ≠ 증권사 보유)", async () => {
    await mount({ preview: vi.fn(async () => ok(data({ eligible: false, enabled: false, plan: null, blockers: [{ code: "holdings_mismatch", message: "원장 재생 보유와 한국투자 잔고가 다릅니다" }] }))) });
    await click($("sync-check-live")!);
    expect($("sync-blockers")!.textContent).toContain("원장 재생 보유");
    expect($("sync-plan")).toBeNull();
    expect(applyBtn().disabled).toBe(true);
  });
});

describe("승인 — 체크 없이는 눌리지 않고, 한 번의 요청에만 쓰인다", () => {
  it("승인 체크 전에는 버튼이 비활성, 체크하면 활성", async () => {
    await mount({ preview: vi.fn(async () => ok(data())), apply: vi.fn() });
    await click($("sync-check-live")!);
    expect(applyBtn().disabled).toBe(true);
    await click($("sync-approve")!);
    expect(applyBtn().disabled).toBe(false);
  });

  it("반영 요청에 사용자가 본 planHash 가 실리고, 성공하면 서버 상태를 다시 불러온다", async () => {
    const apply = vi.fn(async () => applied); const onApplied = vi.fn(async () => true);
    await mount({ preview: vi.fn(async () => ok(data())), apply, onApplied });
    await click($("sync-check-live")!); await click($("sync-approve")!); await click(applyBtn());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ planHash: HASH, staleObservationApproved: false });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect($("sync-msg")!.textContent).toContain("동기화했습니다");
    expect(applyBtn().disabled).toBe(true);
    expect(applyBtn().textContent).toContain("동기화 완료");
  });

  it("연타해도 한 번만 호출된다", async () => {
    let release!: (o: SyncApplyOutcome) => void;
    const apply = vi.fn(() => new Promise<SyncApplyOutcome>((r) => { release = r; }));
    await mount({ preview: vi.fn(async () => ok(data())), apply });
    await click($("sync-check-live")!); await click($("sync-approve")!);
    await click(applyBtn()); await click(applyBtn()); await click(applyBtn());
    expect(apply).toHaveBeenCalledTimes(1);
    await act(async () => { release(applied); });
  });

  it("거절되면 성공으로 안내하지 않고 승인이 풀리며, 서버 상태를 다시 불러오지 않는다", async () => {
    const apply = vi.fn(async (): Promise<SyncApplyOutcome> => ({ kind: "rejected", code: "plan_changed", message: "m" }));
    const onApplied = vi.fn();
    await mount({ preview: vi.fn(async () => ok(data())), apply, onApplied });
    await click($("sync-check-live")!); await click($("sync-approve")!); await click(applyBtn());
    expect($("sync-msg")!.textContent).toContain("반영하지 않았습니다");
    expect($("sync-msg")!.textContent).not.toContain("동기화했습니다");
    expect(onApplied).not.toHaveBeenCalled();
    expect(($("sync-approve") as HTMLInputElement).checked).toBe(false);
    expect(applyBtn().disabled).toBe(true);
  });

  it("함수 없음 · 네트워크 오류도 성공으로 안내하지 않는다 (불확실하면 새로 고침 안내)", async () => {
    for (const [o, text] of [[{ kind: "unavailable" }, "migration 013"], [{ kind: "network_error" }, "반영 여부가 불확실"]] as Array<[SyncApplyOutcome, string]>) {
      document.body.innerHTML = "";
      await mount({ preview: vi.fn(async () => ok(data())), apply: vi.fn(async () => o) });
      await click($("sync-check-live")!); await click($("sync-approve")!); await click(applyBtn());
      expect($("sync-msg")!.textContent).toContain(text);
      expect($("sync-msg")!.textContent).not.toContain("동기화했습니다");
    }
  });
});

describe("오래된 관측은 별도 승인이 필요하다", () => {
  it("별도 승인 없이는 일반 승인을 해도 버튼이 눌리지 않는다", async () => {
    await mount({ preview: vi.fn(async () => ok(staleData())), apply: vi.fn() });
    await click($("sync-check-stored")!);
    await click($("sync-approve")!);
    expect(applyBtn().disabled).toBe(true);
    await click($("sync-stale-approve")!);
    // 별도 승인을 체크하면 일반 승인이 풀린다 — 다시 체크해야 한다 (승인 두 개는 따로)
    expect(applyBtn().disabled).toBe(true);
    await click($("sync-approve")!);
    expect(applyBtn().disabled).toBe(false);
  });

  it("별도 승인 시 요청에 staleObservationApproved:true 가 실린다", async () => {
    const apply = vi.fn(async () => applied);
    await mount({ preview: vi.fn(async () => ok(staleData())), apply, onApplied: vi.fn() });
    await click($("sync-check-stored")!);
    await click($("sync-stale-approve")!); await click($("sync-approve")!); await click(applyBtn());
    expect(apply).toHaveBeenCalledWith({ planHash: HASH, staleObservationApproved: true });
  });
});

describe("동기화 기록 목록(읽기 전용)", () => {
  const rec = {
    id: "bsync:x", kind: "broker_sync", version: 1, accountType: "pension", holdingsEffectiveFrom: "2026-10-14",
    holdingsByTicker: { "360750": 230, "367380": 64 }, cash: { amount: 2_318_828, stateAsOf: "2026-10-19", fresh: false },
    approvedAt: "2026-10-20T01:10:00.000Z", approvedBy: "hyeobi", createsTrade: false, createsCashflow: false, notRebalance: true,
  } as unknown as BrokerSyncRecord;

  it("기록이 없으면 목록을 그리지 않는다", async () => {
    await mount({});
    expect($("sync-history")).toBeNull();
  });
  it("효력일 · 수량 · 예수금(관측 기준일) · 승인 시각이 분리돼 보이고 리밸런싱 이력이 아님이 표시된다", async () => {
    await mount({ syncs: [rec] });
    const t = $("sync-history")!.textContent!;
    expect(t).toContain("리밸런싱 이력이 아님");
    expect(t).toContain("보유수량 효력일 2026-10-14");
    expect(t).toContain("360750 230주");
    expect(t).toContain("2,318,828원"); expect(t).toContain("관측 기준일 2026-10-19"); expect(t).toContain("오래된 관측");
    expect(t).toContain("2026-10-20 10:10 KST"); expect(t).toContain("hyeobi");
    expect(t).toContain("거래 없음"); expect(t).toContain("현금흐름 없음");
  });
});
