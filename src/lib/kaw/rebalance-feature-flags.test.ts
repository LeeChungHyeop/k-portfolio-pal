/**
 * feature flag — **기본 OFF 이고, production 에서는 localStorage 로 켤 수 없다.**
 *
 * Phase 1A 는 plan API 가 없어서 완료 envelope 을 confirmed 로 올릴 수단이 없다.
 * production 빌드에서 devtools 한 줄로 켜지면 그 기기에서 outbox 가 영구히 누적되므로
 * **빌드 타임 허용을 반드시 요구한다.**
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SESSION_TRACKING_LS_KEY,
  isSessionTrackingEnabled,
  resolveSessionTrackingFlag,
  sessionTrackingSources,
  type SessionTrackingSources,
} from "./rebalance-feature-flags";

class MemStorage implements Storage {
  private map = new Map<string, string>();
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

/** 현재 production 빌드의 소스 조합: `.env` 에 변수 없음 + DEV=false */
const production = (local: string | null): SessionTrackingSources => ({
  env: undefined,
  local,
  dev: false,
});
const devServer = (local: string | null): SessionTrackingSources => ({
  env: undefined,
  local,
  dev: true,
});

describe("resolveSessionTrackingFlag — 빌드 타임 허용을 요구한다", () => {
  it("아무것도 설정하지 않으면 꺼져 있다", () => {
    expect(resolveSessionTrackingFlag(production(null))).toBe(false);
  });

  it("**production 빌드에서는 localStorage 로 켤 수 없다**", () => {
    expect(resolveSessionTrackingFlag(production("on"))).toBe(false);
    // 다른 어떤 값으로도 켜지지 않는다
    for (const v of ["on", "true", "1", "ON", "yes", "enable"]) {
      expect(resolveSessionTrackingFlag(production(v))).toBe(false);
    }
  });

  it("빌드 타임 env 가 on 이면 어느 빌드에서든 켜진다 (명시적 opt-in 빌드)", () => {
    expect(resolveSessionTrackingFlag({ env: "on", local: null, dev: false })).toBe(true);
    expect(resolveSessionTrackingFlag({ env: "on", local: "off", dev: false })).toBe(true);
  });

  it("DEV 빌드에서만 런타임 스위치를 인정한다", () => {
    expect(resolveSessionTrackingFlag(devServer("on"))).toBe(true);
    expect(resolveSessionTrackingFlag(devServer(null))).toBe(false);
  });

  it('"on" 이 아닌 값은 전부 OFF 다 — truthy 판정을 쓰지 않는다', () => {
    for (const v of ["true", "1", "ON", "off", "false", "", "yes"]) {
      expect(resolveSessionTrackingFlag({ env: v, local: v, dev: true })).toBe(false);
    }
  });
});

describe("isSessionTrackingEnabled", () => {
  it("환경이 비어 있으면 OFF 가 기본이다", () => {
    expect(isSessionTrackingEnabled()).toBe(false);
  });

  it("매번 다시 읽는다 — 끄면 즉시 꺼진다(캐시하지 않는다)", () => {
    // vitest 는 DEV 빌드라 런타임 스위치가 인정된다
    expect(sessionTrackingSources().dev).toBe(true);
    store.setItem(SESSION_TRACKING_LS_KEY, "on");
    expect(isSessionTrackingEnabled()).toBe(true);
    store.removeItem(SESSION_TRACKING_LS_KEY);
    expect(isSessionTrackingEnabled()).toBe(false);
  });

  it("localStorage 가 아예 없어도 예외 없이 OFF 로 degrade 한다", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(isSessionTrackingEnabled()).toBe(false);
    expect(sessionTrackingSources().local).toBeNull();
  });

  it("빌드 타임 env 는 설정돼 있지 않다 (production 에서 꺼진 채로 나가는 근거)", () => {
    expect(sessionTrackingSources().env).toBeUndefined();
  });
});
