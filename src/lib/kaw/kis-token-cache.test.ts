import { describe, it, expect, vi, afterEach } from "vitest";
import { getKisAccessToken, kisAppFingerprint, KisTokenCooldownError, type KVLike } from "./kis-server";

class MemKv implements KVLike {
  store = new Map<string, string>();
  ttl = new Map<string, number | undefined>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string, o?: { expirationTtl?: number }) { this.store.set(k, v); this.ttl.set(k, o?.expirationTtl); }
}

// 테스트마다 앱키가 달라야 모듈 메모리 캐시가 서로 섞이지 않는다.
let n = 0;
const fresh = () => ({ key: `key-${++n}-${Math.random().toString(36).slice(2)}`, secret: `secret-${n}` });
const tokenFor = (appKey: string) => appKey.replace(/^key-/, "TOKEN-"); // 토큰 문자열에 앱키 원문이 섞이지 않게

function stubIssuer(status = 200) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const { appkey } = JSON.parse(String(init?.body));
    if (status !== 200) return new Response("denied", { status });
    return new Response(JSON.stringify({ access_token: tokenFor(appkey), expires_in: 86400 }), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

describe("KIS 토큰 캐시 — 앱키별 분리", () => {
  it("서로 다른 앱키는 서로의 토큰을 돌려받지 않는다 (같은 KV, 같은 isolate)", async () => {
    const kv = new MemKv();
    const market = fresh(), account = fresh();
    const spy = stubIssuer();
    const t1 = await getKisAccessToken(market.key, market.secret, kv);
    const t2 = await getKisAccessToken(account.key, account.secret, kv);
    expect(t1).toBe(tokenFor(market.key));
    expect(t2).toBe(tokenFor(account.key));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("같은 앱키는 다시 발급하지 않는다 (메모리 → KV 재사용)", async () => {
    const kv = new MemKv();
    const a = fresh();
    const spy = stubIssuer();
    await getKisAccessToken(a.key, a.secret, kv);
    await getKisAccessToken(a.key, a.secret, kv);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("KV 키 이름과 값에 앱키·시크릿 원문이 없다", async () => {
    const kv = new MemKv();
    const a = fresh();
    stubIssuer();
    await getKisAccessToken(a.key, a.secret, kv);
    const dump = JSON.stringify([...kv.store.entries()]);
    expect(dump).not.toContain(a.key);
    expect(dump).not.toContain(a.secret);
    expect([...kv.store.keys()].every((k) => k.startsWith("kis:token:v2:"))).toBe(true);
  });

  it("옛 고정 키 `kis:token` 은 읽지 않는다 — 다른 앱의 옛 토큰을 재사용하지 않는다", async () => {
    const kv = new MemKv();
    const a = fresh();
    kv.store.set("kis:token", JSON.stringify({ access_token: "OLD-OTHER-APP", expires_at: Date.now() + 3_600_000 }));
    const spy = stubIssuer();
    const t = await getKisAccessToken(a.key, a.secret, kv);
    expect(t).toBe(tokenFor(a.key));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(kv.store.get("kis:token")).toContain("OLD-OTHER-APP"); // 건드리지도 않는다
  });

  it("KV 항목의 지문이 다르면 (다른 앱 토큰이 같은 키에 들어와 있어도) 쓰지 않는다", async () => {
    const kv = new MemKv();
    const a = fresh();
    const fp = await kisAppFingerprint(a.key);
    kv.store.set(`kis:token:v2:${fp}`, JSON.stringify({ access_token: "WRONG", expires_at: Date.now() + 3_600_000, fp: "deadbeefdeadbeef" }));
    stubIssuer();
    expect(await getKisAccessToken(a.key, a.secret, kv)).toBe(tokenFor(a.key));
  });

  it("앱키가 바뀌면 (키 교체) 옛 앱의 캐시 토큰을 쓰지 않고 새로 발급한다", async () => {
    const kv = new MemKv();
    const oldApp = fresh(), newApp = fresh();
    const spy = stubIssuer();
    await getKisAccessToken(oldApp.key, oldApp.secret, kv);
    expect(await getKisAccessToken(newApp.key, newApp.secret, kv)).toBe(tokenFor(newApp.key));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("같은 앱의 동시 요청은 발급을 1회만 한다", async () => {
    const kv = new MemKv();
    const a = fresh();
    const spy = stubIssuer();
    const r = await Promise.all([1, 2, 3, 4].map(() => getKisAccessToken(a.key, a.secret, kv)));
    expect(new Set(r).size).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("KIS 토큰 발급 제한·오류 처리", () => {
  it("발급이 403 으로 거절되면 쿨다운을 남기고, 이후에는 KIS 를 다시 호출하지 않는다", async () => {
    const kv = new MemKv();
    const a = fresh();
    const spy = stubIssuer(403);
    await expect(getKisAccessToken(a.key, a.secret, kv)).rejects.toThrow(/token error 403/);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(getKisAccessToken(a.key, a.secret, kv)).rejects.toBeInstanceOf(KisTokenCooldownError);
    expect(spy).toHaveBeenCalledTimes(1);
    const failKey = [...kv.store.keys()].find((k) => k.startsWith("kis:token-fail:v2:"))!;
    expect(kv.ttl.get(failKey)).toBe(60);
  });

  it("쿨다운은 앱별이다 — 한 앱의 거절이 다른 앱의 발급을 막지 않는다", async () => {
    const kv = new MemKv();
    const a = fresh(), b = fresh();
    stubIssuer(403);
    await expect(getKisAccessToken(a.key, a.secret, kv)).rejects.toThrow();
    stubIssuer(200);
    expect(await getKisAccessToken(b.key, b.secret, kv)).toBe(tokenFor(b.key));
  });

  it("403 이 아닌 오류(500 등)는 쿨다운을 남기지 않는다", async () => {
    const kv = new MemKv();
    const a = fresh();
    stubIssuer(500);
    await expect(getKisAccessToken(a.key, a.secret, kv)).rejects.toThrow(/token error 500/);
    expect([...kv.store.keys()].some((k) => k.startsWith("kis:token-fail:"))).toBe(false);
  });

  it("실패한 발급은 진행 중 표시를 남기지 않아 다음 호출이 다시 시도한다", async () => {
    const a = fresh();
    stubIssuer(500);
    await expect(getKisAccessToken(a.key, a.secret)).rejects.toThrow();
    const spy = stubIssuer(200);
    expect(await getKisAccessToken(a.key, a.secret)).toBe(tokenFor(a.key));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("KV 가 없거나 KV 쓰기가 실패해도 토큰은 돌려준다", async () => {
    const a = fresh(), b = fresh();
    stubIssuer();
    expect(await getKisAccessToken(a.key, a.secret)).toBe(tokenFor(a.key));
    const brokenKv: KVLike = { get: async () => null, put: async () => { throw new Error("kv down"); } };
    expect(await getKisAccessToken(b.key, b.secret, brokenKv)).toBe(tokenFor(b.key));
  });
});
