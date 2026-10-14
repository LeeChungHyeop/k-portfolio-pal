/**
 * `/api/data` 의 **revision 가드 경로**를 RPC 모델에 대고 돌린다.
 *
 * 가짜 클라이언트의 `rpc()` 는 **migration 007 의 함수를 TS 로 옮긴 모델**이다:
 * 모양 검증 → 행 잠금 → 검사 전부 → (충돌이면 아무것도 쓰지 않고 반환) → 쓰기 전부.
 * 세션 서명·PIN 검증은 기존 경로라 여기서 다시 보지 않는다(plan-server.test.ts 와 같은 선).
 *
 * 여기서 지키는 것:
 *   1. **정상 저장** — revision 이 맞으면 저장되고 +1 된다. 응답으로 새 revision 을 준다
 *   2. **동시 수정** — 같은 revision 으로 둘이 저장하면 한쪽만 성공하고 다른 쪽은 409
 *   3. **부분 실패 금지** — 다섯 행 중 하나만 어긋나도 **전부** 쓰이지 않는다
 *   4. **구버전 요청** — expectedRevisions 가 없으면 기존 무가드 upsert 로 동작한다
 *   5. **파괴적 저장** — history 축소 / 키 유실은 사용자 확인 없이는 409
 *   6. `_shared` 는 가드 밖이지만, 충돌 시에는 **그것도 쓰이지 않는다**
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 가짜 Supabase ───────────────────────────────────────────────────────────

interface Row { data: Record<string, unknown>; revision: number }
const db = new Map<string, Row>();
const key = (f: string, p: string, a: string) => `${f}|${p}|${a}`;
const locks = new Map<string, Promise<unknown>>();
let useLock = true;
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

async function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  if (!useLock) return fn();
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(k, next.catch(() => {}));
  return next;
}

const GUARDABLE = ["_meta", "retirement", "isa", "pension", "irp"];

type RpcRow = { account_type: string; data: Record<string, unknown>; expected_revision: number | null };
type RpcErr = { data: null; error: { code?: string; message: string } };
type RpcOk = { data: unknown; error: null };

/** migration 007 `kaw_data_save_guarded` 의 모델. */
async function saveGuardedRpc(p: {
  p_family_code: string; p_profile: string; p_rows: RpcRow[];
  p_allow_history_shrink?: boolean; p_allow_key_loss?: boolean;
}): Promise<RpcOk | RpcErr> {
  const bad = (message: string): RpcErr => ({ data: null, error: { code: "22023", message } });
  if (!p.p_family_code || !p.p_profile) return bad("계좌 키가 필요합니다");
  if (p.p_profile.startsWith("_")) return bad(`예약 프로필(${p.p_profile})`);
  if (!Array.isArray(p.p_rows) || !p.p_rows.length) return bad("rows 가 비어 있습니다");
  if (p.p_rows.length > 5) return bad("rows 가 너무 많습니다");
  const seen = new Set<string>();
  for (const r of p.p_rows) {
    if (!GUARDABLE.includes(r.account_type)) return bad(`가드 대상이 아닙니다: ${r.account_type}`);
    if (seen.has(r.account_type)) return bad("중복");
    seen.add(r.account_type);
    if (typeof r.data !== "object" || r.data === null || Array.isArray(r.data)) return bad("data 가 객체가 아닙니다");
    if (!("expected_revision" in r)) return bad("expected_revision 이 없습니다");
  }

  // 프로필 단위로 직렬화한다 — 007 은 대상 행들을 account_type 순으로 잠근다.
  return withLock(`${p.p_family_code}|${p.p_profile}`, async () => {
    const conflicts: Array<Record<string, unknown>> = [];
    const revisions: Record<string, number | null> = {};
    const rows = [...p.p_rows].sort((a, b) => a.account_type.localeCompare(b.account_type));

    for (const r of rows) {
      const cur = db.get(key(p.p_family_code, p.p_profile, r.account_type));
      revisions[r.account_type] = cur ? cur.revision : null;
      if (!cur) {
        if (r.expected_revision !== null) {
          conflicts.push({ account_type: r.account_type, reason: "row_missing", expected_revision: r.expected_revision, current_revision: null });
        }
        continue;
      }
      if (r.expected_revision === null) {
        conflicts.push({ account_type: r.account_type, reason: "row_exists", expected_revision: null, current_revision: cur.revision });
        continue;
      }
      if (cur.revision !== r.expected_revision) {
        conflicts.push({ account_type: r.account_type, reason: "revision_mismatch", expected_revision: r.expected_revision, current_revision: cur.revision });
        continue;
      }
      if (!p.p_allow_key_loss) {
        const lost = Object.keys(cur.data).filter((k) => !(k in r.data)).sort();
        if (lost.length) {
          conflicts.push({ account_type: r.account_type, reason: "key_loss", expected_revision: r.expected_revision, current_revision: cur.revision, lost_keys: lost });
          continue;
        }
      }
      if (!p.p_allow_history_shrink && Array.isArray(cur.data.history)) {
        const incoming = new Set(
          (Array.isArray(r.data.history) ? r.data.history : []).map((e) => (e as { id?: string })?.id),
        );
        const missing = (cur.data.history as Array<{ id?: string }>)
          .map((e) => e?.id).filter((id): id is string => !!id && !incoming.has(id)).sort();
        if (missing.length) {
          conflicts.push({ account_type: r.account_type, reason: "history_shrink", expected_revision: r.expected_revision, current_revision: cur.revision, missing_history_ids: missing });
          continue;
        }
      }
    }

    await yieldTick(); // 검사 → 쓰기 사이의 틈

    if (conflicts.length) return { data: { outcome: "conflict", conflicts, revisions }, error: null };

    const saved: Record<string, number> = {};
    for (const r of rows) {
      const k = key(p.p_family_code, p.p_profile, r.account_type);
      const cur = db.get(k);
      const next = cur ? cur.revision + 1 : 1;
      db.set(k, { data: r.data, revision: next });
      saved[r.account_type] = next;
    }
    return { data: { outcome: "saved", revisions: saved, accepted: rows.length }, error: null };
  });
}

