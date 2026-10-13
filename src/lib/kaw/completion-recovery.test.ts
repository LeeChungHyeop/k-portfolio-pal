/**
 * 미완료 완료의 **수동 복구**를 고정한다 (Phase 1B-3B).
 *
 * 여기서 지키는 것:
 *   1. History / Plan 을 **각각** 설명하고, 실패(거부)와 확인 못 함을 구분한다
 *   2. 재시도는 frozen payload 만, 같은 completionId 로, **수신 확인 안 된 쪽만** 보낸다
 *   3. 중복 클릭은 막힌다(잠금). 3회 실패 후에는 사용자가 눌러야만 움직인다
 *   4. 새 세션의 journal 을 과거 복구가 지우지 않는다
 *   5. **자동 재시도·자동 삭제 경로가 없다**
 *   6. 서버 확인 실패를 미저장으로 단정하지 않는다
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  acquireCompletionLock,
  DISMISS_DENIED_BY_DEFAULT,
  describeCompletion,
  dismissSettled,
  isCompletionBusy,
  listCompletions,
  notifyOutboxChanged,
  retryCompletion,
  subscribeOutbox,
  type RecoveryDeps,
} from "./completion-recovery";
import {
  COMPLETION_SCHEMA_VERSION,
  MAX_AUTO_ATTEMPTS,
  putEnvelope,
  readOutbox,
  type CompletionEnvelope,
} from "./completion-envelope";
import { journalKey, writeJournal, readJournal } from "./rebalance-journal";
import { SESSION_TRACKING_LS_KEY } from "./rebalance-feature-flags";
import type { HistoryMergeOutcome, PlanWriteOutcome, SessionContext } from "./rebalance-session";

class MemStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

let store: MemStorage;
const original = (globalThis as { localStorage?: Storage }).localStorage;
beforeEach(() => {
  store = new MemStorage();
  (globalThis as { localStorage?: Storage }).localStorage = store;
  store.setItem(SESSION_TRACKING_LS_KEY, "on");
});
afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = original;
});

const ctx: SessionContext = { familyCode: "soye", profile: "hyeobi", accountType: "irp" };

const HISTORY_PAYLOAD = {
  id: "hist:c-1", date: "2026-10-12", baseAmount: 1_000_000, totalValue: 1_010_000,
  deposit: 0, cashBalance: 3_621, returnPct: null,
  rowQuantitiesSnap: { r1: 10 }, rowHoldingsSnap: { r1: 1_000_000 },
};
const PLAN_PAYLOAD = {
  id: "plan:c-1", completionId: "c-1", accountType: "irp", planPayloadHash: "p1|abc",
};

function envelope(over: Partial<CompletionEnvelope> = {}): CompletionEnvelope {
  return {
    schemaVersion: COMPLETION_SCHEMA_VERSION,
    completionId: "c-1",
    sessionId: "s-1",
    accountType: "irp",
    accountInstanceId: "bai:unregistered:irp",
    createdAt: "2026-10-12T05:00:00.000Z",
    historyEntryPayload: HISTORY_PAYLOAD,
    planPayload: PLAN_PAYLOAD,
    historyPersistence: "unknown",
    planPersistence: "pending",
    attempts: 0,
    manualRetryRequired: false,
    ...over,
  };
}

const seed = (env: CompletionEnvelope) => putEnvelope(ctx.familyCode, ctx.profile, env);
const get = (id = "c-1") => readOutbox(ctx.familyCode, ctx.profile)[id];

/** 호출 기록을 남기는 가짜 서버. 응답은 큐로 준다. */
function fakeDeps(opts: {
  history?: HistoryMergeOutcome[];
  plan?: PlanWriteOutcome[];
  hold?: Promise<void>;
} = {}) {
  const calls: Array<{ side: "history" | "plan"; accountType?: string; payload: unknown }> = [];
  const history = [...(opts.history ?? [])];
  const plan = [...(opts.plan ?? [])];
  const revisions: Array<[string, number | undefined]> = [];
  const deps: RecoveryDeps = {
    postHistory: async (accountType, payload) => {
      calls.push({ side: "history", accountType, payload });
      if (opts.hold) await opts.hold;
      return history.shift() ?? { kind: "ack", outcome: "created" };
    },
    postPlan: async (payload) => {
      calls.push({ side: "plan", payload });
      if (opts.hold) await opts.hold;
      return plan.shift() ?? { kind: "ack", outcome: "created" };
    },
    onHistoryRevision: (a, r) => void revisions.push([a, r]),
  };
  return { deps, calls, revisions };
}

