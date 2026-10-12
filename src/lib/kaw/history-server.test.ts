/**
 * `POST /api/data/history` 핸들러를 **RPC 모델**에 대고 돌린다.
 *
 * `serviceClient` / `requireSession` 만 바꿔 끼운다(세션 서명·PIN 검증은 기존
 * /api/data 와 같은 경로라 여기서 다시 보지 않는다 — plan-server.test.ts 와 같은 선).
 * 가짜 클라이언트의 `rpc()` 는 **migration 006 의 함수를 TS 로 옮긴 모델**이다:
 * 행 잠금 → 읽기 → 같은 id 면 쓰지 않음 → 아니면 append 1회 + revision +1.
 *
 * 여기서 지키는 것:
 *   1. 정상 1건 → created, revision +1, **다른 기록·다른 키는 그대로**
 *   2. 같은 id + 같은 경제값(파생 필드만 다름) → 멱등 200, **쓰기 없음**
 *   3. 같은 id + 다른 경제값 → **409**
 *   4. 동시 요청 → 두 기록이 **둘 다** 남는다 (잠금이 없으면 하나가 사라진다)
 *   5. 계좌 문서가 없으면 **만들지 않고** 404
 *   6. 핸들러는 kaw_data 를 직접 읽거나 쓰지 않는다 (병합은 전부 RPC 안이다)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { historyEntryHash, type HistoryEntryInput } from "./history-merge";

// ── 가짜 Supabase ───────────────────────────────────────────────────────────

interface Row { data: Record<string, unknown>; revision: number }

/** family_code|profile|account_type → 행 */
const db = new Map<string, Row>();
const audit: Array<Record<string, unknown>> = [];
/** 잠금 없는 모델로 돌릴 수 있게 해 둔다 — 4번 테스트가 "잠금이 하는 일"을 보여준다 */
let useLock = true;
/** 읽기와 쓰기 사이에 끼우는 await. 실제 DB 의 왕복 지연 자리다 */
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

const key = (f: string, p: string, a: string) => `${f}|${p}|${a}`;
const locks = new Map<string, Promise<unknown>>();

/** 같은 키의 호출을 직렬화한다 (= `select ... for update`) */
async function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  if (!useLock) return fn();
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(k, next.catch(() => {}));
  return next;
}

/** migration 006 `kaw_data_merge_history` 의 모델. */
async function mergeHistoryRpc(params: {
  p_family_code: string; p_profile: string; p_account_type: string;
  p_entry: Record<string, unknown>;
}): Promise<{ data: unknown; error: null } | { data: null; error: { code?: string; message: string } }> {
  const k = key(params.p_family_code, params.p_profile, params.p_account_type);
  const entry = params.p_entry;
  const id = entry.id;
  const date = String(entry.date ?? "");
  if (typeof id !== "string" || !id) {
    return { data: null, error: { code: "22023", message: "entry.id 가 필요합니다" } };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { data: null, error: { code: "22023", message: "entry.date 는 YYYY-MM-DD 여야 합니다" } };
  }

  return withLock(k, async () => {
    const row = db.get(k);
    if (!row) return { data: { outcome: "account_row_missing" }, error: null };

    const history = Array.isArray(row.data.history)
      ? (row.data.history as Array<Record<string, unknown>>)
      : [];
    await yieldTick(); // 읽기 → 쓰기 사이의 틈

    const existing = history.find((e) => e?.id === id);
    if (existing) {
      return {
        data: {
          outcome: "already_exists", revision: row.revision,
          history_count: history.length, entry: existing,
        },
        error: null,
      };
    }

    const stale = history
      .map((e, ord) => ({ id: e?.id, date: String(e?.date ?? ""), ord }))
      .filter((e) => e.date > date)
      .sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord)
      .slice(0, 1)
      .map((e) => e.id);

    // history 키 하나만 바꾼다 (jsonb_set) — 문서를 재구성하지 않는다
    row.data = { ...row.data, history: [...history, entry] };
    row.revision += 1;
    return {
      data: {
        outcome: "created", revision: row.revision,
        history_count: history.length + 1, stale_return_pct_ids: stale,
      },
      error: null,
    };
  });
}

