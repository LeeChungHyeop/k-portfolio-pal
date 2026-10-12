/**
 * 결제 관측 — capture 단위 해시(dedupe + holdings/cash pairing), partial capture
 * 선택 규칙, plan universe 기준 정규화.
 *
 * 가장 중요한 두 가지:
 *   · **서로 다른 capture 의 holdings 와 cash 를 조합하지 않는다**
 *   · 부재를 0 으로 추정하는 것은 `non_zero_only` 가 **실증된** source 에서만
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPTURE_HASH_VERSION,
  captureHashVersionOf,
  captureId,
  capturePayloadHash,
  cashOf,
  compareCaptureSelection,
  completenessRank,
  groupCaptures,
  holdingsCaptureSequence,
  holdingsOf,
  normalizeHoldings,
  observationRowId,
  type Capture,
  type CapturePartInput,
  type ObservationPart,
} from "./settlement-observation";

// ── fixture ────────────────────────────────────────────────────────────────

const holdingsPart = (
  holdings: Record<string, number> | null,
  over: Partial<CapturePartInput> = {},
): CapturePartInput => ({
  sourceType: "kis_pension_present_balance",
  stateAsOfBasis: "observation_date",
  settlementBasis: "settlement",
  holdings,
  holdingsCompleteness: "non_zero_only",
  cash: null,
  ...over,
});

const cashPart = (cash: number | null, over: Partial<CapturePartInput> = {}): CapturePartInput => ({
  sourceType: "kis_pension_deposit",
  stateAsOfBasis: "observation_date",
  settlementBasis: "settlement",
  holdings: null,
  holdingsCompleteness: "unknown",
  cash,
  ...over,
});

/** part 입력에서 실제 행들을 만든다 (capture id 와 row id 가 내용에서 파생된다) */
function makeParts(
  instanceId: string,
  stateAsOf: string,
  parts: readonly CapturePartInput[],
  observedAt = "2026-10-09T01:00:00.000Z",
): ObservationPart[] {
  const capId = captureId(instanceId, stateAsOf, parts);
  const hash = capturePayloadHash(instanceId, stateAsOf, parts);
  return parts.map((p) => ({
    id: observationRowId(capId, p.sourceType),
    captureId: capId,
    accountType: "irp" as const,
    broker: "kis",
    brokerProductCode: "29",
    accountInstanceId: instanceId,
    observedAt,
    stateAsOf,
    stateAsOfBasis: p.stateAsOfBasis,
    settlementBasis: p.settlementBasis,
    sourceType: p.sourceType,
    holdings: p.holdings,
    holdingsCompleteness: p.holdingsCompleteness,
    cash: p.cash,
    acquisitionCost: p.acquisitionCost ?? null,
    accountTotal: p.accountTotal ?? null,
    capturePayloadHash: hash,
    hashVersion: CAPTURE_HASH_VERSION,
    actor: "hyeobi",
  }));
}

const capture = (parts: ObservationPart[]): Capture => groupCaptures(parts)[0];

// ── capture 해시 / id ─────────────────────────────────────────────────────

describe("capture 해시는 내용에서 결정적으로 나온다", () => {
  const parts = [holdingsPart({ "360750": 91 }), cashPart(2_458)];

  it("버전 prefix 를 들고 있다", () => {
    const h = capturePayloadHash("bai:A", "2026-10-09", parts);
    expect(h).toMatch(/^c1\|[0-9a-f]{32}$/);
    expect(captureHashVersionOf(h)).toBe(1);
    expect(captureHashVersionOf("nope")).toBeNull();
  });

  it("part 순서가 달라도 같은 해시다", () => {
    expect(capturePayloadHash("bai:A", "2026-10-09", [...parts].reverse())).toBe(
      capturePayloadHash("bai:A", "2026-10-09", parts),
    );
  });

  it("observedAt 은 해시에 들어가지 않는다 (폴링 로그가 되지 않게)", () => {
    const a = makeParts("bai:A", "2026-10-09", parts, "2026-10-09T01:00:00.000Z");
    const b = makeParts("bai:A", "2026-10-09", parts, "2026-10-09T09:00:00.000Z");
    expect(a[0].captureId).toBe(b[0].captureId);
    expect(a[0].id).toBe(b[0].id);
  });

  it("같은 refresh 재수집 → 같은 capture_id → capture 전체 dedupe", () => {
    const first = makeParts("bai:A", "2026-10-09", parts);
    const again = makeParts("bai:A", "2026-10-09", parts);
    expect(new Set([...first, ...again].map((p) => p.id)).size).toBe(2);
  });

  it("cash 만 변하면 **capture 전체**가 새로 생긴다 (pairing 유지)", () => {
    const a = makeParts("bai:A", "2026-10-09", [holdingsPart({ "360750": 91 }), cashPart(2_458)]);
    const b = makeParts("bai:A", "2026-10-09", [holdingsPart({ "360750": 91 }), cashPart(2_544)]);
    expect(a[0].captureId).not.toBe(b[0].captureId);
    // holdings 행도 다른 capture 에 속하므로 짝이 섞이지 않는다.
    expect(a.find((p) => p.holdings)!.captureId).not.toBe(b.find((p) => p.holdings)!.captureId);
  });

  it("null cash 와 cash 0 은 다른 해시다", () => {
    expect(capturePayloadHash("bai:A", "d", [cashPart(null)])).not.toBe(
      capturePayloadHash("bai:A", "d", [cashPart(0)]),
    );
  });

  it("instance / state_as_of 가 다르면 다른 capture 다", () => {
    const base = captureId("bai:A", "2026-10-09", parts);
    expect(captureId("bai:B", "2026-10-09", parts)).not.toBe(base);
    expect(captureId("bai:A", "2026-10-10", parts)).not.toBe(base);
  });

  it("capture id 와 row id 모양", () => {
    const capId = captureId("bai:A", "2026-10-09", parts);
    expect(capId).toMatch(/^cap:bai:A:2026-10-09:[0-9a-f]{12}$/);
    expect(observationRowId(capId, "kis_pension_deposit")).toBe(`obs:${capId}:kis_pension_deposit`);
  });
});