// ── 1. 표시 모델 ────────────────────────────────────────────────────────────

describe("describeCompletion — 쪽별 상태와 사유", () => {
  it("History / Plan 을 각각 설명한다", () => {
    const v = describeCompletion(envelope({
      historyPersistence: "confirmed",
      planPersistence: "failed",
      planDetail: { kind: "failed", message: "plan_hash_mismatch" },
      attempts: 1,
    }));
    expect(v.history.status).toBe("received");
    expect(v.plan.status).toBe("rejected");
    expect(v.plan.detail).toBe("plan_hash_mismatch");
    // 다시 보낼 쪽은 수신 확인 안 된 쪽뿐이다
    expect(v.retrySides).toEqual(["plan"]);
  });

  it("**서버 확인 못 함은 '저장 안 됨'이 아니다**", () => {
    const v = describeCompletion(envelope({
      historyPersistence: "unknown",
      historyDetail: { kind: "unknown", message: "네트워크 오류: Failed to fetch" },
      planPersistence: "failed",
      planDetail: { kind: "unknown", message: "15000ms 안에 응답이 없었습니다" },
    }));
    for (const side of [v.history, v.plan]) {
      expect(side.status).toBe("unverified");
      expect(side.label).toContain("저장 실패가 아닙니다");
      expect(side.label).not.toMatch(/저장되지 않|미저장|저장 안/);
    }
    expect(v.note).toContain("중복되지 않습니다");
  });

  it("**명시적 거부(rejected)와 확인 못 함(unverified)을 구분한다**", () => {
    const rejected = describeCompletion(envelope({
      planPersistence: "failed", planDetail: { kind: "failed", message: "422" },
    })).plan.status;
    const unverified = describeCompletion(envelope({
      planPersistence: "failed", planDetail: { kind: "unknown", message: "timeout" },
    })).plan.status;
    expect(rejected).toBe("rejected");
    expect(unverified).toBe("unverified");
  });

  it("사유가 없는 failed(구버전 envelope)를 거부로 단정하지 않는다", () => {
    const v = describeCompletion(envelope({ planPersistence: "failed" }));
    expect(v.plan.status).toBe("unverified");
  });

  it("수신 확인 문구는 최종 보존을 말하지 않는다", () => {
    const v = describeCompletion(envelope({
      historyPersistence: "confirmed", planPersistence: "confirmed",
    }));
    expect(v.settled).toBe(true);
    expect(v.history.label).toContain("최종 보존 보장은 아님");
    expect(v.note).toContain("최종 보존을 보장하지는 않습니다");
    const text = JSON.stringify([v.history, v.plan, v.note]);
    expect(text).not.toMatch(/저장 완료|확정됨|영구/);
  });

  it(`${MAX_AUTO_ATTEMPTS}회 실패(manualRetryRequired)는 사유 확인을 안내한다`, () => {
    const v = describeCompletion(envelope({ attempts: 3, manualRetryRequired: true }));
    expect(v.manualRetryRequired).toBe(true);
    expect(v.note).toContain("직접 다시 보내세요");
  });
});

