/**
 * RebalancePlan — PRE 근거 판정, ticker 공간 집계, canonical 해시.
 *
 * 세 가지를 특히 고정한다:
 *   1. 과거 날짜·세션 부재·instance 변경에서 **PRE 를 만들지 않는다**(fail closed)
 *   2. 같은 ticker 여러 row 합산 / ticker 없는 행은 0 으로 채우지 않는다
 *   3. 해시가 identity·volatile·파생값에 흔들리지 않고 **경제값에만** 반응한다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  aggregateByTicker,
  canonicalJson,
  canonicalPlanPayload,
  effectivePreBasis,
  expectedDeltaByTicker,
  planHashVersionOf,
  planPayloadHash,
  resolvePreBasis,
  stableDigest,
  type PlanPriceEvidence,
  type PlanRowMeta,
  type RebalancePlan,
  type RebalanceSessionSnapshot,
} from "./rebalance-plan";

// ── fixture ────────────────────────────────────────────────────────────────

const meta = (ticker: string | null, etfName: string, orphaned = false): PlanRowMeta => ({
  assetId: "x",
  etfName,
  label: etfName,
  ticker,
  orphaned,
});

const price = (ticker: string | null, p: number | null): PlanPriceEvidence => ({
  ticker,
  price: p,
  source: p === null ? "unavailable" : "kis-live",
  asOf: p === null ? null : "2026-10-02T02:30:00.000Z",
});

const session = (over: Partial<RebalanceSessionSnapshot> = {}): RebalanceSessionSnapshot => ({
  sessionId: "rbs:1",
  accountType: "irp",
  accountInstanceId: "bai:A",
  startedAt: "2026-10-02T02:19:20.000Z",
  trigger: "quantity",
  preDateMode: "today",
  preQuantities: { r1: 67, r2: 93 },
  preCash: 262_937,
  preRowMeta: { r1: meta("360750", "TIGER 미국S&P500"), r2: meta("438080", "ACE 혼합50") },
  preProfileKey: "growth",
  ...over,
});

const basePlan = (over: Partial<RebalancePlan> = {}): RebalancePlan => ({
  id: "plan:cpl:1",
  completionId: "cpl:1",
  accountType: "irp",
  broker: "miraeasset",
  accountInstanceId: "bai:A",
  planDate: "2026-10-02",
  recordedAt: "2026-10-02T02:30:00.000Z",
  dateMode: "today",
  preBasis: "session_snapshot",
  preQuantities: { r1: 67, r2: 93 },
  preCash: 262_937,
  preCashAtRecord: 262_937,
  plannedQuantities: { r1: 91, r2: 103 },
  assertedPostCash: 2_352,
  rowMeta: { r1: meta("360750", "TIGER 미국S&P500"), r2: meta("438080", "ACE 혼합50") },
  priceMode: "live",
  priceEvidence: { r1: price("360750", 18_000), r2: price("438080", 11_000) },
  planPayloadHash: "p1|x",
  hashVersion: 1,
  actor: "hyeobi",
  ...over,
});

// ── PRE 근거 판정 ──────────────────────────────────────────────────────────

describe("resolvePreBasis — 과거 날짜는 fail closed", () => {
  it("today + 세션 + 캡처도 today → session_snapshot", () => {
    const r = resolvePreBasis(session(), "today", "bai:A");
    expect(r.preBasis).toBe("session_snapshot");
    expect(r.preQuantities).toEqual({ r1: 67, r2: 93 });
    expect(r.preCash).toBe(262_937);
    expect(r.preDiscardReason).toBeNull();
  });

  it("date_mode past → 세션이 있어도 unknown (현재 상태를 과거 PRE 로 쓰지 않는다)", () => {
    const r = resolvePreBasis(session(), "past", "bai:A");
    expect(r.preBasis).toBe("unknown");
    expect(r.preQuantities).toBeNull();
    expect(r.preCash).toBeNull();
    expect(r.preDiscardReason).toBe("past_date_mode");
  });

  it("캡처는 today 였는데 완료가 past → unknown", () => {
    const r = resolvePreBasis(session({ preDateMode: "today" }), "past", "bai:A");
    expect(r.preDiscardReason).toBe("past_date_mode");
  });

  it("캡처가 past 였는데 완료가 today → date_mode_changed", () => {
    const r = resolvePreBasis(session({ preDateMode: "past" }), "today", "bai:A");
    expect(r.preBasis).toBe("unknown");
    expect(r.preDiscardReason).toBe("date_mode_changed");
  });

  it("세션이 없으면 no_session — history 역산하지 않는다", () => {
    expect(resolvePreBasis(null, "today", "bai:A")).toEqual({
      preBasis: "unknown",
      preQuantities: null,
      preCash: null,
      preDiscardReason: "no_session",
    });
  });

  it("instance 가 달라졌으면 instance_changed", () => {
    const r = resolvePreBasis(session(), "today", "bai:B");
    expect(r.preDiscardReason).toBe("instance_changed");
  });

  it("preCash 미입력(undefined)은 null 로 보존된다 (0 으로 바꾸지 않는다)", () => {
    const r = resolvePreBasis(session({ preCash: undefined }), "today", "bai:A");
    expect(r.preBasis).toBe("session_snapshot");
    expect(r.preCash).toBeNull();
  });
});

describe("effectivePreBasis — broker_snapshot 은 overlay 로만 (005 는 2값)", () => {
  const plan = basePlan({ preBasis: "unknown", preQuantities: null, preCash: null });
  const res = { planId: plan.id, preSourceObservationId: "obs:1", reason: "확인" };
  const obs = {
    id: "obs:1",
    accountInstanceId: "bai:A",
    stateAsOf: "2026-10-02",
    hasHoldings: true,
    voided: false,
  };

  it("session_snapshot 은 그대로", () => {
    expect(effectivePreBasis(basePlan())).toBe("session_snapshot");
  });

  it("unknown + 유효 overlay → broker_snapshot (plan 행은 수정하지 않는다)", () => {
    expect(effectivePreBasis(plan, res, obs)).toBe("broker_snapshot");
    expect(plan.preBasis).toBe("unknown");
  });

  it("overlay 없으면 unknown 유지", () => {
    expect(effectivePreBasis(plan)).toBe("unknown");
  });

  it("instance 불일치 overlay 는 무효", () => {
    expect(effectivePreBasis(plan, res, { ...obs, accountInstanceId: "bai:B" })).toBe("unknown");
  });

  it("날짜 불일치 overlay 는 무효", () => {
    expect(effectivePreBasis(plan, res, { ...obs, stateAsOf: "2026-10-01" })).toBe("unknown");
  });

  it("holdings 없는 관측 / void 된 관측은 무효", () => {
    expect(effectivePreBasis(plan, res, { ...obs, hasHoldings: false })).toBe("unknown");
    expect(effectivePreBasis(plan, res, { ...obs, voided: true })).toBe("unknown");
  });

  it("가리키는 관측 id 가 다르면 무효", () => {
    expect(effectivePreBasis(plan, res, { ...obs, id: "obs:2" })).toBe("unknown");
  });
});

// ── ticker 공간 집계 ──────────────────────────────────────────────────────

describe("aggregateByTicker", () => {
  it("같은 ticker 여러 row 를 합산한다 (orphan + 재추가 시나리오)", () => {
    const rowMeta = {
      "kr_1": meta("0167A0", "SOL AI반도체TOP2플러스", true),
      "kr_2": meta("0167A0", "SOL AI반도체TOP2플러스"),
    };
    const agg = aggregateByTicker({ kr_1: 37, kr_2: 13 }, rowMeta);
    expect(agg.byTicker).toEqual({ "0167A0": 50 });
    expect(agg.unmappable).toEqual([]);
  });

  it("수량 0 인 ticker 항목은 **남긴다** (전량매도 검증에 필요하다)", () => {
    const agg = aggregateByTicker({ r1: 0 }, { r1: meta("0167A0", "SOL") });
    expect(agg.byTicker).toEqual({ "0167A0": 0 });
  });

  it("ticker 없는 행은 0 으로 채우지 않고 unmappable 로 분리한다", () => {
    const agg = aggregateByTicker(
      { r1: 10, r2: 5 },
      { r1: meta(null, "미등록 ETF"), r2: meta("360750", "TIGER") },
    );
    expect(agg.byTicker).toEqual({ "360750": 5 });
    expect(agg.unmappable).toEqual([{ rowId: "r1", etfName: "미등록 ETF", quantity: 10 }]);
  });

  it("ticker 없고 수량 0 인 행은 unmappable 이 아니다 (비교할 것이 없다)", () => {
    const agg = aggregateByTicker({ r1: 0 }, { r1: meta(null, "미등록") });
    expect(agg.unmappable).toEqual([]);
  });

  it("rowId 입력 순서가 달라도 결과가 같다", () => {
    const rowMeta = { a: meta("X", "x"), b: meta("X", "x") };
    const one = aggregateByTicker({ a: 1, b: 2 }, rowMeta);
    const two = aggregateByTicker({ b: 2, a: 1 }, rowMeta);
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });
});

describe("expectedDeltaByTicker", () => {
  it("planned − pre 이고 변화 0 인 ticker 는 제외한다", () => {
    expect(expectedDeltaByTicker({ A: 10, B: 5 }, { A: 10, B: 8, C: 3 })).toEqual({ B: 3, C: 3 });
  });

  it("전량매도는 음수 delta 로 나온다", () => {
    expect(expectedDeltaByTicker({ A: 37 }, { A: 0 })).toEqual({ A: -37 });
  });

  it("PRE 를 모르면 null — 역산하지 않는다", () => {
    expect(expectedDeltaByTicker(null, { A: 10 })).toBeNull();
  });
});

// ── canonical 해시 ────────────────────────────────────────────────────────

describe("planPayloadHash — 경제값에만 반응한다", () => {
  it("버전 prefix 를 들고 있다 (004 fp_version 패턴)", () => {
    const h = planPayloadHash(basePlan());
    expect(h).toMatch(/^p1\|[0-9a-f]{32}$/);
    expect(planHashVersionOf(h)).toBe(1);
    expect(planHashVersionOf("garbage")).toBeNull();
  });

  it("같은 completion 재시도 → 같은 해시", () => {
    expect(planPayloadHash(basePlan())).toBe(planPayloadHash(basePlan()));
  });

  it("identity / volatile / 파생값만 달라도 **같은 해시** (재기록 탐지)", () => {
    const a = basePlan();
    const b = basePlan({
      id: "plan:cpl:2",
      completionId: "cpl:2",
      recordedAt: "2026-10-05T01:00:00.000Z",
      actor: "someone-else",
      dateMode: "past",
      priceMode: "history",
      frozenInvested: 999_999,
      frozenInvestedBasis: "remount_refreeze",
      baseAmount: 1,
      projectedPostCash: 12_345,
      preSessionId: "rbs:other",
      preCashAtRecord: 1,
      appStateCashAtRecord: 7,
      brokerProductCode: "29",
      accountRefFingerprint: "a1|zzz",
    });
    expect(planPayloadHash(b)).toBe(planPayloadHash(a));
  });

  it("투자성향 변경으로 rowId 가 전부 달라도 ticker 가 같으면 **같은 해시**", () => {
    const a = basePlan();
    const b = basePlan({
      preQuantities: { z9: 67, z8: 93 },
      plannedQuantities: { z9: 91, z8: 103 },
      rowMeta: {
        z9: meta("360750", "TIGER 미국S&P500"),
        z8: meta("438080", "ACE 혼합50"),
      },
      priceEvidence: { z9: price("360750", 18_000), z8: price("438080", 11_000) },
    });
    expect(planPayloadHash(b)).toBe(planPayloadHash(a));
  });

  it("planned 수량이 1주 다르면 다른 해시", () => {
    expect(planPayloadHash(basePlan({ plannedQuantities: { r1: 92, r2: 103 } }))).not.toBe(
      planPayloadHash(basePlan()),
    );
  });

  it("assertedPostCash / preCash / planDate / instance 가 다르면 다른 해시", () => {
    const base = planPayloadHash(basePlan());
    expect(planPayloadHash(basePlan({ assertedPostCash: 2_353 }))).not.toBe(base);
    expect(planPayloadHash(basePlan({ preCash: 262_938 }))).not.toBe(base);
    expect(planPayloadHash(basePlan({ planDate: "2026-10-03" }))).not.toBe(base);
    expect(planPayloadHash(basePlan({ accountInstanceId: "bai:B" }))).not.toBe(base);
  });

  it("preBasis 가 다르면 다른 해시 (PRE 를 아는지 여부가 의도를 바꾼다)", () => {
    expect(
      planPayloadHash(basePlan({ preBasis: "unknown", preQuantities: null, preCash: null })),
    ).not.toBe(planPayloadHash(basePlan()));
  });

  it("targetWeights 가 다르면 다른 해시 (intention data)", () => {
    expect(planPayloadHash(basePlan({ targetWeights: { r1: 60, r2: 40 } }))).not.toBe(
      planPayloadHash(basePlan({ targetWeights: { r1: 50, r2: 50 } })),
    );
  });

  it("가격이 다르면 다른 해시 / 가격 부재는 null 로 구분된다", () => {
    const base = planPayloadHash(basePlan());
    expect(planPayloadHash(basePlan({ priceEvidence: { r1: price("360750", 18_100), r2: price("438080", 11_000) } }))).not.toBe(base);
    const missing = basePlan({ priceEvidence: { r1: price("360750", null), r2: price("438080", 11_000) } });
    expect(planPayloadHash(missing)).not.toBe(base);
    expect(canonicalPlanPayload(missing).priceByTicker["360750"]).toEqual([]);
  });

  it("unmappable 행만 달라도 다른 해시 (무시하면 다른 계획이 같아진다)", () => {
    const a = basePlan({
      plannedQuantities: { r1: 91, r2: 103, r3: 5 },
      rowMeta: { ...basePlan().rowMeta, r3: meta(null, "미등록 A") },
    });
    const b = basePlan({
      plannedQuantities: { r1: 91, r2: 103, r3: 5 },
      rowMeta: { ...basePlan().rowMeta, r3: meta(null, "미등록 B") },
    });
    expect(planPayloadHash(a)).not.toBe(planPayloadHash(b));
  });
});

describe("canonicalJson / stableDigest", () => {
  it("키 순서에 무관하다", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("null 과 undefined 와 0 을 서로 다르게 표현한다", () => {
    expect(canonicalJson({ x: null })).not.toBe(canonicalJson({ x: undefined }));
    expect(canonicalJson({ x: null })).not.toBe(canonicalJson({ x: 0 }));
  });

  it("-0 과 0 을 같게 본다", () => {
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
  });

  it("digest 는 32 자 16진수이고 결정적이다", () => {
    expect(stableDigest("abc")).toMatch(/^[0-9a-f]{32}$/);
    expect(stableDigest("abc")).toBe(stableDigest("abc"));
    expect(stableDigest("abc")).not.toBe(stableDigest("abd"));
  });
});

// ── 불변식: target_weights → ledger 금지 (D9) ─────────────────────────────

describe("target_weights 는 Transaction Ledger 생성 근거가 아니다 (D9)", () => {
  const files = [
    "src/lib/kaw/rebalance-plan.ts",
    "src/lib/kaw/reconcile.ts",
    "src/lib/kaw/completion-envelope.ts",
    "src/lib/kaw/settlement-observation.ts",
    "src/lib/kaw/rebalance-journal.ts",
  ];

  it("Phase 0 모듈이 원장 테이블을 쓰거나 체결을 합성하지 않는다", () => {
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), "utf-8");
      // 주석으로 원장을 언급하는 것은 허용한다 — 금지 대상은 **쓰기 경로**다.
      expect(src, f).not.toMatch(/\.from\(\s*["'`]kaw_/);
      expect(src, f).not.toMatch(/\.insert\(|\.upsert\(|\.delete\(\s*\)/);
      expect(src, f).not.toMatch(/supabase|service_role|SupabaseClient/);
      // 체결 신원을 만드는 함수를 쓰지 않는다 = synthetic execution 을 만들 수 없다.
      expect(src, f).not.toMatch(/transactionFingerprint|assignFingerprints/);
      expect(src, f).not.toMatch(/from\s+["'][.\/]*ledger-(import-core|server)["']/);
    }
  });

  it("targetWeights 를 읽는 곳은 canonical 해시(의도 기록) 뿐이다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/rebalance-plan.ts"), "utf-8");
    const hits = src.match(/plan\.targetWeights/g) ?? [];
    // canonicalPlanPayload 안의 2회(존재 확인 + 집계)만 허용한다.
    expect(hits.length).toBeLessThanOrEqual(2);
    // reconcile 은 targetWeights 를 아예 보지 않는다 — 판정 근거가 될 수 없다.
    const rec = readFileSync(resolve(process.cwd(), "src/lib/kaw/reconcile.ts"), "utf-8");
    expect(rec).not.toMatch(/targetWeights/);
  });
});