/** upsert 기록 — 무가드 경로가 실제로 쓰였는지 보기 위해 남긴다. */
const upserts: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
/** GET 에서 revision 컬럼을 모르는 DB(006 미적용)를 흉내낸다 */
let revisionColumnMissing = false;

const fakeClient = {
  rpc: (name: string, params: Record<string, unknown>) => {
    if (name !== "kaw_data_save_guarded") {
      return Promise.resolve({ data: null, error: { code: "42883", message: `${name} 없음` } });
    }
    return saveGuardedRpc(params as Parameters<typeof saveGuardedRpc>[0]);
  },
  from: (table: string) => ({
    select: (cols: string) => {
      const result = (rows: unknown) => Promise.resolve({ data: rows, error: null });
      const chain = {
        eq: () => chain,
        in: () => {
          if (table === "kaw_data" && cols.includes("revision") && revisionColumnMissing) {
            return Promise.resolve({ data: null, error: { code: "42703", message: "column revision does not exist" } });
          }
          const rows = [...db.entries()].map(([k, v]) => {
            const [, profile, account_type] = k.split("|");
            return cols.includes("revision")
              ? { profile, account_type, data: v.data, revision: v.revision }
              : { profile, account_type, data: v.data };
          });
          return result(rows);
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        limit: () => result([]),
      };
      return chain;
    },
    upsert: (rows: Array<Record<string, unknown>>) => {
      upserts.push({ table, rows });
      // 기존 upsert 는 last-writer-wins 다 — revision 을 올리지 않는다.
      for (const r of rows) {
        const k = key(String(r.family_code), String(r.profile), String(r.account_type));
        const cur = db.get(k);
        db.set(k, { data: r.data as Record<string, unknown>, revision: cur?.revision ?? 0 });
      }
      return Promise.resolve({ error: null });
    },
  }),
};

const session = { code: "soye", profile: "hyeobi", exp: Math.floor(Date.now() / 1000) + 3600, v: 0 };

// **의존성 경계에서** 끼운다 — handleDataPost 는 모듈 안의 serviceClient 를 부르므로
// 모듈 자체를 mock 하면 가로채지지 않는다. createClient 를 바꿔 끼우면 serviceClient 가
// 그대로 돌면서 가짜 클라이언트를 돌려준다(세션 검증 경로도 실제 코드로 지난다).
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleDataPost, handleDataGet } = await import("./data-server");