describe("listCompletions", () => {
  it("복구 대상과 수신 확인됨을 나눈다", () => {
    seed(envelope({ completionId: "c-1" }));
    seed(envelope({
      completionId: "c-2", historyPersistence: "confirmed", planPersistence: "confirmed",
    }));
    const { pending, settled } = listCompletions(ctx);
    expect(pending.map((v) => v.completionId)).toEqual(["c-1"]);
    expect(settled.map((v) => v.completionId)).toEqual(["c-2"]);
  });

  it("다른 계좌의 완료를 이 화면에 올리지 않는다", () => {
    seed(envelope({ completionId: "c-1", accountType: "irp" }));
    seed(envelope({ completionId: "c-isa", accountType: "isa" }));
    expect(listCompletions(ctx).pending.map((v) => v.completionId)).toEqual(["c-1"]);
  });

  it("flag OFF 면 outbox 를 읽지 않는다", () => {
    seed(envelope());
    store.removeItem(SESSION_TRACKING_LS_KEY);
    expect(listCompletions(ctx)).toEqual({ pending: [], settled: [] });
  });

  it("오래된 envelope 을 기간·건수로 걸러내지 않는다", () => {
    for (let i = 0; i < 25; i++) {
      seed(envelope({ completionId: `old-${i}`, createdAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    }
    expect(listCompletions(ctx).pending).toHaveLength(25);
  });
});

// ── 2. frozen payload 재시도 ────────────────────────────────────────────────

describe("retryCompletion — frozen payload 만, 같은 completionId 로", () => {
  it("envelope 의 payload 를 **그대로** 보낸다", async () => {
    seed(envelope());
    const f = fakeDeps();
    await retryCompletion(ctx, "c-1", f.deps);
    const h = f.calls.find((c) => c.side === "history")!;
    const p = f.calls.find((c) => c.side === "plan")!;
    expect(h.payload).toEqual(HISTORY_PAYLOAD);
    expect(h.accountType).toBe("irp"); // envelope 의 계좌 — 지금 화면의 계좌가 아니다
    expect(p.payload).toEqual(PLAN_PAYLOAD);
  });

  it("**수신 확인된 쪽은 다시 보내지 않는다**", async () => {
    seed(envelope({ historyPersistence: "confirmed" }));
    const f = fakeDeps();
    const r = await retryCompletion(ctx, "c-1", f.deps);
    expect(f.calls.map((c) => c.side)).toEqual(["plan"]);
    expect(r.kind === "done" && r.sent).toEqual(["plan"]);
  });

  it("양쪽이 이미 수신 확인이면 아무것도 보내지 않는다", async () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "confirmed" }));
    const f = fakeDeps();
    expect((await retryCompletion(ctx, "c-1", f.deps)).kind).toBe("nothing_to_do");
    expect(f.calls).toHaveLength(0);
  });

  it("ACK 면 confirmed 로 올라가고 payload·completionId 는 그대로다", async () => {
    seed(envelope());
    await retryCompletion(ctx, "c-1", fakeDeps().deps);
    const env = get();
    expect(env.historyPersistence).toBe("confirmed");
    expect(env.planPersistence).toBe("confirmed");
    expect(env.completionId).toBe("c-1");
    expect(env.historyEntryPayload).toEqual(HISTORY_PAYLOAD);
    expect(env.planPayload).toEqual(PLAN_PAYLOAD);
    expect(env.historyDetail).toBeUndefined();
    expect(env.planDetail).toBeUndefined();
  });

  it("재시도해도 envelope 은 1건이다 (중복 생성 없음)", async () => {
    seed(envelope());
    const f = fakeDeps({
      history: [{ kind: "unknown", reason: "timeout" }, { kind: "ack", outcome: "already_exists" }],
      plan: [{ kind: "unknown", reason: "timeout" }, { kind: "ack", outcome: "already_exists" }],
    });
    await retryCompletion(ctx, "c-1", f.deps);
    await retryCompletion(ctx, "c-1", f.deps);
    expect(Object.keys(readOutbox(ctx.familyCode, ctx.profile))).toEqual(["c-1"]);
    expect(get().historyPersistence).toBe("confirmed");
  });

  it("병합이 올린 revision 을 가드 표에 전한다", async () => {
    seed(envelope());
    const f = fakeDeps({ history: [{ kind: "ack", outcome: "created", revision: 12 }] });
    await retryCompletion(ctx, "c-1", f.deps);
    expect(f.revisions).toEqual([["irp", 12]]);
  });

  it("ACK 가 아니면 revision 을 전하지 않는다", async () => {
    seed(envelope());
    const f = fakeDeps({ history: [{ kind: "failed", error: "409" }] });
    await retryCompletion(ctx, "c-1", f.deps);
    expect(f.revisions).toEqual([]);
  });
});

