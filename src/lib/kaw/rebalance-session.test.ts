/**
 * 리밸런싱 세션 orchestration — PRE 보존 · completion 멱등 · 부분 실패 복구.
 *
 * 고정하려는 사실:
 *   · flag OFF 면 **localStorage 를 건드리지 않는다** (기존 사용자에게 영향 0)
 *   · PRE 는 첫 변경 직전 1회만 캡처되고 재마운트·폴링·추가 변경에도 안 바뀐다
 *   · completionId 는 한 번 정해지고, 경제값이 같은 재시도만 그 id 를 물려받는다
 *   · 서버 ACK 없이 confirmed 로 올라가는 경로가 없다
 *   · plan 이 확정되지 않은 상태에서 journal/outbox 가 삭제되지 않는다
 *
 * vitest 환경이 node 라 localStorage 가 없다 — 테스트 안에서 스텁을 심는다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  activeSessionSnapshot,
  beginCompletion,
  capturePre,
  cleanupCompletion,
  discardMismatchedSession,
  finalizeArgsFromFrozenPayload,
  frozenHistoryPayload,
  historyOutcomeOfAck,
  hydrateSession,
  normalizeAssertedCash,
  mirrorNeedsSync,
  mirrorOf,
  pendingCompletions,
  recoveryHistoryEntryId,
  resolveSessionAccountInstance,
  settleHistoryWrite,
  settlePlanWrite,
  unregisteredInstanceId,
  type SessionContext,
  type SessionDeps,
} from "./rebalance-session";
import { SESSION_TRACKING_LS_KEY, resolveSessionTrackingFlag } from "./rebalance-feature-flags";
import {
  journalKey,
  readJournal,
  writeJournal,
  JOURNAL_SCHEMA_VERSION,
  type RebalanceJournalEntry,
} from "./rebalance-journal";
import {
  outboxKey,
  readOutbox,
  putEnvelope,
  confirmHistoryPersistence,
  MAX_AUTO_ATTEMPTS,
} from "./completion-envelope";
import type { BrokerAccountInstance } from "./broker-account";
import type { PlanRowMeta, RebalancePlan } from "./rebalance-plan";

// ── localStorage 스텁 ──────────────────────────────────────────────────────

class MemStorage implements Storage {
  private map = new Map<string, string>();
  throwOnWrite = false;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  keys() {
    return [...this.map.keys()];
  }
}

let store: MemStorage;
const original = (globalThis as { localStorage?: Storage }).localStorage;

beforeEach(() => {
  store = new MemStorage();
  (globalThis as { localStorage?: Storage }).localStorage = store;
});
afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = original;
});

function enableTracking() {
  store.setItem(SESSION_TRACKING_LS_KEY, "on");
}

// ── fixture ────────────────────────────────────────────────────────────────

const ctx: SessionContext = { familyCode: "soye", profile: "hyeobi", accountType: "irp" };
const JKEY = journalKey("soye", "hyeobi", "irp");
const OKEY = outboxKey("soye", "hyeobi");

const rowMeta: Record<string, PlanRowMeta> = {
  r1: {
    assetId: "us",
    etfName: "TIGER 미국S&P500",
    label: "미국주식",
    ticker: "360750",
    orphaned: false,
  },
  r2: {
    assetId: "bond",
    etfName: "KODEX 국고채30년",
    label: "장기채",
    ticker: "439870",
    orphaned: false,
  },
};

/** 결정적 deps. newId 는 호출 순서대로 c1, c2, … 를 준다 */
function deps(prefix = "c"): SessionDeps {
  let n = 0;
  return { now: () => `2026-10-12T0${Math.min(n, 9)}:00:00.000Z`, newId: () => `${prefix}${++n}` };
}

const captureInput = (over: Partial<Parameters<typeof capturePre>[1]> = {}) => ({
  trigger: "quantity" as const,
  dateMode: "today" as const,
  quantities: { r1: 91, r2: 103 },
  cash: 2458,
  rowMeta,
  profileKey: "growth",
  instance: { kind: "unregistered" as const, accountInstanceId: unregisteredInstanceId("irp") },
  ...over,
});

const completionInput = (over: Partial<Parameters<typeof beginCompletion>[1]> = {}) => ({
  dateMode: "today" as const,
  instance: { kind: "unregistered" as const, accountInstanceId: unregisteredInstanceId("irp") },
  planDate: "2026-10-12",
  profileKey: "growth",
  plannedQuantities: { r1: 95, r2: 100 },
  assertedPostCash: 1200,
  projectedPostCash: 1180,
  appStateQuantities: { r1: 95, r2: 100 },
  appStateCash: 2458,
  rowMeta,
  priceMode: "live" as const,
  priceEvidence: {
    r1: {
      ticker: "360750",
      price: 26_180,
      source: "kis-live" as const,
      asOf: "2026-10-12T05:40:00+09:00",
    },
    r2: {
      ticker: "439870",
      price: 14_025,
      source: "kis-live" as const,
      asOf: "2026-10-12T05:40:00+09:00",
    },
  },
  targetWeights: { r1: 40, r2: 30 },
  frozenInvested: 4_746_081,
  frozenInvestedBasis: "entry_freeze" as const,
  baseAmount: 4_748_539,
  broker: "unknown",
  actor: "hyeobi",
  buildHistoryPayload: (id: string) => ({ id, date: "2026-10-12", totalValue: 4_700_000 }),
  ...over,
});

