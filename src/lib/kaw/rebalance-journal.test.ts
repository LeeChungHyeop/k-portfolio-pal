/**
 * 세션 journal — polling clobber 복구와 **ghost session 차단**.
 *
 * 두 방향의 사고를 모두 막아야 한다:
 *   · dbSave 실패 후 폴링이 mirror 를 지워 PRE 가 사라지는 것 (journal 이 복구한다)
 *   · plan 은 저장됐는데 stale mirror 가 끝난 세션을 되살리는 것 (복원 금지)
 *
 * vitest 환경이 node 라 localStorage 가 없다. 테스트 안에서 최소 스텁을 심는다
 * (설정 파일은 건드리지 않는다).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  JOURNAL_SCHEMA_VERSION,
  clearJournal,
  decideSessionHydration,
  journalKey,
  parseJournalEntry,
  readJournal,
  writeJournal,
  type RebalanceJournalEntry,
  type RebalanceSessionMirror,
} from "./rebalance-journal";
import type { RebalanceSessionSnapshot } from "./rebalance-plan";

// ── localStorage 스텁 ──────────────────────────────────────────────────────

class MemStorage implements Storage {
  private map = new Map<string, string>();
  /** true 면 setItem 이 throw 한다 (사파리 프라이베이트 모드 모사) */
  throwOnWrite = false;
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.set(k, v);
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

// ── fixture ────────────────────────────────────────────────────────────────

const snapshot = (over: Partial<RebalanceSessionSnapshot> = {}): RebalanceSessionSnapshot => ({
  sessionId: "rbs:1",
  accountType: "irp",
  accountInstanceId: "bai:A",
  startedAt: "2026-10-02T02:19:20.000Z",
  trigger: "quantity",
  preDateMode: "today",
  preQuantities: { r1: 67 },
  preCash: 262_937,
  preRowMeta: {
    r1: { assetId: "us", etfName: "TIGER 미국S&P500", label: "미국주식", ticker: "360750", orphaned: false },
  },
  preProfileKey: "growth",
  ...over,
});

const entry = (over: Partial<RebalanceJournalEntry> = {}): RebalanceJournalEntry => ({
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  phase: "capturing",
  snapshot: snapshot(),
  ...over,
});

const mirror = (over: Partial<RebalanceSessionMirror> = {}): RebalanceSessionMirror => ({
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  phase: "capturing",
  snapshot: snapshot(),
  ...over,
});

// ── I/O ───────────────────────────────────────────────────────────────────

describe("journal I/O", () => {
  it("계좌별 전용 키를 쓴다 (StoreState 밖)", () => {
    expect(journalKey("soye", "hyeobi", "irp")).toBe("kaw-rebalance-journal:soye:hyeobi:irp");
  });

  it("쓰고 읽으면 같은 snapshot 이 나온다", () => {
    expect(writeJournal("soye", "hyeobi", "irp", entry())).toBe(true);
    expect(readJournal("soye", "hyeobi", "irp")?.snapshot.preQuantities).toEqual({ r1: 67 });
  });

  it("계좌가 다르면 서로 간섭하지 않는다", () => {
    writeJournal("soye", "hyeobi", "irp", entry());
    expect(readJournal("soye", "hyeobi", "pension")).toBeNull();
  });

  it("localStorage 가 throw 해도 예외를 흘리지 않고 false 로 degrade 한다", () => {
    store.throwOnWrite = true;
    expect(() => writeJournal("soye", "hyeobi", "irp", entry())).not.toThrow();
    expect(writeJournal("soye", "hyeobi", "irp", entry())).toBe(false);
  });

  it("localStorage 가 아예 없어도 읽기가 null 로 degrade 한다", () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(readJournal("soye", "hyeobi", "irp")).toBeNull();
    expect(writeJournal("soye", "hyeobi", "irp", entry())).toBe(false);
    expect(clearJournal("soye", "hyeobi", "irp")).toBe(false);
  });

  it("모양이 어긋난 journal 은 고쳐서 통과시키지 않고 버린다", () => {
    expect(parseJournalEntry(null)).toBeNull();
    expect(parseJournalEntry({ ...entry(), schemaVersion: 99 })).toBeNull();
    expect(parseJournalEntry({ ...entry(), phase: "weird" })).toBeNull();
    expect(parseJournalEntry({ ...entry(), snapshot: { ...snapshot(), sessionId: "" } })).toBeNull();
    expect(parseJournalEntry({ ...entry(), snapshot: { ...snapshot(), accountInstanceId: "" } })).toBeNull();
    expect(parseJournalEntry({ ...entry(), snapshot: { ...snapshot(), preDateMode: "nope" } })).toBeNull();
    // completing 인데 completionId 가 없으면 복구 수단이 없다 → 버린다
    expect(parseJournalEntry({ ...entry(), phase: "completing" })).toBeNull();
  });

  it("깨진 JSON 이 저장돼 있어도 null 로 degrade 한다", () => {
    store.setItem(journalKey("soye", "hyeobi", "irp"), "{not json");
    expect(readJournal("soye", "hyeobi", "irp")).toBeNull();
  });
});