describe("실패·미확인에서 envelope 을 보존한다", () => {
  it("거부(409/422)는 failed + 사유를 쪽별로 남기고 envelope 은 남는다", async () => {
    seed(envelope());
    const f = fakeDeps({
      history: [{ kind: "failed", error: "history_hash_mismatch" }],
      plan: [{ kind: "failed", error: "plan_hash_mismatch" }],
    });
    await retryCompletion(ctx, "c-1", f.deps);
    const env = get();
    expect(env).toBeDefined();
    expect(env.historyDetail).toEqual({ kind: "failed", message: "history_hash_mismatch" });
    expect(env.planDetail).toEqual({ kind: "failed", message: "plan_hash_mismatch" });
    expect(describeCompletion(env).history.status).toBe("rejected");
  });

  it("**네트워크 실패는 unverified 로 남는다** (미저장 확정이 아니다)", async () => {
    seed(envelope());
    const f = fakeDeps({
      history: [{ kind: "unknown", reason: "네트워크 오류: Failed to fetch" }],
      plan: [{ kind: "unknown", reason: "15000ms 안에 응답이 없었습니다" }],
    });
    const r = await retryCompletion(ctx, "c-1", f.deps);
    const view = r.kind === "done" ? r.view : null;
    expect(view!.history.status).toBe("unverified");
    expect(view!.plan.status).toBe("unverified");
    expect(view!.history.detail).toContain("네트워크");
    // **결과 불명은 확정 실패 횟수에 들지 않는다** — 양쪽 다 서버가 받았을 수 있다.
    expect(get().historyPersistence).toBe("unknown");
    expect(get().planPersistence).toBe("unknown");
    expect(get().attempts).toBe(0);
    expect(get().manualRetryRequired).toBe(false);
  });

  it("한쪽만 성공해도 다른 쪽 결과로 추론하지 않는다", async () => {
    seed(envelope());
    const f = fakeDeps({
      history: [{ kind: "ack", outcome: "created" }],
      plan: [{ kind: "failed", error: "422" }],
    });
    await retryCompletion(ctx, "c-1", f.deps);
    const env = get();
    expect(env.historyPersistence).toBe("confirmed");
    expect(env.planPersistence).toBe("failed");
    expect(describeCompletion(env).settled).toBe(false);
  });
});

// ── 3. 중복 클릭 / 3회 실패 ─────────────────────────────────────────────────

describe("중복 클릭 차단", () => {
  it("진행 중에 같은 완료를 다시 누르면 busy 이고 서버를 부르지 않는다", async () => {
    seed(envelope());
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const f = fakeDeps({ hold });

    const first = retryCompletion(ctx, "c-1", f.deps);
    expect(isCompletionBusy(ctx, "c-1")).toBe(true);
    const second = await retryCompletion(ctx, "c-1", f.deps);
    expect(second.kind).toBe("busy");
    expect(f.calls).toHaveLength(2); // 첫 호출의 history + plan 만

    release();
    await first;
    expect(isCompletionBusy(ctx, "c-1")).toBe(false);
  });

  it("끝나면 잠금이 풀린다 (예외가 나도)", async () => {
    seed(envelope());
    const deps: RecoveryDeps = {
      postHistory: async () => { throw new Error("boom"); },
      postPlan: async () => ({ kind: "ack", outcome: "created" }),
    };
    await expect(retryCompletion(ctx, "c-1", deps)).rejects.toThrow("boom");
    expect(isCompletionBusy(ctx, "c-1")).toBe(false);
  });

  it("완료 흐름이 잡은 잠금과 같은 잠금이다 (동시에 두 번 보내지 않는다)", async () => {
    seed(envelope());
    const release = acquireCompletionLock(ctx, "c-1")!;
    expect(release).toBeTypeOf("function");
    expect(acquireCompletionLock(ctx, "c-1")).toBeNull();
    const f = fakeDeps();
    expect((await retryCompletion(ctx, "c-1", f.deps)).kind).toBe("busy");
    expect(f.calls).toHaveLength(0);
    release();
  });

  it("다른 완료는 서로 막지 않는다", async () => {
    const a = acquireCompletionLock(ctx, "c-a")!;
    const b = acquireCompletionLock(ctx, "c-b");
    expect(b).not.toBeNull();
    a(); b!();
  });
});

