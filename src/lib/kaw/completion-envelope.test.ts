/**
 * Completion envelope — 멱등성과 부분 실패 복구.
 *
 * 고정하는 불변식 세 개:
 *   1. `confirmed` 는 **서버 ACK 로만** 올라간다 (현재 dbSave 는 ACK 를 만들 수 없다)
 *   2. envelope 삭제는 plan + history **양쪽 confirmed** 이후에만 가능하다
 *   3. 복구는 frozen payload 재적용뿐 — plan↔history 상호 추론 경로가 없다
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMPLETION_SCHEMA_VERSION,
  MAX_AUTO_ATTEMPTS,
  canDeleteEnvelope,
  completionDisplayState,
  completionIdOf,
  completionIds,
  confirmHistoryPersistence,
  confirmPlanPersistence,
  markHistoryFailed,
  markHistoryUnknown,
  markPlanFailed,
  nextRecoveryActions,
  outboxKey,
  parseEnvelope,
  pendingEnvelopes,
  putEnvelope,
  readOutbox,
  removeEnvelopeIfComplete,
  resetForManualRetry,
  type CompletionEnvelope,
  type ServerPersistenceAck,
} from "./completion-envelope";

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
});
afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = original;
});

const ack: ServerPersistenceAck = { kind: "server_ack", outcome: "created", at: "2026-10-02T02:30:01.000Z" };

const env = (over: Partial<CompletionEnvelope> = {}): CompletionEnvelope => ({
  schemaVersion: COMPLETION_SCHEMA_VERSION,
  completionId: "cpl:1",
  sessionId: "rbs:1",
  accountType: "irp",
  accountInstanceId: "bai:A",
  createdAt: "2026-10-02T02:30:00.000Z",
  historyEntryPayload: { entry: { id: "hist:cpl:1" }, cashBalance: 2_352 },
  planPayload: { id: "plan:cpl:1" },
  historyPersistence: "pending",
  planPersistence: "pending",
  attempts: 0,
  manualRetryRequired: false,
  ...over,
});

// ── identity ──────────────────────────────────────────────────────────────

describe("completionId 가 완료 1회의 유일한 identity 다", () => {
  it("history / plan id 가 결정적으로 파생된다", () => {
    expect(completionIds("cpl:abc")).toEqual({
      historyEntryId: "hist:cpl:abc",
      planId: "plan:cpl:abc",
    });
    // 몇 번 불러도 같다 = 재시도가 멱등하다.
    expect(completionIds("cpl:abc")).toEqual(completionIds("cpl:abc"));
  });

  it("양쪽 id 에서 completionId 를 되읽을 수 있다", () => {
    expect(completionIdOf("hist:cpl:abc")).toBe("cpl:abc");
    expect(completionIdOf("plan:cpl:abc")).toBe("cpl:abc");
    expect(completionIdOf("something-else")).toBeNull();
  });
});

// ── 영속 상태 전이 ────────────────────────────────────────────────────────

describe("confirmed 는 서버 ACK 로만 올라간다", () => {
  it("plan ACK 로 confirmed", () => {
    expect(confirmPlanPersistence(env(), ack).planPersistence).toBe("confirmed");
  });

  it("PK 충돌(already_exists)도 ACK 다 — 재시도가 성공으로 수렴한다", () => {
    const e = confirmPlanPersistence(env(), { ...ack, outcome: "already_exists" });
    expect(e.planPersistence).toBe("confirmed");
  });

  it("history 는 ACK 가 있을 때만 confirmed", () => {
    expect(confirmHistoryPersistence(env(), { ...ack, outcome: "written" }).historyPersistence).toBe(
      "confirmed",
    );
  });

  it("현재 dbSave 경로는 unknown 이고 confirmed 가 아니다", () => {
    const e = markHistoryUnknown(env());
    expect(e.historyPersistence).toBe("unknown");
    expect(canDeleteEnvelope(e)).toBe(false);
  });

  it("전이는 새 객체를 돌려주고 입력을 변형하지 않는다", () => {
    const before = env();
    confirmPlanPersistence(before, ack);
    expect(before.planPersistence).toBe("pending");
  });
});

describe("실패와 재시도 상한 (R3)", () => {
  it("실패마다 attempts 가 오르고 상한에서 수동 전환된다", () => {
    let e = env();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) e = markPlanFailed(e, "500");
    expect(e.attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(e.manualRetryRequired).toBe(true);
    expect(nextRecoveryActions(e)).toEqual(["await_manual_retry"]);
  });

  it("history 실패도 같은 카운터를 쓴다", () => {
    const e = markHistoryFailed(env(), "network");
    expect(e.historyPersistence).toBe("failed");
    expect(e.attempts).toBe(1);
  });

  it("수동 재시도는 카운터를 리셋한다", () => {
    let e = env();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) e = markPlanFailed(e, "500");
    e = resetForManualRetry(e);
    expect(e.attempts).toBe(0);
    expect(e.manualRetryRequired).toBe(false);
    expect(e.lastError).toBeUndefined();
  });
});

// ── 삭제 / 복구 판정 ─────────────────────────────────────────────────────

describe("envelope 삭제는 양쪽 confirmed 이후에만", () => {
  it("둘 다 confirmed 여야 true", () => {
    const both = confirmHistoryPersistence(confirmPlanPersistence(env(), ack), ack);
    expect(canDeleteEnvelope(both)).toBe(true);
  });

  it("plan 만 confirmed 면 삭제 불가", () => {
    expect(canDeleteEnvelope(confirmPlanPersistence(env(), ack))).toBe(false);
  });

  it("history 가 unknown 이면 삭제 불가 — ghost 를 만드는 유일한 경로다", () => {
    const e = markHistoryUnknown(confirmPlanPersistence(env(), ack));
    expect(canDeleteEnvelope(e)).toBe(false);
  });
});

describe("부분 실패 4가지 경로의 복구 동작", () => {
  it("A. 둘 다 미확정 → 양쪽 재시도", () => {
    expect(nextRecoveryActions(env()).sort()).toEqual(["retry_history_write", "retry_plan_post"]);
  });

  it("B. history 영속 / plan 실패 → plan 만 재시도", () => {
    const e = markPlanFailed(confirmHistoryPersistence(env(), ack), "500");
    expect(nextRecoveryActions(e)).toEqual(["retry_plan_post"]);
  });

  it("C. plan 영속 / history 미확정 → history 만 재시도", () => {
    const e = markHistoryUnknown(confirmPlanPersistence(env(), ack));
    expect(nextRecoveryActions(e)).toEqual(["retry_history_write"]);
  });

  it("D. 둘 다 확정 → 삭제", () => {
    const both = confirmHistoryPersistence(confirmPlanPersistence(env(), ack), ack);
    expect(nextRecoveryActions(both)).toEqual(["delete_envelope"]);
  });
});

describe("표시 상태 — 성공 toast 는 all_confirmed 에서만 (R5)", () => {
  it("상태별 라벨", () => {
    const both = confirmHistoryPersistence(confirmPlanPersistence(env(), ack), ack);
    expect(completionDisplayState(both)).toBe("all_confirmed");
    expect(completionDisplayState(env())).toBe("in_flight");
    expect(completionDisplayState(markPlanFailed(env(), "500"))).toBe("plan_failed");
    expect(completionDisplayState(markHistoryUnknown(confirmPlanPersistence(env(), ack)))).toBe(
      "history_unconfirmed",
    );
    let e = env();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) e = markPlanFailed(e, "500");
    expect(completionDisplayState(e)).toBe("manual_retry_required");
  });
});

// ── outbox I/O ───────────────────────────────────────────────────────────

describe("outbox 는 StoreState 밖 전용 키를 쓴다", () => {
  it("키 모양", () => {
    expect(outboxKey("soye", "hyeobi")).toBe("kaw-completion-outbox:soye:hyeobi");
  });

  it("같은 completionId 를 다시 넣어도 1건이다", () => {
    putEnvelope("soye", "hyeobi", env());
    putEnvelope("soye", "hyeobi", env({ attempts: 2 }));
    const outbox = readOutbox("soye", "hyeobi");
    expect(Object.keys(outbox)).toEqual(["cpl:1"]);
    expect(outbox["cpl:1"].attempts).toBe(2);
  });

  it("확정되지 않은 envelope 은 삭제되지 않는다", () => {
    putEnvelope("soye", "hyeobi", env());
    expect(removeEnvelopeIfComplete("soye", "hyeobi", "cpl:1")).toEqual({
      removed: false,
      reason: "not_fully_confirmed",
    });
    expect(Object.keys(readOutbox("soye", "hyeobi"))).toEqual(["cpl:1"]);
  });

  it("양쪽 확정이면 삭제된다", () => {
    putEnvelope("soye", "hyeobi", confirmHistoryPersistence(confirmPlanPersistence(env(), ack), ack));
    expect(removeEnvelopeIfComplete("soye", "hyeobi", "cpl:1")).toEqual({ removed: true });
    expect(readOutbox("soye", "hyeobi")).toEqual({});
  });

  it("없는 envelope 삭제는 not_found", () => {
    expect(removeEnvelopeIfComplete("soye", "hyeobi", "cpl:none").reason).toBe("not_found");
  });

  it("모양이 어긋난 envelope / 키 불일치는 읽을 때 버린다", () => {
    expect(parseEnvelope({ ...env(), schemaVersion: 99 })).toBeNull();
    expect(parseEnvelope({ ...env(), historyPersistence: "weird" })).toBeNull();
    expect(parseEnvelope({ ...env(), manualRetryRequired: "yes" })).toBeNull();
    store.setItem(outboxKey("soye", "hyeobi"), JSON.stringify({ "cpl:other": env() }));
    expect(readOutbox("soye", "hyeobi")).toEqual({});
  });

  it("복구 대상은 생성순으로 나온다", () => {
    putEnvelope("soye", "hyeobi", env({ completionId: "cpl:2", createdAt: "2026-10-03T00:00:00.000Z" }));
    putEnvelope("soye", "hyeobi", env({ completionId: "cpl:1", createdAt: "2026-10-02T00:00:00.000Z" }));
    expect(pendingEnvelopes(readOutbox("soye", "hyeobi")).map((e) => e.completionId)).toEqual([
      "cpl:1",
      "cpl:2",
    ]);
  });
});

// ── 불변식: 상호 추론 금지 ───────────────────────────────────────────────

describe("plan 과 history 를 서로 추론하지 않는다", () => {
  it("envelope 은 양쪽 payload 를 **따로** 들고 있다", () => {
    const e = env();
    expect(e.historyEntryPayload).toBeDefined();
    expect(e.planPayload).toBeDefined();
    expect(e.historyEntryPayload).not.toBe(e.planPayload);
  });

  it("모듈 소스에 plan→history / history→plan 재구성 경로가 없다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/completion-envelope.ts"), "utf-8");
    expect(src).not.toMatch(/reconstruct|deriveHistory|derivePlan|fromPlan|fromHistory/i);
    // 어느 한쪽 payload 를 다른 쪽에 **대입**하는 코드가 없어야 한다
    // (=== 비교는 허용 — parseEnvelope 가 둘의 존재를 확인한다).
    expect(src).not.toMatch(/planPayload[^\n]*historyEntryPayload\s*=(?!=)/);
    expect(src).not.toMatch(/historyEntryPayload[^\n]*planPayload\s*=(?!=)/);
    expect(src).not.toMatch(/historyEntryPayload:\s*(?:env\.)?planPayload/);
    expect(src).not.toMatch(/planPayload:\s*(?:env\.)?historyEntryPayload/);
  });

  it("history 영속을 fire-and-forget 으로 confirmed 로 올리는 함수가 없다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/completion-envelope.ts"), "utf-8");
    // confirmed 로 올리는 두 함수는 모두 ServerPersistenceAck 를 받는다.
    const setters = src.match(/historyPersistence:\s*"confirmed"/g) ?? [];
    expect(setters.length).toBe(1);
    expect(src).toMatch(/export function confirmHistoryPersistence\(\s*env: CompletionEnvelope,\s*ack: ServerPersistenceAck,/);
  });
});