// ── hydration 판정 ────────────────────────────────────────────────────────

describe("decideSessionHydration — polling clobber 복구", () => {
  it("journal 이 있으면 journal 을 정본으로 쓴다", () => {
    const d = decideSessionHydration({
      journal: entry(),
      mirror: mirror({ snapshot: snapshot({ sessionId: "rbs:other" }) }),
      durablePlanKnown: "unknown",
    });
    expect(d.kind).toBe("use_journal");
    if (d.kind === "use_journal") expect(d.entry.snapshot.sessionId).toBe("rbs:1");
  });

  it("mirror 가 폴링에 지워져도 journal 에서 세션이 유지된다", () => {
    const d = decideSessionHydration({ journal: entry(), mirror: null, durablePlanKnown: "unknown" });
    expect(d.kind).toBe("use_journal");
  });

  it("journal 이 없고 mirror 가 capturing 이면 복원한다 (다른 기기에서 시작한 세션)", () => {
    const d = decideSessionHydration({ journal: null, mirror: mirror(), durablePlanKnown: "unknown" });
    expect(d.kind).toBe("restore_from_mirror");
    if (d.kind === "restore_from_mirror") {
      expect(d.entry.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION);
      expect(d.entry.phase).toBe("capturing");
    }
  });

  it("둘 다 없으면 none", () => {
    expect(decideSessionHydration({ journal: null, mirror: null, durablePlanKnown: "unknown" })).toEqual({
      kind: "none",
    });
  });
});

describe("decideSessionHydration — ghost session 차단", () => {
  const completing = mirror({ phase: "completing", completionId: "cpl:1" });

  it("completing mirror + plan 존재 → **복원 금지**, 정리 대상", () => {
    const d = decideSessionHydration({ journal: null, mirror: completing, durablePlanKnown: "exists" });
    expect(d).toEqual({ kind: "stale_mirror_cleanup", completionId: "cpl:1" });
  });

  it("completing mirror + plan 없음 → 복원 (재시도가 필요하다)", () => {
    const d = decideSessionHydration({ journal: null, mirror: completing, durablePlanKnown: "missing" });
    expect(d.kind).toBe("restore_from_mirror");
    if (d.kind === "restore_from_mirror") expect(d.entry.completionId).toBe("cpl:1");
  });

  it("completing mirror + durability 모름 → 자동 복원하지 않고 recovery_pending", () => {
    const d = decideSessionHydration({ journal: null, mirror: completing, durablePlanKnown: "unknown" });
    expect(d).toEqual({ kind: "recovery_pending", completionId: "cpl:1" });
  });

  it("journal 이 completing 이고 plan 이 이미 있으면 journal 도 되살리지 않는다", () => {
    // journal 삭제가 실패해 남은 잔재도 같은 ghost 종류다.
    const d = decideSessionHydration({
      journal: entry({ phase: "completing", completionId: "cpl:1" }),
      mirror: null,
      durablePlanKnown: "exists",
    });
    expect(d).toEqual({ kind: "stale_mirror_cleanup", completionId: "cpl:1" });
  });

  it("journal 이 completing 이고 durability 를 모르면 진행한다 (재시도는 멱등)", () => {
    const d = decideSessionHydration({
      journal: entry({ phase: "completing", completionId: "cpl:1" }),
      mirror: null,
      durablePlanKnown: "unknown",
    });
    expect(d.kind).toBe("use_journal");
  });
});

describe("decideSessionHydration — instance 불일치", () => {
  it("계좌 instance 가 달라지면 세션을 쓰지 않는다", () => {
    const d = decideSessionHydration({
      journal: entry(),
      mirror: null,
      durablePlanKnown: "unknown",
      expectedAccountInstanceId: "bai:B",
    });
    expect(d).toEqual({
      kind: "discard_instance_mismatch",
      sessionInstanceId: "bai:A",
      expectedInstanceId: "bai:B",
    });
  });

  it("instance 가 같으면 정상 진행한다", () => {
    const d = decideSessionHydration({
      journal: entry(),
      mirror: null,
      durablePlanKnown: "unknown",
      expectedAccountInstanceId: "bai:A",
    });
    expect(d.kind).toBe("use_journal");
  });

  it("instance 불일치가 ghost 판정보다 먼저다 (세션 자체를 쓰지 않는다)", () => {
    const d = decideSessionHydration({
      journal: null,
      mirror: mirror({ phase: "completing", completionId: "cpl:1" }),
      durablePlanKnown: "exists",
      expectedAccountInstanceId: "bai:B",
    });
    expect(d.kind).toBe("discard_instance_mismatch");
  });
});