// ── flag OFF 보장 ──────────────────────────────────────────────────────────

describe("feature flag OFF — 기존 사용자 영향 0", () => {
  it("capturePre 가 localStorage 를 건드리지 않는다", () => {
    const r = capturePre(ctx, captureInput(), deps());
    expect(r.kind).toBe("disabled");
    expect(store.keys()).toEqual([]);
  });

  it("beginCompletion 이 not_tracked 를 주고 outbox 를 만들지 않는다", () => {
    const r = beginCompletion(ctx, completionInput(), deps());
    expect(r).toEqual({ kind: "not_tracked", reason: "disabled" });
    expect(store.getItem(OKEY)).toBeNull();
  });

  it("hydrateSession 은 journal 이 남아 있어도 none 을 준다", () => {
    enableTracking();
    capturePre(ctx, captureInput(), deps());
    expect(store.getItem(JKEY)).not.toBeNull();
    store.removeItem(SESSION_TRACKING_LS_KEY); // 다시 끈다
    expect(hydrateSession(ctx, { durablePlanKnown: "unknown" }).decision.kind).toBe("none");
  });

  it("pendingCompletions 가 빈 배열이다", () => {
    expect(pendingCompletions(ctx)).toEqual([]);
  });

  it("호출부가 flag 를 잊어도 모듈이 스스로 막는다 (방어선이 두 겹이 아니라 모듈 안에 있다)", () => {
    // 플래그를 켜지 않은 상태에서 모든 쓰기 진입점을 직접 호출한다
    capturePre(ctx, captureInput(), deps());
    beginCompletion(ctx, completionInput(), deps());
    expect(store.keys()).toEqual([]);
  });

  it("완료 흐름의 쓰기 진입점 전부가 OFF 에서 아무것도 쓰지 않는다", () => {
    // settle / cleanup 까지 불러도 localStorage 에 키가 생기지 않는다
    const r = beginCompletion(ctx, completionInput(), deps());
    expect(r.kind).toBe("not_tracked");
    settleHistoryWrite(ctx, "c1", { kind: "accepted" });
    settlePlanWrite(ctx, "c1", { kind: "ack", outcome: "created" }, deps());
    expect(cleanupCompletion(ctx, "c1")).toEqual({ kind: "kept", reason: "not_found" });
    expect(store.keys()).toEqual([]);
  });

  it("OFF 에서는 세션 snapshot 이 없으므로 PRE 근거가 생기지 않는다", () => {
    expect(activeSessionSnapshot(ctx)).toBeNull();
  });

  it("production 조합(빌드 타임 허용 없음)에서는 localStorage 로도 켜지지 않는다", () => {
    // 이 테스트 환경은 DEV 라 런타임 스위치가 먹지만, production 판정은 순수 함수로 고정돼 있다
    expect(resolveSessionTrackingFlag({ env: undefined, local: "on", dev: false })).toBe(false);
  });
});

// ── account instance 확정 ──────────────────────────────────────────────────

describe("resolveSessionAccountInstance", () => {
  const mirae: BrokerAccountInstance = {
    id: "bai:mirae-irp",
    label: "미래에셋 IRP",
    broker: "mirae",
    logicalAccountType: "irp",
    activeFrom: "2025-12-29",
    activeTo: "2026-10-09",
  };
  const kis: BrokerAccountInstance = {
    id: "bai:kis-irp",
    label: "한국투자 IRP",
    broker: "kis",
    productCode: "29",
    logicalAccountType: "irp",
    activeFrom: "2026-10-09",
  };

  it("레지스트리가 없으면 논리계좌 sentinel 을 쓴다", () => {
    expect(resolveSessionAccountInstance("irp", "2026-10-12", undefined)).toEqual({
      kind: "unregistered",
      accountInstanceId: "bai:unregistered:irp",
    });
  });

  it("그 날짜에 active 가 1 개면 그 instance 다 (half-open 경계)", () => {
    expect(resolveSessionAccountInstance("irp", "2026-10-08", [mirae, kis])).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:mirae-irp",
    });
    // 이전일(10-09)부터는 한국투자 쪽으로만 떨어진다
    expect(resolveSessionAccountInstance("irp", "2026-10-09", [mirae, kis])).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:kis-irp",
    });
  });

  it("active 가 2 개면 추측하지 않는다", () => {
    const overlapping = { ...mirae, activeTo: "2026-12-31" };
    expect(resolveSessionAccountInstance("irp", "2026-10-12", [overlapping, kis])).toEqual({
      kind: "unresolved",
      reason: "ambiguous",
      candidates: ["bai:mirae-irp", "bai:kis-irp"],
    });
  });

  it("레지스트리가 있는데 그 날짜에 active 가 없으면 unresolved 다", () => {
    expect(resolveSessionAccountInstance("irp", "2025-01-01", [mirae, kis]).kind).toBe(
      "unresolved",
    );
  });

  it("다른 논리계좌의 instance 를 끌어오지 않는다", () => {
    const pension = { ...kis, id: "bai:kis-pension", logicalAccountType: "pension" as const };
    expect(resolveSessionAccountInstance("irp", "2026-10-12", [pension]).kind).toBe("unresolved");
  });
});