describe("결과 불명은 3회 실패에 들지 않는다", () => {
  it("네트워크 장애·503 을 5번 반복해도 자동 동작이 멈추지 않는다", async () => {
    seed(envelope());
    for (let i = 0; i < MAX_AUTO_ATTEMPTS + 2; i++) {
      await retryCompletion(ctx, "c-1", fakeDeps({
        history: [{ kind: "unknown", reason: i % 2 ? "503" : "네트워크 오류" }],
        plan: [{ kind: "unknown", reason: "15000ms 안에 응답이 없었습니다" }],
      }).deps);
    }
    expect(get().attempts).toBe(0);
    expect(get().manualRetryRequired).toBe(false);
    expect(listCompletions(ctx).pending.map((v) => v.completionId)).toEqual(["c-1"]);
  });

  it("확정 실패만 센다 — 불명이 섞여도 실패 횟수는 그대로 쌓인다", async () => {
    seed(envelope());
    await retryCompletion(ctx, "c-1", fakeDeps({
      history: [{ kind: "failed", error: "404" }],
      plan: [{ kind: "unknown", reason: "timeout" }],
    }).deps);
    expect(get().attempts).toBe(1);
    await retryCompletion(ctx, "c-1", fakeDeps({
      history: [{ kind: "unknown", reason: "503" }],
      plan: [{ kind: "unknown", reason: "timeout" }],
    }).deps);
    expect(get().attempts).toBe(1); // 불명은 늘리지 않는다
  });

  it("표시도 구분된다 — 불명은 '저장 실패가 아닙니다'", async () => {
    seed(envelope());
    const r = await retryCompletion(ctx, "c-1", fakeDeps({
      history: [{ kind: "unknown", reason: "503" }],
      plan: [{ kind: "unknown", reason: "503" }],
    }).deps);
    const v = r.kind === "done" ? r.view : null;
    expect(v!.plan.label).toContain("저장 실패가 아닙니다");
    expect(v!.manualRetryRequired).toBe(false);
  });
});

describe("3회 실패 후에는 사용자가 눌러야만 움직인다", () => {
  it("연속 실패 3회면 manualRetryRequired 가 된다", async () => {
    seed(envelope());
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) {
      await retryCompletion(ctx, "c-1", fakeDeps({
        history: [{ kind: "failed", error: "404" }],
        plan: [{ kind: "ack", outcome: "created" }],
      }).deps);
    }
    expect(get().manualRetryRequired).toBe(true);
    expect(describeCompletion(get()).manualRetryRequired).toBe(true);
  });

  it("멈춘 envelope 은 **사용자가 누른 재시도에서만** 풀린다", async () => {
    seed(envelope({ attempts: 3, manualRetryRequired: true, historyPersistence: "failed",
      historyDetail: { kind: "failed", message: "404" } }));
    const f = fakeDeps();
    await retryCompletion(ctx, "c-1", f.deps);
    expect(get().manualRetryRequired).toBe(false);
    expect(get().historyPersistence).toBe("confirmed");
  });

  it("멈춘 상태를 읽기만 해서는 아무것도 보내지 않는다", () => {
    seed(envelope({ attempts: 3, manualRetryRequired: true }));
    const f = fakeDeps();
    listCompletions(ctx);
    describeCompletion(get());
    expect(f.calls).toHaveLength(0);
  });
});

// ── 4. journal 보호 / 정리 ──────────────────────────────────────────────────

const ALLOW = { allowed: true, reason: "" };
const DENY = { allowed: false, reason: "서버의 저장 버전(revision)을 확인하지 못했습니다." };