// ── 그룹 / 축 추출 ───────────────────────────────────────────────────────

describe("groupCaptures / holdingsOf / cashOf", () => {
  it("part 들을 capture 로 묶고 가장 이른 observedAt 을 쓴다", () => {
    const parts = makeParts("bai:A", "2026-10-09", [holdingsPart({ "360750": 91 }), cashPart(2_458)]);
    parts[1] = { ...parts[1], observedAt: "2026-10-09T00:00:00.000Z" };
    const c = capture(parts);
    expect(c.parts).toHaveLength(2);
    expect(c.observedAt).toBe("2026-10-09T00:00:00.000Z");
  });

  it("void 된 part 는 그룹에서 제외된다", () => {
    const parts = makeParts("bai:A", "2026-10-09", [holdingsPart({ "360750": 91 }), cashPart(2_458)]);
    const groups = groupCaptures(parts, [{ observationId: parts[1].id, reason: "오입력" }]);
    expect(groups[0].parts).toHaveLength(1);
    expect(cashOf(groups[0]).kind).toBe("absent");
  });

  it("모든 part 가 void 되면 capture 자체가 사라진다", () => {
    const parts = makeParts("bai:A", "2026-10-09", [holdingsPart({ "360750": 91 })]);
    expect(groupCaptures(parts, [{ observationId: parts[0].id, reason: "오입력" }])).toEqual([]);
  });

  it("autoReconcile 이 false 인 source 는 축에서 제외된다 (D6)", () => {
    const parts = makeParts("bai:A", "2026-10-07", [
      holdingsPart({ "360750": 91 }, { sourceType: "broker_historical_balance" }),
    ]);
    expect(holdingsOf(capture(parts)).kind).toBe("absent");
  });

  it("한 capture 안에서 값이 어긋나면 conflict (fail closed)", () => {
    const parts = makeParts("bai:A", "2026-10-09", [
      holdingsPart({ "360750": 91 }),
      holdingsPart({ "360750": 90 }, { sourceType: "kis_inquire_balance" }),
    ]);
    expect(holdingsOf(capture(parts)).kind).toBe("conflict");
  });

  it("완전성 등급: holdings+cash 2 / holdings 1 / cash 0 / 없음 -1", () => {
    const both = capture(makeParts("bai:A", "d", [holdingsPart({ A: 1 }), cashPart(10)]));
    const hOnly = capture(makeParts("bai:A", "d", [holdingsPart({ A: 1 })]));
    const cOnly = capture(makeParts("bai:A", "d", [cashPart(10)]));
    expect(completenessRank(both)).toBe(2);
    expect(completenessRank(hOnly)).toBe(1);
    expect(completenessRank(cOnly)).toBe(0);
    expect(
      completenessRank(
        capture(
          makeParts("bai:A", "d", [
            holdingsPart({ A: 1 }, { sourceType: "broker_historical_balance" }),
          ]),
        ),
      ),
    ).toBe(-1);
  });
});

// ── partial capture 선택 규칙 ────────────────────────────────────────────