const SECRET = "test-secret";
const env = {
  SESSION_SECRET: SECRET,
  SUPABASE_URL: "https://guard-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k",
};

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function token(): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(session)));
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleDataPost(
    new Request("https://x/api/data", {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ── 입력 ────────────────────────────────────────────────────────────────────

const F = "soye", P = "hyeobi";
const accountRow = (type: string, data: Record<string, unknown>) => ({
  family_code: F, profile: P, account_type: type, data,
});
const sharedRow = (lib: unknown) => ({
  family_code: F, profile: "_shared", account_type: "_assetLib", data: { assetLibrary: lib },
});

const isaData = (over: Record<string, unknown> = {}) => ({
  cashBalance: 3_621,
  cashflows: [{ id: "cf-1", amount: 688_074 }],
  history: [{ id: "hist:a", date: "2026-09-01" }],
  ...over,
});

function seed() {
  db.set(key(F, P, "_meta"), { data: { profile: "growth" }, revision: 1 });
  db.set(key(F, P, "isa"), { data: isaData(), revision: 7 });
  db.set(key(F, P, "irp"), { data: { history: [] }, revision: 2 });
}

beforeEach(() => {
  db.clear();
  upserts.length = 0;
  locks.clear();
  useLock = true;
  revisionColumnMissing = false;
  seed();
});

const expected = { _meta: 1, isa: 7, irp: 2, retirement: null, pension: null };

// ── 1. 정상 저장 ────────────────────────────────────────────────────────────

describe("정상 저장", () => {
  it("revision 이 맞으면 저장되고 +1 된다", async () => {
    const r = await post({
      rows: [accountRow("isa", isaData({ cashBalance: 10 }))],
      expectedRevisions: { isa: 7 },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, guarded: true, accepted: 1 });
    expect(r.json.revisions).toEqual({ isa: 8 });
    expect(db.get(key(F, P, "isa"))!.revision).toBe(8);
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(10);
  });

  it("프로필 다섯 행 + 공용 행을 한 번에 저장한다", async () => {
    const r = await post({
      rows: [
        accountRow("_meta", { profile: "stable" }),
        sharedRow([{ id: "kr" }]),
        accountRow("retirement", { history: [] }),
        accountRow("isa", isaData()),
        accountRow("pension", { history: [] }),
        accountRow("irp", { history: [] }),
      ],
      expectedRevisions: expected,
    });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(6); // 가드 5 + 공용 1
    expect(db.get(key(F, P, "_meta"))!.revision).toBe(2);
    expect(db.get(key(F, "_shared", "_assetLib"))!.data).toEqual({ assetLibrary: [{ id: "kr" }] });
  });

  it("없던 행은 expected null 로 만들 수 있다 (revision 1)", async () => {
    const r = await post({
      rows: [accountRow("pension", { history: [] })],
      expectedRevisions: { pension: null },
    });
    expect(r.json.revisions).toEqual({ pension: 1 });
  });

  it("GET 이 revision 을 돌려준다 (가드의 입력)", async () => {
    const res = await handleDataGet(
      new Request("https://x/api/data", { headers: { Authorization: `Bearer ${await token()}` } }),
      env,
    );
    const body = (await res.json()) as { rows: Array<{ account_type: string; revision?: number }> };
    expect(body.rows.find((r) => r.account_type === "isa")!.revision).toBe(7);
  });
});

// ── 2. 동시 수정 ────────────────────────────────────────────────────────────

describe("동시 수정", () => {
  it("같은 revision 으로 둘이 저장하면 **한쪽만** 성공한다", async () => {
    const [a, b] = await Promise.all([
      post({ rows: [accountRow("isa", isaData({ cashBalance: 111 }))], expectedRevisions: { isa: 7 } }),
      post({ rows: [accountRow("isa", isaData({ cashBalance: 222 }))], expectedRevisions: { isa: 7 } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(db.get(key(F, P, "isa"))!.revision).toBe(8); // 두 번 올라가지 않았다
    const winner = a.status === 200 ? 111 : 222;
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(winner);
  });

  it("409 는 현재 revision 을 알려준다 (사용자 선택의 재료)", async () => {
    await post({ rows: [accountRow("isa", isaData({ cashBalance: 1 }))], expectedRevisions: { isa: 7 } });
    const stale = await post({
      rows: [accountRow("isa", isaData({ cashBalance: 2 }))],
      expectedRevisions: { isa: 7 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("revision_conflict");
    expect(stale.json.conflicts).toMatchObject([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 7, currentRevision: 8 },
    ]);
    expect(stale.json.revisions).toEqual({ isa: 8 });
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(1); // 덮이지 않았다
  });

  it("**006 history merge 뒤의 오래된 저장**은 거부된다 (같은 카운터로 서로를 보호한다)", async () => {
    // merge 가 history 를 append 하고 revision 을 올린 상태
    const cur = db.get(key(F, P, "isa"))!;
    db.set(key(F, P, "isa"), {
      data: { ...cur.data, history: [...(cur.data.history as unknown[]), { id: "hist:merged", date: "2026-10-12" }] },
      revision: 8,
    });
    const stale = await post({
      rows: [accountRow("isa", isaData())], // merge 를 모르는 문서
      expectedRevisions: { isa: 7 },
    });
    expect(stale.status).toBe(409);
    expect((db.get(key(F, P, "isa"))!.data.history as unknown[])).toHaveLength(2);
  });
});

// ── 2-b. 서로 다른 기기의 동시 수정 (실제 시나리오 재현) ───────────────────

describe("두 기기가 같은 계좌를 수정하는 흐름", () => {
  /** 기기 하나를 흉내낸다 — 조회 시점의 revision 을 들고 있다가 그걸로 저장한다. */
  function device(name: string) {
    let base: number | null = null;
    return {
      async read() {
        const res = await handleDataGet(
          new Request("https://x/api/data", { headers: { Authorization: `Bearer ${await token()}` } }),
          env,
        );
        const body = (await res.json()) as { rows: Array<{ account_type: string; revision?: number }> };
        base = body.rows.find((r) => r.account_type === "isa")?.revision ?? null;
        return base;
      },
      save(data: Record<string, unknown>, opts: Record<string, unknown> = {}) {
        return post({
          rows: [accountRow("isa", data)],
          expectedRevisions: { isa: base },
          ...opts,
        });
      },
      name,
      get base() { return base; },
    };
  }

  it("**뒤늦게 저장하는 기기가 앞선 변경을 덮지 못한다**", async () => {
    const phone = device("phone");
    const pc = device("pc");
    // 둘이 같은 시점(revision 7)을 읽는다
    expect(await phone.read()).toBe(7);
    expect(await pc.read()).toBe(7);

    // PC 가 먼저 저장 → revision 8
    const first = await pc.save(isaData({ cashBalance: 500_000 }));
    expect(first.status).toBe(200);
    expect(first.json.revisions).toEqual({ isa: 8 });

    // 폰이 (PC 의 변경을 모른 채) 저장 → 409, 서버는 그대로
    const second = await phone.save(isaData({ cashBalance: 1 }));
    expect(second.status).toBe(409);
    expect(second.json.conflicts).toMatchObject([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 7, currentRevision: 8 },
    ]);
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(500_000);
    expect(db.get(key(F, P, "isa"))!.revision).toBe(8);
  });

  it("폰이 다시 읽으면 PC 의 변경을 base 로 삼아 저장할 수 있다", async () => {
    const phone = device("phone");
    const pc = device("pc");
    await phone.read();
    await pc.read();
    await pc.save(isaData({ cashBalance: 500_000 }));

    expect(await phone.read()).toBe(8); // 다시 읽어서 base 를 갱신
    const r = await phone.save(isaData({ cashBalance: 500_001 }));
    expect(r.status).toBe(200);
    expect(db.get(key(F, P, "isa"))!.revision).toBe(9);
  });

  it("**사용자가 덮어쓰기를 고른 경우에만** 서버의 더 새로운 변경을 지운다", async () => {
    const phone = device("phone");
    const pc = device("pc");
    await phone.read();
    await pc.read();
    // PC 가 기록을 하나 더 저장(폰은 모른다)
    await pc.save(isaData({
      cashBalance: 500_000,
      history: [{ id: "hist:a", date: "2026-09-01" }, { id: "hist:pc", date: "2026-10-01" }],
    }));

    // 폰이 가진 문서는 그 기록이 없다 → 다시 읽어 base 를 맞춰도 **축소**로 막힌다
    await phone.read();
    const blocked = await phone.save(isaData({ cashBalance: 1 }));
    expect(blocked.status).toBe(409);
    expect((blocked.json.conflicts as Array<{ reason: string }>)[0].reason).toBe("history_shrink");
    expect((db.get(key(F, P, "isa"))!.data.history as unknown[])).toHaveLength(2);

    // 사용자가 "이 화면으로 덮어쓰기"를 고른 경우에만 통과한다
    const forced = await phone.save(isaData({ cashBalance: 1 }), {
      allowHistoryShrink: true, allowKeyLoss: true,
    });
    expect(forced.status).toBe(200);
    expect((db.get(key(F, P, "isa"))!.data.history as unknown[])).toHaveLength(1);
  });

  it("**base 를 모르는 기기는 저장할 수 없다** (revision 없이 보내면 가드가 성립하지 않는다)", async () => {
    // 보류(base_unknown)에서 서버 revision 만 받아와 저장하는 경로가 바로 이 사고다.
    // 그런 요청은 클라이언트가 보내지 않지만(fail-closed), 서버 쪽 결과도 고정해 둔다:
    // 최신 revision 을 base 로 붙이면 **CAS 는 통과한다** — 그래서 그 승격을 금지한다.
    const pc = device("pc");
    await pc.read();
    await pc.save(isaData({ cashBalance: 500_000 })); // 서버 revision 8

    const promoted = await post({
      rows: [accountRow("isa", isaData({ cashBalance: 1, history: [{ id: "hist:a", date: "2026-09-01" }] }))],
      expectedRevisions: { isa: 8 }, // "지금 서버가 8" 을 base 로 **승격**한 경우
    });
    expect(promoted.status).toBe(200); // 서버는 막을 수 없다
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(1); // PC 의 변경이 사라졌다
    // → 그러므로 base 승격 금지는 **클라이언트에서** 지켜져야 한다
    //   (store-revision-guard.test.ts "받아온 revision 을 base 로 승격하지 않는다").
  });
});

// ── 3. 부분 실패 금지 ───────────────────────────────────────────────────────

describe("부분 실패 금지 (전부 아니면 전무)", () => {
  it("다섯 행 중 하나만 어긋나도 **아무것도** 쓰이지 않는다", async () => {
    const r = await post({
      rows: [
        accountRow("_meta", { profile: "aggressive" }),
        accountRow("isa", isaData({ cashBalance: 999 })),
        accountRow("irp", { history: [] }),
      ],
      expectedRevisions: { _meta: 1, isa: 99, irp: 2 },
    });
    expect(r.status).toBe(409);
    expect(db.get(key(F, P, "_meta"))!.data).toEqual({ profile: "growth" });
    expect(db.get(key(F, P, "_meta"))!.revision).toBe(1);
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(3_621);
  });

  it("충돌이면 **공용 행도** 쓰이지 않는다", async () => {
    const r = await post({
      rows: [accountRow("isa", isaData()), sharedRow([{ id: "evil" }])],
      expectedRevisions: { isa: 99 },
    });
    expect(r.status).toBe(409);
    expect(db.has(key(F, "_shared", "_assetLib"))).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("서버에서 행이 삭제됐으면(row_missing) 되살리지 않는다", async () => {
    db.delete(key(F, P, "isa"));
    const r = await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: 7 } });
    expect(r.status).toBe(409);
    expect((r.json.conflicts as Array<{ reason: string }>)[0].reason).toBe("row_missing");
    expect(db.has(key(F, P, "isa"))).toBe(false);
  });

  it("없다고 믿었는데 있으면(row_exists) 덮지 않는다", async () => {
    const r = await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: null } });
    expect(r.status).toBe(409);
    expect((r.json.conflicts as Array<{ reason: string }>)[0].reason).toBe("row_exists");
  });
});

// ── 4. 구버전 요청 ──────────────────────────────────────────────────────────

describe("구버전 요청 (단계적 배포)", () => {
  it("expectedRevisions 가 없으면 기존 무가드 upsert 로 저장된다", async () => {
    const r = await post({ rows: [accountRow("isa", { cashBalance: 5 })] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, accepted: 1, guarded: false });
    expect(upserts).toHaveLength(1);
    expect(db.get(key(F, P, "isa"))!.data).toEqual({ cashBalance: 5 });
    // 무가드 경로는 revision 을 올리지 않는다 (가드를 켠 다른 기기는 다음 조회에서 알게 된다)
    expect(db.get(key(F, P, "isa"))!.revision).toBe(7);
  });

  it("revision 컬럼이 없는 DB(006 미적용)에서도 GET 은 성공한다", async () => {
    revisionColumnMissing = true;
    const res = await handleDataGet(
      new Request("https://x/api/data", { headers: { Authorization: `Bearer ${await token()}` } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ revision?: number }> };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows[0].revision).toBeUndefined();
  });

  it("007 미적용(42883)이면 **무가드로 되돌아가지 않고** 503 이다", async () => {
    const spy = vi.spyOn(fakeClient, "rpc").mockResolvedValue({
      data: null, error: { code: "42883", message: "function does not exist" },
    } as never);
    const r = await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: 7 } });
    expect(r.status).toBe(503);
    expect(r.json.unavailable).toBe(true);
    expect(upserts).toHaveLength(0);
    spy.mockRestore();
  });

  it("expectedRevisions 모양이 틀리면 400 이고 저장하지 않는다", async () => {
    const r = await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: "7" } });
    expect(r.status).toBe(400);
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(3_621);
  });

  it("가드 대상 행에 expected 가 없으면 400 (조용히 무가드로 보내지 않는다)", async () => {
    const r = await post({
      rows: [accountRow("isa", isaData()), accountRow("irp", { history: [] })],
      expectedRevisions: { isa: 7 },
    });
    expect(r.status).toBe(400);
    expect(upserts).toHaveLength(0);
  });
});