describe("정리 게이트 — 서버 보호가 검증되지 않으면 ACK 가 있어도 지우지 않는다", () => {
  const settled = () =>
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "confirmed" }));

  it("게이트를 안 넘기면 **거부**다 (기본값 fail-closed)", () => {
    settled();
    const r = dismissSettled(ctx, "c-1");
    expect(r).toEqual({ kind: "blocked", reason: DISMISS_DENIED_BY_DEFAULT.reason });
    expect(get()).toBeDefined();
  });

  it("게이트가 거부하면 양쪽 ACK 여도 frozen envelope 이 남는다", () => {
    settled();
    const r = dismissSettled(ctx, "c-1", DENY);
    expect(r).toEqual({ kind: "blocked", reason: DENY.reason });
    const env = get();
    expect(env.historyEntryPayload).toEqual(HISTORY_PAYLOAD);
    expect(env.planPayload).toEqual(PLAN_PAYLOAD);
  });

  it("거부된 정리는 journal 도 건드리지 않는다", () => {
    settled();
    writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, {
      schemaVersion: 1, phase: "completing", completionId: "c-1",
      snapshot: {
        sessionId: "s-1", accountType: "irp", accountInstanceId: "bai:unregistered:irp",
        startedAt: "2026-10-12T05:00:00.000Z", trigger: "quantity", preDateMode: "today",
        preQuantities: { r1: 1 }, preRowMeta: {}, preProfileKey: "growth",
      },
    });
    dismissSettled(ctx, "c-1", DENY);
    expect(readJournal(ctx.familyCode, ctx.profile, ctx.accountType)).not.toBeNull();
  });

  it("게이트가 허용해도 양쪽 수신 확인이 아니면 지우지 않는다", () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "unknown" }));
    expect(dismissSettled(ctx, "c-1", ALLOW)).toEqual({ kind: "kept", reason: "not_fully_confirmed" });
  });

  it("거부 판정이 busy 보다 먼저다 (사유를 숨기지 않는다)", () => {
    settled();
    const release = acquireCompletionLock(ctx, "c-1")!;
    expect(dismissSettled(ctx, "c-1", DENY).kind).toBe("blocked");
    release();
  });
});

describe("새 세션의 PRE journal 을 지우지 않는다", () => {
  /** 새 세션이 슬롯을 가져간 journal. completionId 가 없다(capturing). */
  const newSessionJournal = () => ({
    schemaVersion: 1,
    phase: "capturing" as const,
    snapshot: {
      sessionId: "s-new",
      accountType: "irp" as const,
      accountInstanceId: "bai:unregistered:irp",
      startedAt: "2026-10-13T00:00:00.000Z",
      trigger: "quantity" as const,
      preDateMode: "today" as const,
      preQuantities: { r1: 99 },
      preCash: 1,
      preRowMeta: {},
      preProfileKey: "growth",
    },
  });

  it("재시도는 journal 을 읽지도 쓰지도 않는다", async () => {
    seed(envelope());
    const j = newSessionJournal();
    writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, j);
    const before = store.getItem(journalKey(ctx.familyCode, ctx.profile, ctx.accountType));
    await retryCompletion(ctx, "c-1", fakeDeps().deps);
    expect(store.getItem(journalKey(ctx.familyCode, ctx.profile, ctx.accountType))).toBe(before);
  });

  it("정리해도 **다른 completionId 의 journal 은 남는다**", () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "confirmed" }));
    writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, newSessionJournal());
    const r = dismissSettled(ctx, "c-1", ALLOW);
    expect(r).toEqual({ kind: "cleaned", journalCleared: false });
    expect(readJournal(ctx.familyCode, ctx.profile, ctx.accountType)!.snapshot.preQuantities)
      .toEqual({ r1: 99 });
    expect(get()).toBeUndefined();
  });

  it("같은 completionId 의 journal 만 함께 정리된다", () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "confirmed" }));
    writeJournal(ctx.familyCode, ctx.profile, ctx.accountType,
      { ...newSessionJournal(), phase: "completing" as const, completionId: "c-1" });
    expect(dismissSettled(ctx, "c-1", ALLOW)).toEqual({ kind: "cleaned", journalCleared: true });
  });

  it("**수신 확인이 안 된 envelope 은 정리되지 않는다**", () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "failed" }));
    expect(dismissSettled(ctx, "c-1", ALLOW)).toEqual({ kind: "kept", reason: "not_fully_confirmed" });
    expect(get()).toBeDefined();
  });

  it("전송 중에는 정리하지 않는다", () => {
    seed(envelope({ historyPersistence: "confirmed", planPersistence: "confirmed" }));
    const release = acquireCompletionLock(ctx, "c-1")!;
    expect(dismissSettled(ctx, "c-1", ALLOW)).toEqual({ kind: "busy" });
    expect(get()).toBeDefined();
    release();
  });
});