// ── PRE capture ────────────────────────────────────────────────────────────

describe("PRE capture — 첫 변경 직전 1회", () => {
  beforeEach(enableTracking);

  it("첫 변경에 캡처하고 dedicated journal 에 저장한다 (StoreState 밖)", () => {
    const r = capturePre(ctx, captureInput(), deps());
    expect(r.kind).toBe("captured");
    const saved = readJournal("soye", "hyeobi", "irp")!;
    expect(saved.phase).toBe("capturing");
    expect(saved.snapshot.preQuantities).toEqual({ r1: 91, r2: 103 });
    expect(saved.snapshot.preCash).toBe(2458);
    expect(saved.snapshot.trigger).toBe("quantity");
  });

  it("두 번째 변경은 PRE 를 덮어쓰지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    const second = capturePre(
      ctx,
      captureInput({ quantities: { r1: 95, r2: 100 }, cash: 1200 }),
      deps("x"),
    );
    expect(second.kind).toBe("already_captured");
    expect(readJournal("soye", "hyeobi", "irp")!.snapshot.preQuantities).toEqual({
      r1: 91,
      r2: 103,
    });
  });

  it("재마운트(= 새 호출)와 폴링 후에도 PRE 가 유지된다", () => {
    capturePre(ctx, captureInput(), deps());
    // 폴링이 memState 를 통째로 교체해 mirror 가 사라진 상황: journal 만 남아 있다
    const r = capturePre(ctx, captureInput({ quantities: { r1: 1 } }), deps("x"));
    expect(r.kind).toBe("already_captured");
    if (r.kind === "already_captured") {
      expect(r.entry.snapshot.preQuantities).toEqual({ r1: 91, r2: 103 });
      // mirror 가 비었으니 다시 써야 한다고 알려준다
      expect(mirrorNeedsSync(r.entry, null)).toBe(true);
      expect(mirrorNeedsSync(r.entry, mirrorOf(r.entry))).toBe(false);
    }
  });

  it("예수금 미입력(undefined)과 0 원을 구분해 저장한다", () => {
    capturePre(ctx, captureInput({ cash: undefined }), deps());
    expect("preCash" in readJournal("soye", "hyeobi", "irp")!.snapshot).toBe(false);
    store.removeItem(JKEY);
    capturePre(ctx, captureInput({ cash: 0 }), deps());
    expect(readJournal("soye", "hyeobi", "irp")!.snapshot.preCash).toBe(0);
  });

  it("과거 날짜 모드에서는 현재 상태를 역사적 PRE 로 승격하지 않는다", () => {
    const r = capturePre(ctx, captureInput({ dateMode: "past" }), deps());
    expect(r).toEqual({ kind: "skipped", reason: "past_date_mode" });
    expect(store.getItem(JKEY)).toBeNull();
  });

  it("미래 날짜 모드도 캡처하지 않는다", () => {
    expect(capturePre(ctx, captureInput({ dateMode: "future" }), deps())).toEqual({
      kind: "skipped",
      reason: "future_date_mode",
    });
    expect(store.getItem(JKEY)).toBeNull();
  });

  it("instance 가 확정되지 않으면 캡처하지 않는다 (fail closed)", () => {
    const r = capturePre(
      ctx,
      captureInput({
        instance: { kind: "unresolved", reason: "ambiguous", candidates: ["a", "b"] },
      }),
      deps(),
    );
    expect(r).toEqual({ kind: "skipped", reason: "instance_unresolved" });
    expect(store.getItem(JKEY)).toBeNull();
  });

  it("localStorage 쓰기가 실패하면 **성공으로 간주하지 않는다**", () => {
    store.throwOnWrite = true;
    const r = capturePre(ctx, captureInput(), deps());
    expect(r.kind).toBe("journal_write_failed");
    expect(store.getItem(JKEY)).toBeNull();
  });

  it("진행 중 세션의 계좌가 다르면 아무것도 쓰지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    const r = capturePre(
      ctx,
      captureInput({
        instance: { kind: "resolved", accountInstanceId: "bai:kis-irp" },
        quantities: { r1: 0 },
      }),
      deps("x"),
    );
    expect(r.kind).toBe("instance_mismatch");
    // 기존 PRE 는 그대로 남아 있다
    expect(readJournal("soye", "hyeobi", "irp")!.snapshot.accountInstanceId).toBe(
      "bai:unregistered:irp",
    );
  });

  it("쓸 수 없게 된 capturing 세션은 명시적으로만 버린다", () => {
    capturePre(ctx, captureInput(), deps());
    expect(discardMismatchedSession(ctx)).toEqual({ discarded: true });
    expect(store.getItem(JKEY)).toBeNull();
    // 그 뒤에는 새 계좌로 캡처된다
    expect(
      capturePre(
        ctx,
        captureInput({
          instance: { kind: "resolved", accountInstanceId: "bai:kis-irp" },
        }),
        deps("x"),
      ).kind,
    ).toBe("captured");
  });

  it("completing 세션(지난 완료의 잔재)은 새 세션이 자리를 가져간다 — envelope 은 그대로", () => {
    capturePre(ctx, captureInput(), deps());
    const begun = beginCompletion(ctx, completionInput(), deps("done"));
    expect(begun.kind).toBe("ready");
    const completionId = begun.kind === "ready" ? begun.completionId : "";

    const r = capturePre(ctx, captureInput({ quantities: { r1: 95, r2: 100 } }), deps("next"));
    expect(r.kind).toBe("captured");
    if (r.kind === "captured") expect(r.supersededCompletionId).toBe(completionId);
    expect(readJournal("soye", "hyeobi", "irp")!.phase).toBe("capturing");
    // 복구 수단은 journal 이 아니라 outbox 다 — 그대로 있어야 한다
    expect(readOutbox("soye", "hyeobi")[completionId]).toBeDefined();
  });

  it("completing 세션은 discardMismatchedSession 으로도 지워지지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    beginCompletion(ctx, completionInput(), deps("done"));
    expect(discardMismatchedSession(ctx)).toEqual({ discarded: false, reason: "completing_kept" });
    expect(store.getItem(JKEY)).not.toBeNull();
  });

  it("계좌가 다르면 journal 슬롯이 서로 간섭하지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    capturePre({ ...ctx, accountType: "isa" }, captureInput({ quantities: { r1: 7 } }), deps("x"));
    expect(readJournal("soye", "hyeobi", "irp")!.snapshot.preQuantities).toEqual({
      r1: 91,
      r2: 103,
    });
    expect(readJournal("soye", "hyeobi", "isa")!.snapshot.preQuantities).toEqual({ r1: 7 });
  });
});