// ── 5. 파괴적 저장 ──────────────────────────────────────────────────────────

describe("파괴적 저장은 확인 없이는 거부된다", () => {
  it("history 축소 → 409 (버그로 비어 온 문서를 막는다)", async () => {
    const r = await post({
      rows: [accountRow("isa", isaData({ history: [] }))],
      expectedRevisions: { isa: 7 },
    });
    expect(r.status).toBe(409);
    expect(r.json.conflicts).toMatchObject([{ reason: "history_shrink", missingHistoryIds: ["hist:a"] }]);
    expect((db.get(key(F, P, "isa"))!.data.history as unknown[])).toHaveLength(1);
  });

  it("사용자가 확인하면(allowHistoryShrink) 통과한다", async () => {
    const r = await post({
      rows: [accountRow("isa", isaData({ history: [] }))],
      expectedRevisions: { isa: 7 },
      allowHistoryShrink: true,
    });
    expect(r.status).toBe(200);
    expect((db.get(key(F, P, "isa"))!.data.history as unknown[])).toHaveLength(0);
  });

  it("최상위 키 유실 → 409 (구버전 코드가 모르는 키를 떨어뜨리는 경우)", async () => {
    const r = await post({
      rows: [accountRow("isa", { history: [{ id: "hist:a", date: "2026-09-01" }] })],
      expectedRevisions: { isa: 7 },
    });
    expect(r.status).toBe(409);
    expect(r.json.conflicts).toMatchObject([{ reason: "key_loss", lostKeys: ["cashBalance", "cashflows"] }]);
  });

  it("allowKeyLoss 는 history 축소까지 함께 허용되지 않는다 (서버는 둘을 따로 본다)", async () => {
    const r = await post({
      rows: [accountRow("isa", { cashBalance: 1, cashflows: [], history: [] })],
      expectedRevisions: { isa: 7 },
      allowKeyLoss: true,
    });
    expect(r.status).toBe(409);
    expect((r.json.conflicts as Array<{ reason: string }>)[0].reason).toBe("history_shrink");
  });
});