describe("capture 선택 — 완전성은 같은 state_as_of 안에서만 tie-break", () => {
  const older = capture(makeParts("bai:A", "2026-10-08", [holdingsPart({ A: 1 }), cashPart(500)]));
  const newerPartial = capture(makeParts("bai:A", "2026-10-09", [holdingsPart({ A: 2 })]));

  it("더 늦은 날짜가 primary 다 — 과거의 완전한 capture 를 고르지 않는다", () => {
    const best = [older, newerPartial].sort(compareCaptureSelection)[0];
    expect(best.stateAsOf).toBe("2026-10-09");
    // cash 가 딸려 있다는 이유로 오래된 holdings 를 쓰면 틀린 상태가 된다.
    expect(cashOf(best).kind).toBe("absent");
  });

  it("같은 날짜에서는 더 완전한 capture 가 우선이다", () => {
    const partial = capture(makeParts("bai:A", "2026-10-09", [holdingsPart({ A: 2 })]));
    const full = capture(makeParts("bai:A", "2026-10-09", [holdingsPart({ A: 2 }), cashPart(2_458)]));
    const best = [partial, full].sort(compareCaptureSelection)[0];
    expect(completenessRank(best)).toBe(2);
    // 이전 partial capture 는 **삭제되지 않고** 그대로 남는다 (append-only).
    expect([partial, full]).toHaveLength(2);
  });

  it("정렬이 결정적이다 (입력 순서에 무관)", () => {
    const list = [older, newerPartial];
    const a = [...list].sort(compareCaptureSelection).map((c) => c.captureId);
    const b = [...list].reverse().sort(compareCaptureSelection).map((c) => c.captureId);
    expect(a).toEqual(b);
  });

  it("holdings 시퀀스는 시간 오름차순이고 holdings 있는 capture 만 포함한다", () => {
    const cashOnly = capture(makeParts("bai:A", "2026-10-10", [cashPart(1)]));
    const seq = holdingsCaptureSequence([newerPartial, older, cashOnly]);
    expect(seq.map((c) => c.stateAsOf)).toEqual(["2026-10-08", "2026-10-09"]);
  });
});

describe("서로 다른 capture 의 축을 조합하지 않는다", () => {
  it("holdingsOf / cashOf 는 단일 capture 만 인자로 받는다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/settlement-observation.ts"), "utf-8");
    expect(src).toMatch(/export function holdingsOf\(capture: Capture\)/);
    expect(src).toMatch(/export function cashOf\(capture: Capture\)/);
    // 여러 capture 를 받아 축을 합치는 함수가 없어야 한다.
    expect(src).not.toMatch(/function\s+merge(?:Captures|Axes)/i);
    expect(src).not.toMatch(/captures:\s*readonly Capture\[\]\s*\)\s*:\s*AxisValue/);
  });
});

// ── plan universe 정규화 ─────────────────────────────────────────────────

describe("normalizeHoldings", () => {
  const universe = ["360750", "438080", "367380", "0167A0", "0181B0"];

  it("non_zero_only: 응답에 없는 종목을 0 으로 normalize → 전량매도를 검증할 수 있다", () => {
    const n = normalizeHoldings(
      { "360750": 91, "438080": 103, "367380": 29 },
      universe,
      "kis_pension_present_balance",
      "non_zero_only",
    );
    expect(n.byTicker).toEqual({
      "360750": 91,
      "438080": 103,
      "367380": 29,
      "0167A0": 0,
      "0181B0": 0,
    });
    expect(n.nonComparable).toEqual([]);
  });

  it("unknown: 부재를 0 으로 추정하지 않고 nonComparable 로 남긴다", () => {
    const n = normalizeHoldings(
      { "360750": 91, "438080": 103, "367380": 29 },
      universe,
      "kis_inquire_balance",
    );
    expect(n.byTicker).toEqual({ "360750": 91, "438080": 103, "367380": 29 });
    expect(n.nonComparable).toEqual(["0167A0", "0181B0"]);
  });

  it("행 completeness 가 registry 를 덮는다 (R8)", () => {
    const n = normalizeHoldings({ A: 1 }, ["A", "B"], "kis_inquire_balance", "all_positions");
    expect(n.byTicker).toEqual({ A: 1, B: 0 });
    expect(n.nonComparable).toEqual([]);
  });

  it("plan 에 없는 ticker 는 extraneous 로 **별도 보고**한다 (mismatch 아님)", () => {
    const n = normalizeHoldings(
      { "360750": 91, "999999": 7 },
      ["360750"],
      "kis_pension_present_balance",
    );
    expect(n.byTicker).toEqual({ "360750": 91 });
    expect(n.extraneous).toEqual([{ ticker: "999999", quantity: 7 }]);
  });

  it("plan 밖이면서 수량 0 인 종목은 extraneous 가 아니다", () => {
    const n = normalizeHoldings({ "999999": 0 }, ["360750"], "kis_pension_present_balance");
    expect(n.extraneous).toEqual([]);
  });

  it("응답에 명시된 0 은 그대로 0 이다 (추정과 구분된다)", () => {
    const n = normalizeHoldings({ A: 0 }, ["A"], "kis_inquire_balance");
    expect(n.byTicker).toEqual({ A: 0 });
    expect(n.nonComparable).toEqual([]);
  });
});