const fakeClient = {
  rpc: (name: string, params: Record<string, unknown>) => {
    if (name !== "kaw_data_merge_history") {
      return Promise.resolve({ data: null, error: { code: "42883", message: `${name} 없음` } });
    }
    return mergeHistoryRpc(params as Parameters<typeof mergeHistoryRpc>[0]);
  },
  from: (table: string) => ({
    insert: (row: Record<string, unknown>) => {
      if (table === "kaw_ledger_audit") audit.push(row);
      else throw new Error(`핸들러가 ${table} 에 직접 insert 했다`);
      return Promise.resolve({ error: null });
    },
  }),
};

const session = { code: "soye", profile: "hyeobi", exp: 0, v: 0 };

vi.mock("./data-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data-server")>();
  return {
    ...actual,
    serviceClient: () => fakeClient,
    requireSession: async () => session,
  };
});

const { handleHistoryMergePost } = await import("./history-server");

const env = { SESSION_SECRET: "s", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" };

// ── 입력 만들기 ─────────────────────────────────────────────────────────────

const entry = (over: Partial<HistoryEntryInput> = {}): HistoryEntryInput => ({
  id: "hist:c-0001",
  date: "2026-10-12",
  baseAmount: 1_003_621,
  totalValue: 1_010_000,
  deposit: 688_074,
  cashBalance: 3_621,
  returnPct: 1.23,
  rowQuantitiesSnap: { kr: 14 },
  rowHoldingsSnap: { kr: 500_000 },
  rowEtfSnap: { kr: "TIGER 200" },
  ...over,
});

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleHistoryMergePost(
    new Request("https://x/api/data/history", { method: "POST", body: JSON.stringify(body) }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const K = key("soye", "hyeobi", "isa");

/** 기존 데이터가 들어 있는 계좌 문서. 병합이 **지우지 않아야 하는 것들**이 섞여 있다. */
function seedAccountRow() {
  db.set(K, {
    revision: 0,
    data: {
      cashBalance: 3_621,
      deposit: 688_074,
      cashflows: [{ id: "cf-1", date: "2026-09-25", amount: 688_074, source: "schedule" }],
      contributionSchedule: [{ id: "sch-1", amount: 688_074 }],
      history: [
        { id: "hist:old", date: "2026-09-01", baseAmount: 1, totalValue: 2, deposit: 0, returnPct: null },
      ],
    },
  });
}

beforeEach(() => {
  db.clear();
  audit.length = 0;
  locks.clear();
  useLock = true;
  seedAccountRow();
});
afterEach(() => vi.restoreAllMocks());

const historyOf = () => (db.get(K)!.data.history as Array<Record<string, unknown>>);

// ── 1. 정상 ─────────────────────────────────────────────────────────────────

describe("정상 병합", () => {
  it("created 를 돌려주고 revision 이 1 올라간다", async () => {
    const r = await post({ accountType: "isa", entry: entry() });
    expect(r.status).toBe(200);
    expect(r.json.outcome).toBe("created");
    expect(r.json.revision).toBe(1);
    expect(r.json.historyCount).toBe(2);
    expect(r.json.entryHash).toBe(historyEntryHash(entry()));
    expect(db.get(K)!.revision).toBe(1);
  });

  it("**기존 기록과 다른 키를 보존한다**", async () => {
    await post({ accountType: "isa", entry: entry() });
    const data = db.get(K)!.data;
    expect(historyOf().map((e) => e.id)).toEqual(["hist:old", "hist:c-0001"]);
    expect(data.cashflows).toEqual([
      { id: "cf-1", date: "2026-09-25", amount: 688_074, source: "schedule" },
    ]);
    expect(data.contributionSchedule).toEqual([{ id: "sch-1", amount: 688_074 }]);
    expect(data.cashBalance).toBe(3_621);
    expect(data.deposit).toBe(688_074);
  });

  it("파생 필드를 그대로 저장한다 (해시에서만 빠진다)", async () => {
    const bt = { totalValue: 9, returnPct: 1, schemaVersion: 6, cashflowKey: "cfk" };
    await post({ accountType: "isa", entry: entry({ returnPct: 1.23, backtestGrowth: bt }) });
    const saved = historyOf()[1];
    expect(saved.returnPct).toBe(1.23);
    expect(saved.backtestGrowth).toEqual(bt);
  });

  it("audit 1건을 남긴다 (기록 본문은 넣지 않는다)", async () => {
    await post({ accountType: "isa", entry: entry() });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      family_code: "soye", profile: "hyeobi", actor: "hyeobi",
      action: "history_merge", target_type: "history", target_id: "hist:c-0001",
    });
    const value = audit[0].new_value as Record<string, unknown>;
    expect(value).toMatchObject({ outcome: "created", accountType: "isa", revision: 1 });
    expect(value).not.toHaveProperty("rowQuantitiesSnap");
    expect(value).not.toHaveProperty("totalValue");
  });

  it("과거 날짜를 끼워 넣으면 **체인이 낡은 기록의 id** 를 돌려준다", async () => {
    const r = await post({ accountType: "isa", entry: entry({ date: "2026-08-01" }) });
    expect(r.json.staleReturnPctIds).toEqual(["hist:old"]);
    // 고쳐 주지는 않는다 — returnPct 의 정의는 store.ts 한 곳뿐이다
    expect(historyOf()[0].returnPct).toBeNull();
  });

  it("최신 날짜면 낡는 기록이 없다", async () => {
    const r = await post({ accountType: "isa", entry: entry() });
    expect(r.json.staleReturnPctIds).toEqual([]);
  });
});

// ── 2. 멱등 ─────────────────────────────────────────────────────────────────

describe("중복 전송 (멱등)", () => {
  it("같은 본문 재전송은 200 already_exists 이고 기록이 늘지 않는다", async () => {
    await post({ accountType: "isa", entry: entry() });
    const r = await post({ accountType: "isa", entry: entry() });
    expect(r.status).toBe(200);
    expect(r.json.outcome).toBe("already_exists");
    expect(historyOf()).toHaveLength(2);
    expect(db.get(K)!.revision).toBe(1); // 쓰기가 없었다
  });

  it("**파생 필드만 다른 재전송도 멱등이다** (재계산된 returnPct / 백테스트)", async () => {
    await post({ accountType: "isa", entry: entry({ returnPct: 1.23 }) });
    const r = await post({
      accountType: "isa",
      entry: entry({ returnPct: 7.77, backtestGrowth: { schemaVersion: 7 } }),
    });
    expect(r.json.outcome).toBe("already_exists");
    expect(historyOf()).toHaveLength(2);
    // 먼저 저장된 값을 덮어쓰지 않는다
    expect(historyOf()[1].returnPct).toBe(1.23);
  });

  it("세 번 보내도 1건이다", async () => {
    for (let i = 0; i < 3; i++) await post({ accountType: "isa", entry: entry() });
    expect(historyOf().filter((e) => e.id === "hist:c-0001")).toHaveLength(1);
  });
});

// ── 3. 충돌 ─────────────────────────────────────────────────────────────────

describe("같은 id + 다른 경제값", () => {
  it("409 이고 저장된 기록을 바꾸지 않는다", async () => {
    await post({ accountType: "isa", entry: entry() });
    const r = await post({ accountType: "isa", entry: entry({ totalValue: 2_000_000 }) });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("history_hash_mismatch");
    expect(r.json.storedHash).toBe(historyEntryHash(entry()));
    expect(r.json.incomingHash).toBe(historyEntryHash(entry({ totalValue: 2_000_000 })));
    expect(historyOf()[1].totalValue).toBe(1_010_000);
    expect(db.get(K)!.revision).toBe(1);
  });

  it("409 는 audit 을 남기지 않는다 (일어난 일이 없다)", async () => {
    await post({ accountType: "isa", entry: entry() });
    audit.length = 0;
    await post({ accountType: "isa", entry: entry({ deposit: 0 }) });
    expect(audit).toHaveLength(0);
  });
});

// ── 4. 동시 요청 ────────────────────────────────────────────────────────────

describe("동시 요청", () => {
  it("서로 다른 기록 2건이 동시에 와도 **둘 다 남는다**", async () => {
    const [a, b] = await Promise.all([
      post({ accountType: "isa", entry: entry({ id: "hist:c-A", date: "2026-10-12" }) }),
      post({ accountType: "isa", entry: entry({ id: "hist:c-B", date: "2026-10-13" }) }),
    ]);
    expect(a.json.outcome).toBe("created");
    expect(b.json.outcome).toBe("created");
    expect(historyOf().map((e) => e.id).sort()).toEqual(["hist:c-A", "hist:c-B", "hist:old"]);
    expect(db.get(K)!.revision).toBe(2);
  });

  it("같은 기록을 동시에 두 번 보내도 1건이다", async () => {
    const [a, b] = await Promise.all([
      post({ accountType: "isa", entry: entry() }),
      post({ accountType: "isa", entry: entry() }),
    ]);
    const outcomes = [a.json.outcome, b.json.outcome].sort();
    expect(outcomes).toEqual(["already_exists", "created"]);
    expect(historyOf()).toHaveLength(2);
    expect(db.get(K)!.revision).toBe(1);
  });

  it("**잠금이 없으면 하나가 사라진다** — 이 테스트가 `for update` 의 존재 이유다", async () => {
    useLock = false;
    await Promise.all([
      post({ accountType: "isa", entry: entry({ id: "hist:c-A" }) }),
      post({ accountType: "isa", entry: entry({ id: "hist:c-B" }) }),
    ]);
    expect(historyOf()).toHaveLength(2); // old + 한쪽만
  });

  it("다섯 건을 동시에 보내도 전부 남는다", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    await Promise.all(
      ids.map((s) => post({ accountType: "isa", entry: entry({ id: `hist:${s}` }) })),
    );
    expect(historyOf()).toHaveLength(1 + ids.length);
    expect(db.get(K)!.revision).toBe(ids.length);
  });
});