// ── completion identity ────────────────────────────────────────────────────

describe("completion identity 와 멱등성", () => {
  beforeEach(enableTracking);

  it("completionId 를 한 번 만들고 양쪽 id 를 거기서 파생한다", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.ids.historyEntryId).toBe(`hist:${r.completionId}`);
    expect(r.ids.planId).toBe(`plan:${r.completionId}`);
    expect(r.plan.id).toBe(r.ids.planId);
    expect((r.envelope.historyEntryPayload as { id: string }).id).toBe(r.ids.historyEntryId);
  });

  it("journal 은 completing 으로, outbox 에는 envelope 1건이 남는다", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.journal).toBe("written");
    expect(r.outboxWritten).toBe(true);
    const journal = readJournal("soye", "hyeobi", "irp")!;
    expect(journal.phase).toBe("completing");
    expect(journal.completionId).toBe(r.completionId);
    // PRE snapshot 은 완료 중에도 보존된다
    expect(journal.snapshot.preQuantities).toEqual({ r1: 91, r2: 103 });
    expect(Object.keys(readOutbox("soye", "hyeobi"))).toEqual([r.completionId]);
  });

  it("PRE 가 있으면 plan 의 pre_basis 가 session_snapshot 이다", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.plan.preBasis).toBe("session_snapshot");
    expect(r.plan.preQuantities).toEqual({ r1: 91, r2: 103 });
    expect(r.plan.preCash).toBe(2458);
    expect(r.plan.preDiscardReason).toBeNull();
    // 완료 시점 앱 상태는 PRE 와 분리해 둔다 (포렌식용)
    expect(r.plan.appStateQuantitiesAtRecord).toEqual({ r1: 95, r2: 100 });
  });

  it("세션이 없으면 PRE 를 역산하지 않고 unknown 으로 둔다", () => {
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.plan.preBasis).toBe("unknown");
    expect(r.plan.preQuantities).toBeNull();
    expect(r.plan.preCash).toBeNull();
    expect(r.plan.preDiscardReason).toBe("no_session");
    expect(r.journal).toBe("no_session");
  });

  it("과거 날짜로 완료하면 PRE 를 쓰지 않는다 (plan 자체는 기록한다)", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput({ dateMode: "past" }), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.plan.dateMode).toBe("past");
    expect(r.plan.preBasis).toBe("unknown");
    expect(r.plan.preDiscardReason).toBe("past_date_mode");
  });

  it("레지스트리가 생겨 instance 가 바뀌면 PRE 를 버린다 (sentinel 을 실제 계좌로 승격하지 않는다)", () => {
    capturePre(ctx, captureInput(), deps()); // sentinel 로 캡처
    const r = beginCompletion(
      ctx,
      completionInput({
        instance: { kind: "resolved", accountInstanceId: "bai:kis-irp" },
      }),
      deps("done"),
    );
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.plan.accountInstanceId).toBe("bai:kis-irp");
    expect(r.plan.preBasis).toBe("unknown");
    expect(r.plan.preDiscardReason).toBe("instance_changed");
  });

  it("경제값이 같은 재시도는 같은 completionId 를 물려받고 frozen payload 를 다시 만들지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    const first = beginCompletion(ctx, completionInput(), deps("a"));
    if (first.kind !== "ready") throw new Error("ready 가 아니다");
    // 첫 시도의 history write 가 실패해 attempts 가 올라간 상태
    settleHistoryWrite(ctx, first.completionId, { kind: "failed", error: "HTTP 500" });

    const retry = beginCompletion(
      ctx,
      completionInput({
        // 재시도라서 payload 빌더가 다른 값을 줘도 **기존 frozen 값**이 유지돼야 한다
        buildHistoryPayload: (id) => ({ id, date: "2026-10-12", totalValue: 999 }),
      }),
      deps("b"),
    );
    if (retry.kind !== "ready") throw new Error("ready 가 아니다");
    expect(retry.reused).toBe(true);
    expect(retry.completionId).toBe(first.completionId);
    expect((retry.envelope.historyEntryPayload as { totalValue: number }).totalValue).toBe(
      4_700_000,
    );
    expect(retry.envelope.attempts).toBe(1);
    expect(Object.keys(readOutbox("soye", "hyeobi"))).toHaveLength(1);
  });

  it("경제값이 다르면 새 completionId 다 — 지난 완료의 HistoryEntry 를 덮어쓰지 않는다", () => {
    capturePre(ctx, captureInput(), deps());
    const first = beginCompletion(ctx, completionInput(), deps("a"));
    if (first.kind !== "ready") throw new Error("ready 가 아니다");
    // 수량이 달라졌다 = 다른 리밸런싱이다
    const second = beginCompletion(
      ctx,
      completionInput({
        plannedQuantities: { r1: 120, r2: 60 },
      }),
      deps("b"),
    );
    if (second.kind !== "ready") throw new Error("ready 가 아니다");
    expect(second.reused).toBe(false);
    expect(second.completionId).not.toBe(first.completionId);
    expect(second.ids.historyEntryId).not.toBe(first.ids.historyEntryId);
    expect(Object.keys(readOutbox("soye", "hyeobi"))).toHaveLength(2);
  });

  it("미래 날짜로는 완료를 추적하지 않는다 (완료 자체를 막지는 않는다)", () => {
    expect(beginCompletion(ctx, completionInput({ dateMode: "future" }), deps())).toEqual({
      kind: "not_tracked",
      reason: "future_date_mode",
    });
  });

  it("instance 가 확정되지 않으면 추적하지 않고 호출부가 기존 경로로 완료한다", () => {
    expect(
      beginCompletion(
        ctx,
        completionInput({
          instance: { kind: "unresolved", reason: "ambiguous", candidates: ["a", "b"] },
        }),
        deps(),
      ),
    ).toEqual({ kind: "not_tracked", reason: "instance_unresolved" });
    expect(store.getItem(OKEY)).toBeNull();
  });

  it("outbox 쓰기가 실패해도 완료를 막지 않고 실패를 드러낸다", () => {
    capturePre(ctx, captureInput(), deps());
    store.throwOnWrite = true;
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    expect(r.outboxWritten).toBe(false);
    expect(r.journal).toBe("write_failed");
    // id 는 그대로 쓸 수 있다 — 저장만 못 했을 뿐이다
    expect(r.ids.historyEntryId).toBe(`hist:${r.completionId}`);
  });
});