describe("outbox 변경 알림", () => {
  it("구독자에게 알리고 해제할 수 있다", () => {
    let n = 0;
    const off = subscribeOutbox(() => { n += 1; });
    notifyOutboxChanged();
    off();
    notifyOutboxChanged();
    expect(n).toBe(1);
  });

  it("한 구독자의 오류가 나머지를 막지 않는다", () => {
    let ok = false;
    const a = subscribeOutbox(() => { throw new Error("x"); });
    const b = subscribeOutbox(() => { ok = true; });
    notifyOutboxChanged();
    a(); b();
    expect(ok).toBe(true);
  });
});

// ── 5. 자동 동작이 구조적으로 없다 ──────────────────────────────────────────

describe("자동 재시도·자동 삭제 경로가 없다 (소스 단위)", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
  /** 주석을 뺀 코드만 본다 — 헤더 주석이 금지 항목을 설명하느라 그 이름을 쓴다. */
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const recoverySrc = code(read("./completion-recovery.ts"));
  const panelSrc = code(read("../../components/kaw/CompletionRecoveryPanel.tsx"));

  it("복구 모듈에 타이머가 없다", () => {
    expect(recoverySrc).not.toMatch(/setInterval|setTimeout|requestIdleCallback/);
  });

  it("패널에 타이머·자동 호출이 없다", () => {
    expect(panelSrc).not.toMatch(/setInterval|setTimeout/);
    // retryCompletion 은 클릭 핸들러 함수 안에서만 불린다
    const uses = [...panelSrc.matchAll(/retryCompletion\(/g)];
    expect(uses).toHaveLength(1);
    const fnStart = panelSrc.indexOf("async function retry(");
    expect(uses[0].index!).toBeGreaterThan(fnStart);
    // useEffect 안에서 retry 를 부르지 않는다
    const effects = [...panelSrc.matchAll(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g)]
      .map((m) => m[0]).join("\n");
    expect(effects).not.toMatch(/retry\(|retryCompletion|dismiss/);
  });

  it("삭제는 사용자 확인(confirming) 뒤에만 도달한다", () => {
    const uses = [...panelSrc.matchAll(/dismiss\(v\)/g)];
    expect(uses).toHaveLength(1);
    expect(panelSrc.slice(0, uses[0].index!)).toContain("confirming === v.completionId");
    // 삭제 판정은 cleanupCompletion 하나로만 간다
    expect(recoverySrc).not.toContain("localStorage.removeItem");
    expect(recoverySrc).not.toContain("removeEnvelopeIfComplete");
  });

  it("정리 버튼은 보호가 검증되지 않으면 비활성화되고 사유를 보인다", () => {
    expect(panelSrc).toContain("getRevisionProtectionStatus()");
    expect(panelSrc).toContain("!protection.verified");
    expect(panelSrc).toMatch(/disabled>\s*정리 불가/);
    expect(panelSrc).toContain("{protection.reason}");
    // 눌렀을 때도 다시 판정해서 넘긴다 (렌더 뒤 상태 변화 대비)
    expect(panelSrc).toMatch(/dismissSettled\(ctx, v\.completionId, \{\s*allowed: protection\.verified/);
  });

  it("복구 모듈은 store·journal 쓰기·원장을 건드리지 않는다", () => {
    expect(recoverySrc).not.toMatch(/from "\.\/store"/);
    expect(recoverySrc).not.toContain("finalizeRebalance");
    expect(recoverySrc).not.toMatch(/writeJournal|clearJournal/);
    expect(recoverySrc).not.toMatch(/ledger|kaw_transaction/i);
    // payload 를 다시 만들지 않는다
    expect(recoverySrc).not.toMatch(/planPayloadHash\(|historyEntryHash\(|randomUUID|completionIds\(/);
  });

  it("patch 이 아니라 envelope 의 frozen payload 를 읽는다", () => {
    expect(recoverySrc).toContain("frozenHistoryPayload(current)");
    expect(recoverySrc).toContain("frozenPlanPayload(current)");
  });

  it("문구가 최종 보존·미저장 단정을 하지 않는다", () => {
    const text = panelSrc + recoverySrc;
    expect(text).not.toMatch(/저장되었습니다|저장 완료|보존되었|확정되었/);
    expect(text).toContain("저장되지 않았다는 뜻이");
  });
});