// ── 5. 계좌 문서 없음 / 저장소 없음 ─────────────────────────────────────────

describe("경계", () => {
  it("계좌 문서가 없으면 404 이고 만들지 않는다", async () => {
    db.clear();
    const r = await post({ accountType: "isa", entry: entry() });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("account_row_missing");
    expect(db.size).toBe(0);
  });

  it("다른 계좌의 문서를 건드리지 않는다", async () => {
    db.set(key("soye", "hyeobi", "irp"), { revision: 0, data: { history: [] } });
    await post({ accountType: "isa", entry: entry() });
    expect(db.get(key("soye", "hyeobi", "irp"))!.data.history).toEqual([]);
  });

  it("본문 검증 실패는 400 이고 RPC 까지 가지 않는다", async () => {
    const r = await post({ accountType: "isa", entry: { ...entry(), date: "어제" } });
    expect(r.status).toBe(400);
    expect(historyOf()).toHaveLength(1);
  });

  it("세션의 family_code / profile 만 쓴다 (본문 값은 버린다)", async () => {
    await post({
      accountType: "isa", entry: entry(),
      family_code: "침입자", profile: "다른사람", actor: "누군가",
    });
    expect(historyOf()).toHaveLength(2);
    expect(audit[0]).toMatchObject({ family_code: "soye", profile: "hyeobi", actor: "hyeobi" });
  });

  it("migration 006 미적용(42883)은 503 unavailable 이다", async () => {
    const spy = vi.spyOn(fakeClient, "rpc").mockResolvedValue({
      data: null, error: { code: "42883", message: "function does not exist" },
    } as never);
    const r = await post({ accountType: "isa", entry: entry() });
    expect(r.status).toBe(503);
    expect(r.json.unavailable).toBe(true);
    spy.mockRestore();
  });

  it("알 수 없는 반환값을 성공으로 읽지 않는다", async () => {
    const spy = vi.spyOn(fakeClient, "rpc").mockResolvedValue({
      data: { outcome: "merged?" }, error: null,
    } as never);
    expect((await post({ accountType: "isa", entry: entry() })).status).toBe(500);
    spy.mockRestore();
  });
});

// ── 6. 파일 단위 불변식 ─────────────────────────────────────────────────────

describe("핸들러는 kaw_data 를 직접 다루지 않는다", () => {
  const SRC = readFileSync(fileURLToPath(new URL("./history-server.ts", import.meta.url)), "utf-8");

  it("kaw_data 를 select/upsert 하는 코드가 없다 (병합은 전부 RPC 안이다)", () => {
    // 애플리케이션 레벨 read-modify-write 가 생기면 동시 요청에서 기록이 사라진다.
    expect(SRC).not.toMatch(/from\(\s*["']kaw_data["']\s*\)/);
    expect(SRC).not.toMatch(/\.upsert\(/);
  });

  it("audit 외에는 테이블에 직접 쓰지 않는다", () => {
    const tables = [...SRC.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(["kaw_ledger_audit"]);
  });
});