// ── 6. 경계 ─────────────────────────────────────────────────────────────────

describe("경계", () => {
  it("다른 가족코드/프로필 행은 세션 필터에서 걸러진다", async () => {
    const r = await post({
      rows: [
        { family_code: "침입자", profile: P, account_type: "isa", data: { x: 1 } },
        { family_code: F, profile: "다른사람", account_type: "isa", data: { x: 1 } },
      ],
      expectedRevisions: { isa: 7 },
    });
    // 걸러져서 보낼 것이 없다 → 기존 동작과 같게 accepted 0
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(0);
    expect(db.get(key(F, P, "isa"))!.data.cashBalance).toBe(3_621);
  });

  it("PIN·프로필 설정 행(_family)은 가드 경로로 들어오지 못한다", async () => {
    const r = await post({
      rows: [{ family_code: F, profile: "_system", account_type: "_family", data: { profiles: [] } }],
      expectedRevisions: { _meta: 1 },
    });
    // 세션 필터가 먼저 걸러낸다 — RPC 까지 가지 않는다
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(0);
    expect(db.has(key(F, "_system", "_family"))).toBe(false);
  });

  it("알 수 없는 RPC 반환값을 성공으로 읽지 않는다", async () => {
    const spy = vi.spyOn(fakeClient, "rpc").mockResolvedValue({
      data: { outcome: "merged?" }, error: null,
    } as never);
    expect((await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: 7 } })).status)
      .toBe(500);
    spy.mockRestore();
  });

  it("검사 후 경합(40001)은 409 로 번역된다 (자동 재시도하지 않는다)", async () => {
    const spy = vi.spyOn(fakeClient, "rpc").mockResolvedValue({
      data: null, error: { code: "40001", message: "revision 이 검사 후 바뀌었습니다" },
    } as never);
    const r = await post({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: 7 } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("revision_conflict");
    spy.mockRestore();
  });

  it("**잠금이 없으면 동시 저장이 둘 다 성공한다** — 모델이 `for update` 의 이유를 보여준다", async () => {
    useLock = false;
    const [a, b] = await Promise.all([
      post({ rows: [accountRow("isa", isaData({ cashBalance: 111 }))], expectedRevisions: { isa: 7 } }),
      post({ rows: [accountRow("isa", isaData({ cashBalance: 222 }))], expectedRevisions: { isa: 7 } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]); // 한쪽 변경이 사라졌다
  });
});

// ── 무가드 저장 차단 스위치(KAW_REQUIRE_REVISION) ─────────────────────────────

describe("무가드 저장 차단 스위치 — 기본 OFF, ON 이면 428", () => {
  async function postEnv(body: unknown, extra: Record<string, string | undefined>) {
    const res = await handleDataPost(
      new Request("https://x/api/data", {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}` },
        body: JSON.stringify(body),
      }),
      { ...env, ...extra },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const legacyBody = () => ({ rows: [accountRow("isa", isaData({ cashBalance: 1 })), sharedRow([{ id: "x" }])] });

  it("OFF(기본·on 이 아닌 값)이면 구버전 무가드 요청이 그대로 저장된다(단계적 배포 호환)", async () => {
    for (const v of [undefined, "", "off", "true", "1", "ON"]) {
      upserts.length = 0;
      const r = await postEnv(legacyBody(), { KAW_REQUIRE_REVISION: v });
      expect(r.status).toBe(200);
      expect(r.json.guarded).toBe(false);
      expect(upserts.length).toBe(1);
    }
  });

  it("**ON 이면 계좌 행이 섞인 무가드 요청을 428 로 거부하고 아무 행도 쓰지 않는다**", async () => {
    const before = JSON.stringify([...db.entries()]);
    const r = await postEnv(legacyBody(), { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(428);
    expect(r.json).toMatchObject({ error: "revision_required", saved: false });
    expect(upserts).toHaveLength(0); // 같이 온 공용 행도 쓰지 않는다
    expect(JSON.stringify([...db.entries()])).toBe(before);
  });

  it("ON 이면 expectedRevisions: null 로 보내도 우회되지 않는다", async () => {
    const r = await postEnv({ ...legacyBody(), expectedRevisions: null }, { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(428);
    expect(upserts).toHaveLength(0);
  });

  it("ON 이어도 공용 종목 라이브러리만 보내는 요청은 허용한다(설계상 가드 밖)", async () => {
    const r = await postEnv({ rows: [sharedRow([{ id: "y" }])] }, { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows.every((x) => x.profile === "_shared")).toBe(true);
  });

  it("ON 이어도 가드 요청(expectedRevisions 포함)은 정상 저장된다", async () => {
    const r = await postEnv({
      rows: [accountRow("isa", isaData({ cashBalance: 5 }))],
      expectedRevisions: { isa: 7 },
    }, { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(200);
    expect(r.json.guarded).toBe(true);
    expect((db.get(key(F, P, "isa"))!.data as { cashBalance: number }).cashBalance).toBe(5);
  });

  it("ON 이어도 낡은 revision 은 여전히 409(428 이 아니다)", async () => {
    const r = await postEnv({ rows: [accountRow("isa", isaData())], expectedRevisions: { isa: 1 } }, { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(409);
  });

  it("ON 이어도 다른 가족·프로필 행만 보내면 걸러져 accepted 0(쓰지 않음)", async () => {
    const r = await postEnv({ rows: [{ family_code: "otherfam", profile: P, account_type: "isa", data: {} }] }, { KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});