// ── ACK ────────────────────────────────────────────────────────────────────

describe("history write 결과 — confirmed 로 가는 경로가 없다", () => {
  beforeEach(enableTracking);

  function begin() {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    return r;
  }

  it("확인 수단이 없으면 unknown 이다 (pending 과 구분한다)", () => {
    const r = begin();
    const env = settleHistoryWrite(ctx, r.completionId, { kind: "unknown" })!;
    expect(env.historyPersistence).toBe("unknown");
    expect(env.planPersistence).toBe("pending");
  });

  it("**서버가 요청을 수용해도 confirmed 가 되지 않는다** (문서 전체 교체라 최종 상태가 아니다)", () => {
    const r = begin();
    const env = settleHistoryWrite(ctx, r.completionId, { kind: "accepted" })!;
    expect(env.historyPersistence).toBe("unknown");
    expect(env.historyPersistence).not.toBe("confirmed");
    expect(readOutbox("soye", "hyeobi")[r.completionId].historyPersistence).toBe("unknown");
  });

  it("실패는 attempts 를 올리고 상한에서 수동 재시도로 넘긴다", () => {
    const r = begin();
    let env = settleHistoryWrite(ctx, r.completionId, { kind: "failed", error: "HTTP 500" })!;
    expect(env.historyPersistence).toBe("failed");
    expect(env.attempts).toBe(1);
    expect(env.manualRetryRequired).toBe(false);
    for (let i = 1; i < MAX_AUTO_ATTEMPTS; i++) {
      env = settleHistoryWrite(ctx, r.completionId, { kind: "failed", error: "HTTP 500" })!;
    }
    expect(env.attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(env.manualRetryRequired).toBe(true);
  });

  it("plan 은 모른다를 쓰지 않는다 — POST 응답이 곧 ACK 라서 모르면 실패다", () => {
    const r = begin();
    const env = settlePlanWrite(ctx, r.completionId, { kind: "unknown" }, deps())!;
    expect(env.planPersistence).toBe("failed");
  });

  it("없는 completionId 에는 아무 일도 일어나지 않는다", () => {
    begin();
    expect(settleHistoryWrite(ctx, "없는id", { kind: "accepted" })).toBeNull();
  });
});

describe("historyOutcomeOfAck — 응답 매핑 (timeout 포함)", () => {
  it("수용 1건 이상이면 accepted (그래도 confirmed 는 아니다)", () => {
    expect(historyOutcomeOfAck({ ok: true, accepted: 1 })).toEqual({ kind: "accepted" });
    expect(historyOutcomeOfAck({ ok: true, accepted: 6 })).toEqual({ kind: "accepted" });
  });

  it("수용 0건은 unknown 이다 — 거른 것을 저장한 것으로 읽지 않는다", () => {
    expect(historyOutcomeOfAck({ ok: true, accepted: 0 })).toEqual({ kind: "unknown" });
  });

  it("서버가 accepted 를 보고하지 않으면 unknown 이다 (구버전 서버)", () => {
    expect(historyOutcomeOfAck({ ok: true, accepted: null })).toEqual({ kind: "unknown" });
  });

  it("실패는 failed 다", () => {
    expect(historyOutcomeOfAck({ ok: false, error: "HTTP 500" })).toEqual({
      kind: "failed",
      error: "HTTP 500",
    });
  });

  it("timeout 은 failed 이고 사유가 드러난다 — confirmed 로 가지 않는다", () => {
    const out = historyOutcomeOfAck({
      ok: false,
      error: "15000ms 안에 응답이 없었습니다",
      timedOut: true,
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("시간 초과");
  });

  it("어떤 응답도 confirmed 를 만들지 않는다", () => {
    const acks = [
      { ok: true as const, accepted: 1 },
      { ok: true as const, accepted: 0 },
      { ok: true as const, accepted: null },
      { ok: false as const, error: "x" },
      { ok: false as const, error: "t", timedOut: true },
    ];
    for (const ack of acks) {
      expect(["accepted", "unknown", "failed"]).toContain(historyOutcomeOfAck(ack).kind);
    }
  });
});

describe("normalizeAssertedCash — 완료 저장과 frozen payload 가 같은 값을 쓴다", () => {
  it("음수는 0 으로 떨어진다", () => {
    expect(normalizeAssertedCash(-1)).toBe(0);
    expect(normalizeAssertedCash(-99_999)).toBe(0);
  });

  it("소수는 반올림한다", () => {
    expect(normalizeAssertedCash(2457.4)).toBe(2457);
    expect(normalizeAssertedCash(2457.5)).toBe(2458);
  });

  it("정상값은 그대로다", () => {
    expect(normalizeAssertedCash(0)).toBe(0);
    expect(normalizeAssertedCash(2458)).toBe(2458);
  });

  it("NaN / Infinity 는 0 으로 떨어진다 (추정하지 않는다)", () => {
    expect(normalizeAssertedCash(Number.NaN)).toBe(0);
    expect(normalizeAssertedCash(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeAssertedCash(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("store.ts finalizeRebalance 와 같은 식이다", () => {
    for (const v of [-5, -0.4, 0, 0.5, 1.4, 2457.6, 688_074]) {
      expect(normalizeAssertedCash(v)).toBe(Math.max(0, Math.round(v)));
    }
  });
});

// ── 정리 / 복구 ────────────────────────────────────────────────────────────

describe("정리 — durable 확인 전에는 아무것도 지우지 않는다", () => {
  beforeEach(enableTracking);

  function begin() {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    return r;
  }

  /** Phase 1B 에서 생길 history durable 확인을 테스트에서만 흉내낸다. */
  function forceHistoryConfirmed(completionId: string) {
    const env = readOutbox("soye", "hyeobi")[completionId];
    putEnvelope(
      "soye",
      "hyeobi",
      confirmHistoryPersistence(env, {
        kind: "server_ack",
        outcome: "written",
        at: "2026-10-12T00:00:00.000Z",
      }),
    );
  }

  it("**Phase 1A 에서는 자동 정리되지 않는 것이 정상이다** (plan API 가 없다)", () => {
    const r = begin();
    // 완료 흐름이 할 수 있는 최대치: 요청이 수용됐다
    settleHistoryWrite(ctx, r.completionId, { kind: "accepted" });
    expect(cleanupCompletion(ctx, r.completionId)).toEqual({
      kind: "kept",
      reason: "not_fully_confirmed",
    });
    const env = readOutbox("soye", "hyeobi")[r.completionId];
    expect(env).toBeDefined();
    expect(env.historyPersistence).toBe("unknown");
    expect(env.planPersistence).toBe("pending");
    expect(store.getItem(JKEY)).not.toBeNull();
  });

  it("몇 번을 시도해도 Phase 1A 에서는 envelope 이 남는다", () => {
    const r = begin();
    for (let i = 0; i < 5; i++) {
      settleHistoryWrite(ctx, r.completionId, { kind: "accepted" });
      expect(cleanupCompletion(ctx, r.completionId).kind).toBe("kept");
    }
    expect(pendingCompletions(ctx)).toHaveLength(1);
  });

  it("history 가 unknown 이면 plan 이 확정돼도 지우지 않는다", () => {
    const r = begin();
    settleHistoryWrite(ctx, r.completionId, { kind: "unknown" });
    settlePlanWrite(ctx, r.completionId, { kind: "ack", outcome: "created" }, deps());
    expect(cleanupCompletion(ctx, r.completionId).kind).toBe("kept");
  });

  it("plan 만 확정돼도 지우지 않는다 (양쪽이 필요하다)", () => {
    const r = begin();
    settlePlanWrite(ctx, r.completionId, { kind: "ack", outcome: "already_exists" }, deps());
    expect(cleanupCompletion(ctx, r.completionId).kind).toBe("kept");
  });

  it("양쪽 durable 확인이 생기면(Phase 1B) envelope 과 journal 을 정리한다", () => {
    const r = begin();
    forceHistoryConfirmed(r.completionId);
    settlePlanWrite(ctx, r.completionId, { kind: "ack", outcome: "created" }, deps());
    expect(cleanupCompletion(ctx, r.completionId)).toEqual({
      kind: "cleaned",
      journalCleared: true,
    });
    expect(readOutbox("soye", "hyeobi")[r.completionId]).toBeUndefined();
    expect(store.getItem(JKEY)).toBeNull();
  });

  it("이미 다음 세션이 journal 슬롯을 가져갔으면 그 PRE 를 지우지 않는다", () => {
    const r = begin();
    // 사용자가 곧바로 다음 리밸런싱을 시작했다
    capturePre(ctx, captureInput({ quantities: { r1: 1 } }), deps("next"));
    forceHistoryConfirmed(r.completionId);
    settlePlanWrite(ctx, r.completionId, { kind: "ack", outcome: "created" }, deps());
    expect(cleanupCompletion(ctx, r.completionId)).toEqual({
      kind: "cleaned",
      journalCleared: false,
    });
    expect(readJournal("soye", "hyeobi", "irp")!.snapshot.preQuantities).toEqual({ r1: 1 });
  });
});

describe("복구 — 폴링이 memState 를 교체해도 재시도 수단이 살아 있다", () => {
  beforeEach(enableTracking);

  it("frozen history payload 를 재구성하지 않고 재사용한다", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    settleHistoryWrite(ctx, r.completionId, { kind: "failed", error: "offline" });

    // 폴링이 memState(= mirror 포함)를 통째로 교체했다. outbox 는 StoreState 밖이라 남는다
    const pending = pendingCompletions(ctx);
    expect(pending).toHaveLength(1);
    expect(recoveryHistoryEntryId(pending[0])).toBe(r.ids.historyEntryId);
  });

  it("plan payload 도 같은 envelope 에 함께 고정돼 있다 (한쪽에서 다른 쪽을 추론하지 않는다)", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    const env = readOutbox("soye", "hyeobi")[r.completionId];
    const plan = env.planPayload as RebalancePlan;
    expect(plan.completionId).toBe(r.completionId);
    expect(plan.planPayloadHash).toBe(r.plan.planPayloadHash);
    expect(plan.preBasis).toBe("session_snapshot");
  });

  it("Phase 1A 에서는 복구 목록이 비워지지 않는다 (plan 확인 수단이 없다)", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(ctx, completionInput(), deps("done"));
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    settleHistoryWrite(ctx, r.completionId, { kind: "accepted" });
    expect(pendingCompletions(ctx)).toHaveLength(1);
  });
});

// ── frozen payload → finalizeRebalance 인자 역조립 ─────────────────────────

describe("finalizeArgsFromFrozenPayload — 최초 저장과 동일한 인자", () => {
  beforeEach(enableTracking);

  /** AccountPage 가 완료 때 만드는 payload 와 같은 모양 (같은 필드 집합). */
  const realPayload = (over: Record<string, unknown> = {}) => ({
    id: "hist:c1",
    date: "2026-10-12",
    baseAmount: 4_748_539,
    totalValue: 4_746_081,
    deposit: 688_074,
    holdings: { us: 2_382_946, bond: 1_444_850 },
    rowEtfSnap: { r1: "TIGER 미국S&P500", r2: "KODEX 국고채30년" },
    rowLabelSnap: { r1: "미국주식", r2: "장기채" },
    rowAssetSnap: { r1: "us", r2: "bond" },
    cashBalance: 2458,
    rowHoldingsSnap: { r1: 2_382_946, r2: 1_444_850 },
    rowQuantitiesSnap: { r1: 91, r2: 103 },
    returnPct: null,
    ...over,
  });

  it("4분할 인자로 정확히 역조립한다", () => {
    const args = finalizeArgsFromFrozenPayload(realPayload())!;
    expect(args.cashBalance).toBe(2458);
    expect(args.quantities).toEqual({ r1: 91, r2: 103 });
    expect(args.rowHoldings).toEqual({ r1: 2_382_946, r2: 1_444_850 });
    expect(args.entry.id).toBe("hist:c1");
    expect(args.entry.date).toBe("2026-10-12");
    expect(args.entry.baseAmount).toBe(4_748_539);
    expect(args.entry.totalValue).toBe(4_746_081);
    expect(args.entry.deposit).toBe(688_074);
    expect(args.entry.holdings).toEqual({ us: 2_382_946, bond: 1_444_850 });
    expect(args.entry.rowEtfSnap).toEqual({ r1: "TIGER 미국S&P500", r2: "KODEX 국고채30년" });
    expect(args.entry.rowLabelSnap).toEqual({ r1: "미국주식", r2: "장기채" });
    expect(args.entry.rowAssetSnap).toEqual({ r1: "us", r2: "bond" });
  });

  it("entry 에서 cashBalance / 수량 / 평가액 스냅과 returnPct 를 떼어낸다 (store 가 다시 넣는다)", () => {
    const args = finalizeArgsFromFrozenPayload(realPayload())!;
    const entry = args.entry as Record<string, unknown>;
    expect("cashBalance" in entry).toBe(false);
    expect("rowQuantitiesSnap" in entry).toBe(false);
    expect("rowHoldingsSnap" in entry).toBe(false);
    expect("returnPct" in entry).toBe(false);
  });

  it("**실제 완료 envelope 의 payload 로 왕복해도 경제값이 같다**", () => {
    capturePre(ctx, captureInput(), deps());
    const r = beginCompletion(
      ctx,
      completionInput({
        buildHistoryPayload: (id) => realPayload({ id }),
      }),
      deps("done"),
    );
    if (r.kind !== "ready") throw new Error("ready 가 아니다");
    const env = readOutbox("soye", "hyeobi")[r.completionId];
    const args = finalizeArgsFromFrozenPayload(frozenHistoryPayload(env))!;
    expect(args.entry.id).toBe(r.ids.historyEntryId);
    expect(args.cashBalance).toBe(2458);
    expect(args.quantities).toEqual({ r1: 91, r2: 103 });
    expect(args.rowHoldings).toEqual({ r1: 2_382_946, r2: 1_444_850 });
    expect(args.entry.totalValue).toBe(4_746_081);
  });

  it("여러 번 역조립해도 같은 값이다 (현재 시세·account 상태를 읽지 않는다)", () => {
    const payload = realPayload();
    const a = finalizeArgsFromFrozenPayload(payload);
    const b = finalizeArgsFromFrozenPayload(payload);
    expect(a).toEqual(b);
  });

  it("모양이 어긋나면 고쳐서 통과시키지 않고 null 이다", () => {
    expect(finalizeArgsFromFrozenPayload(null)).toBeNull();
    expect(finalizeArgsFromFrozenPayload("문자열")).toBeNull();
    expect(finalizeArgsFromFrozenPayload([])).toBeNull();
    expect(finalizeArgsFromFrozenPayload({})).toBeNull();
    expect(finalizeArgsFromFrozenPayload(realPayload({ id: "" }))).toBeNull();
    expect(finalizeArgsFromFrozenPayload(realPayload({ cashBalance: "2458" }))).toBeNull();
    expect(finalizeArgsFromFrozenPayload(realPayload({ totalValue: Number.NaN }))).toBeNull();
    expect(
      finalizeArgsFromFrozenPayload(realPayload({ rowQuantitiesSnap: { r1: "91" } })),
    ).toBeNull();
    expect(finalizeArgsFromFrozenPayload(realPayload({ rowHoldingsSnap: undefined }))).toBeNull();
    expect(finalizeArgsFromFrozenPayload(realPayload({ date: undefined }))).toBeNull();
  });
});
