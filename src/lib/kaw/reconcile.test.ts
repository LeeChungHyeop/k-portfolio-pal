/**
 * Reconciliation — Phase 0 의 합격 기준.
 *
 * IRP 2026-10-02 사례는 docs/mirae-export-recollection.md §9 의 **실측값**으로 고정한다:
 *   R4  holdings delta  360750 +24 / 438080 +10 / 367380 +29 / 0167A0 −37 / 0181B0 −67
 *   R7  net settlement cash outflow 260,585
 *   R14 보유수량 91 / 103 / 29, 예수금 2,458 (KIS 4경로 일치)
 *   R9  +106 은 settlement adjustment 로 설명되지 않는다
 *
 * 그리고 §9 가 하지 **않은** 주장을 이 모듈도 하지 않는지 본다:
 *   · 전이 날짜를 2026-10-07 로 단정하지 않는다 (구간으로만 말한다)
 *   · 한국투자 관측을 미래에셋 plan 에 붙이지 않는다 (instance 불일치)
 *   · +106 을 cashflow 로 바꾸지 않는다 (차액으로만 보고한다)
 */
import { describe, it, expect } from "vitest";
import type { BrokerAccountInstance } from "./broker-account";
import {
  WEEKDAY_GRACE_DAYS,
  addWeekdays,
  aggregateLedgerDelta,
  candidateEventIds,
  classifyExecutionEvidence,
  discoveryWindow,
  planUniverse,
  reconcilePlan,
  settlementEvidence,
  tplus2Weekday,
  type ReconcileEventInput,
} from "./reconcile";
import type { PlanRowMeta, RebalancePlan } from "./rebalance-plan";
import {
  CAPTURE_HASH_VERSION,
  captureId,
  capturePayloadHash,
  groupCaptures,
  observationRowId,
  type Capture,
  type CapturePartInput,
  type ObservationPart,
} from "./settlement-observation";

// ── 계좌 레지스트리 ────────────────────────────────────────────────────────
// 실제 역사 중 확실히 아는 것만: IRP 실물이전 2026-10-09 (half-open 경계).

const IRP_MIRAE: BrokerAccountInstance = {
  id: "bai:m1rae1rp",
  label: "미래에셋 IRP",
  broker: "miraeasset",
  logicalAccountType: "irp",
  activeFrom: "2025-12-29",
  activeTo: "2026-10-09",
};
const IRP_KIS: BrokerAccountInstance = {
  id: "bai:k1s1rp29",
  label: "한국투자 IRP",
  broker: "kis",
  productCode: "29",
  logicalAccountType: "irp",
  activeFrom: "2026-10-09",
};
const REGISTRY = [IRP_MIRAE, IRP_KIS];

// ── plan fixture (§9 IRP 2026-10-02) ──────────────────────────────────────

const ROWS: Record<string, PlanRowMeta> = {
  r_us: { assetId: "us", etfName: "TIGER 미국S&P500", label: "미국주식", ticker: "360750", orphaned: false },
  r_mix: { assetId: "mix", etfName: "ACE 미국S&P500미국채혼합50액티브", label: "혼합", ticker: "438080", orphaned: false },
  r_nas: { assetId: "nas", etfName: "ACE 미국나스닥100", label: "나스닥", ticker: "367380", orphaned: false },
  r_ai: { assetId: "ai", etfName: "SOL AI반도체TOP2플러스", label: "AI반도체", ticker: "0167A0", orphaned: false },
  r_mem: { assetId: "mem", etfName: "HANARO 미국AI메모리반도체TOP4+", label: "메모리", ticker: "0181B0", orphaned: false },
};

const PRE = { r_us: 67, r_mix: 93, r_nas: 0, r_ai: 37, r_mem: 67 };
const PLANNED = { r_us: 91, r_mix: 103, r_nas: 29, r_ai: 0, r_mem: 0 };

function plan(over: Partial<RebalancePlan> = {}): RebalancePlan {
  return {
    id: "plan:cpl:irp1002",
    completionId: "cpl:irp1002",
    accountType: "irp",
    broker: "miraeasset",
    accountInstanceId: IRP_MIRAE.id,
    planDate: "2026-10-02",
    recordedAt: "2026-10-02T02:30:00.000Z",
    dateMode: "today",
    preBasis: "session_snapshot",
    preQuantities: { ...PRE },
    preCash: 262_937,
    preCashAtRecord: 262_937,
    plannedQuantities: { ...PLANNED },
    assertedPostCash: 2_352,
    rowMeta: ROWS,
    priceMode: "live",
    priceEvidence: {},
    planPayloadHash: "p1|x",
    hashVersion: 1,
    actor: "hyeobi",
    ...over,
  };
}

// ── capture fixture ───────────────────────────────────────────────────────

function makeCapture(args: {
  instanceId: string;
  stateAsOf: string;
  holdings?: Record<string, number> | null;
  cash?: number | null;
  observedAt?: string;
  holdingsSource?: string;
  holdingsCompleteness?: CapturePartInput["holdingsCompleteness"];
  settlementBasis?: CapturePartInput["settlementBasis"];
}): Capture {
  const parts: CapturePartInput[] = [];
  if (args.holdings !== undefined && args.holdings !== null) {
    parts.push({
      sourceType: args.holdingsSource ?? "kis_pension_present_balance",
      stateAsOfBasis: "observation_date",
      settlementBasis: args.settlementBasis ?? "settlement",
      holdings: args.holdings,
      holdingsCompleteness: args.holdingsCompleteness ?? "non_zero_only",
      cash: null,
    });
  }
  if (args.cash !== undefined && args.cash !== null) {
    parts.push({
      sourceType: "kis_pension_deposit",
      stateAsOfBasis: "observation_date",
      settlementBasis: "settlement",
      holdings: null,
      holdingsCompleteness: "unknown",
      cash: args.cash,
    });
  }
  const capId = captureId(args.instanceId, args.stateAsOf, parts);
  const hash = capturePayloadHash(args.instanceId, args.stateAsOf, parts);
  const rows: ObservationPart[] = parts.map((p) => ({
    id: observationRowId(capId, p.sourceType),
    captureId: capId,
    accountType: "irp",
    broker: args.instanceId === IRP_KIS.id ? "kis" : "miraeasset",
    accountInstanceId: args.instanceId,
    observedAt: args.observedAt ?? `${args.stateAsOf}T01:00:00.000Z`,
    stateAsOf: args.stateAsOf,
    stateAsOfBasis: p.stateAsOfBasis,
    settlementBasis: p.settlementBasis,
    sourceType: p.sourceType,
    holdings: p.holdings,
    holdingsCompleteness: p.holdingsCompleteness,
    cash: p.cash,
    acquisitionCost: null,
    accountTotal: null,
    capturePayloadHash: hash,
    hashVersion: CAPTURE_HASH_VERSION,
    actor: "hyeobi",
  }));
  return groupCaptures(rows)[0];
}

const event = (over: Partial<ReconcileEventInput> = {}): ReconcileEventInput => ({
  id: "rev:irp:2026-10-02",
  accountType: "irp",
  eventDate: "2026-10-02",
  transactions: [],
  ...over,
});

const txn = (
  ticker: string,
  side: "buy" | "sell",
  quantity: number,
  settlementDate: string | null = null,
) => ({ source: "miraeasset_retirement_web", ticker, side, quantity, settlementDate });

// ── 날짜 산술 ─────────────────────────────────────────────────────────────

describe("평일 가산 — 공휴일 달력을 쓰지 않는다", () => {
  it("주말을 건너뛴다", () => {
    // 2026-10-02 는 금요일.
    expect(addWeekdays("2026-10-02", 1)).toBe("2026-10-05");
    expect(addWeekdays("2026-10-02", 2)).toBe("2026-10-06");
  });

  it("tplus2Weekday 는 평일 2일 뒤 (결제일의 추정이며 사실이 아니다)", () => {
    expect(tplus2Weekday("2026-10-02")).toBe("2026-10-06");
  });

  it("grace 는 5 평일이다", () => {
    expect(WEEKDAY_GRACE_DAYS).toBe(5);
    expect(addWeekdays(tplus2Weekday("2026-10-02"), WEEKDAY_GRACE_DAYS)).toBe("2026-10-13");
  });
});

// ── discovery / settlement 분리 (순환 제거) ──────────────────────────────

describe("discoveryWindow 는 plan 만으로 계산한다", () => {
  it("이벤트도 결제일도 보지 않는다", () => {
    const w = discoveryWindow(plan());
    expect(w).toEqual({ from: "2026-10-02", to: "2026-10-13", basis: "weekday_inferred" });
  });

  it("settlementEvidence 는 **후보가 확정된 뒤** 보고된 결제일로 정밀화한다", () => {
    const linked = [event({ transactions: [txn("360750", "buy", 24, "2026-10-07")] })];
    const ev = settlementEvidence(linked, discoveryWindow(plan()));
    expect(ev.reportedSettlementDates).toEqual(["2026-10-07"]);
    expect(ev.window).toEqual({ from: "2026-10-07", to: "2026-10-07", basis: "reported" });
  });

  it("보고된 결제일이 없으면 discovery window 를 쓰고 basis 는 weekday_inferred 다", () => {
    const ev = settlementEvidence([event({ transactions: [txn("360750", "buy", 24)] })], discoveryWindow(plan()));
    expect(ev.window.basis).toBe("weekday_inferred");
    expect(ev.window.to).toBe("2026-10-13");
  });
});

// ── 후보 이벤트 (attribution gate) ───────────────────────────────────────

describe("candidateEventIds — account_type 만으로 붙이지 않는다", () => {
  const w = discoveryWindow(plan());

  it("attribution 이 resolved 이고 instance 가 같으면 후보다", () => {
    const r = candidateEventIds(plan(), w, [event({ transactions: [txn("360750", "buy", 24)] })], REGISTRY);
    expect(r.candidates.map((e) => e.id)).toEqual(["rev:irp:2026-10-02"]);
    expect(r.unattributed).toEqual([]);
  });

  it("attribution 이 ambiguous 면 자동 후보에 넣지 않고 보고만 한다", () => {
    const ambiguousRegistry = [
      IRP_MIRAE,
      { ...IRP_KIS, activeFrom: "2026-01-01", activeTo: undefined },
    ];
    const r = candidateEventIds(
      plan(),
      w,
      [event({ transactions: [{ ...txn("360750", "buy", 24), source: "unregistered" }] })],
      ambiguousRegistry,
    );
    expect(r.candidates).toEqual([]);
    expect(r.unattributed).toHaveLength(1);
    expect(r.unattributed[0].attribution.kind).toBe("ambiguous");
  });

  it("다른 instance 의 이벤트는 otherInstance 로 분리된다", () => {
    const r = candidateEventIds(
      plan(),
      w,
      [
        event({
          id: "rev:irp:2026-10-12",
          eventDate: "2026-10-12",
          transactions: [{ ...txn("360750", "buy", 1), source: "kis_only" }],
        }),
      ],
      REGISTRY,
    );
    expect(r.candidates).toEqual([]);
    expect(r.otherInstance.map((o) => o.eventId)).toEqual(["rev:irp:2026-10-12"]);
  });

  it("discovery window 밖 이벤트는 보지 않는다", () => {
    const r = candidateEventIds(
      plan(),
      w,
      [event({ id: "rev:irp:2026-11-02", eventDate: "2026-11-02", transactions: [txn("360750", "buy", 1)] })],
      REGISTRY,
    );
    expect(r.candidates).toEqual([]);
    expect(r.unattributed).toEqual([]);
  });
});

describe("aggregateLedgerDelta", () => {
  it("매수 +, 매도 − 로 합산하고 0 은 뺀다", () => {
    const d = aggregateLedgerDelta([
      event({ transactions: [txn("360750", "buy", 24), txn("0167A0", "sell", 37)] }),
      event({ id: "e2", transactions: [txn("360750", "sell", 24)] }),
    ]);
    expect(d).toEqual({ "0167A0": -37 });
  });
});

describe("classifyExecutionEvidence", () => {
  const expected = { A: 10, B: -5 };

  it("PRE 를 모르면 indeterminate (역산하지 않는다)", () => {
    expect(classifyExecutionEvidence(null, { A: 10 }, true)).toBe("indeterminate");
  });

  it("이벤트가 없으면 none", () => {
    expect(classifyExecutionEvidence(expected, {}, false)).toBe("none");
  });

  it("완전 일치는 complete", () => {
    expect(classifyExecutionEvidence(expected, { A: 10, B: -5 }, true)).toBe("complete");
  });

  it("같은 방향 부분집합은 partial", () => {
    expect(classifyExecutionEvidence(expected, { A: 6 }, true)).toBe("partial");
  });

  it("방향 역전 / 초과 / 미지 종목은 conflicting", () => {
    expect(classifyExecutionEvidence(expected, { A: -1 }, true)).toBe("conflicting");
    expect(classifyExecutionEvidence(expected, { A: 11 }, true)).toBe("conflicting");
    expect(classifyExecutionEvidence(expected, { Z: 1 }, true)).toBe("conflicting");
  });
});

// ── §9 IRP 사례 ───────────────────────────────────────────────────────────

describe("IRP 2026-10-02 — §9 실측값 재현", () => {
  it("plan universe 와 기대 delta 가 R4 와 일치한다", () => {
    expect(planUniverse(plan())).toEqual(["0167A0", "0181B0", "360750", "367380", "438080"]);
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-02",
    });
    expect(r.expectedDeltaByTicker).toEqual({
      "360750": 24,
      "438080": 10,
      "367380": 29,
      "0167A0": -37,
      "0181B0": -67,
    });
  });

  it("pre_cash − asserted_post_cash = 260,585 (R7)", () => {
    const p = plan();
    expect((p.preCash ?? 0) - p.assertedPostCash).toBe(260_585);
  });

  it("저장 직후: 체결 증거 없음 · 결제 미관측 · 원장 신규 0", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-02",
    });
    expect(r.executionEvidence).toBe("none");
    expect(r.settlementCheck).toBe("unobserved");
    expect(r.linkedEventIds).toEqual([]);
    expect(r.ledgerDeltaByTicker).toEqual({});
    expect(r.observedTransitionWindow).toBeNull();
    expect(r.settlementWindow.basis).toBe("weekday_inferred");
  });

  it("미래에셋 과거잔고(H)는 자동 판정에 들어오지 않는다 (D6)", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-07",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          holdingsSource: "broker_historical_balance",
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-07",
    });
    expect(r.settlementCheck).toBe("unobserved");
    expect(r.classifiedCaptures).toEqual([]);
  });

  it("2026-10-09 한국투자 관측은 instance 가 달라 **대조하지 않는다** (005 동작)", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_KIS.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          cash: 2_458,
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.settlementCheck).toBe("unobserved");
    expect(r.cashDivergence).toBeNull();
    expect(r.crossInstanceCaptures).toHaveLength(1);
    expect(r.crossInstanceCaptures[0].match.kind).toBe("cross_instance_unverified");
  });

  it("같은 instance 의 관측이면 POST 일치 + 현금 차이 +106 을 보고한다 (R9/R14)", () => {
    // lineage(006+) 가 들어오면 위 cross-instance 가 이 경로로 합쳐진다.
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          cash: 2_458,
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.settlementCheck).toBe("post_state_cash_divergent");
    expect(r.cashDivergence).toBe(106);
    // 전량매도 2종목이 응답에 없어도 non_zero_only 로 0 normalize 돼 비교가 성립한다.
    expect(r.comparability).toBe("full");
    // 체결 증거는 여전히 없다 — settlement 가 execution 을 올리지 않는다.
    expect(r.executionEvidence).toBe("none");
  });

  it("전이 날짜를 2026-10-07 로 단정하지 않고 **구간**으로 말한다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          cash: 2_458,
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    // PRE 관측이 없으므로 하한은 plan_date 다 — 약한 하한임을 그대로 드러낸다.
    expect(r.observedTransitionWindow).toEqual({ after: "2026-10-02", atOrBefore: "2026-10-09" });
  });

  it("나중에 체결 증거가 들어오면 같은 입력으로 reconciled 가 된다 (backfill 불필요)", () => {
    const events = [
      event({
        transactions: [
          txn("360750", "buy", 24, "2026-10-07"),
          txn("438080", "buy", 10, "2026-10-07"),
          txn("367380", "buy", 29, "2026-10-07"),
          txn("0167A0", "sell", 37, "2026-10-07"),
          txn("0181B0", "sell", 67, "2026-10-07"),
        ],
      }),
    ];
    const r = reconcilePlan({
      plan: plan(),
      events,
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          cash: 2_458,
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.executionEvidence).toBe("complete");
    expect(r.linkedEventIds).toEqual(["rev:irp:2026-10-02"]);
    expect(r.settlementWindow).toEqual({ from: "2026-10-07", to: "2026-10-07", basis: "reported" });
    expect(r.remainingDeltaByTicker).toEqual({});
  });
});

// ── 축 2 상태 전이 ────────────────────────────────────────────────────────

describe("settlementCheck — 이른 관측을 mismatch 로 만들지 않는다", () => {
  const preCapture = (stateAsOf: string) =>
    makeCapture({
      instanceId: IRP_MIRAE.id,
      stateAsOf,
      holdings: { "360750": 67, "438080": 93, "0167A0": 37, "0181B0": 67 },
    });

  it("T+1 에 PRE 상태가 보이면 pre_state_observed (정상)", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [preCapture("2026-10-05")],
      brokerAccounts: REGISTRY,
      today: "2026-10-05",
    });
    expect(r.settlementCheck).toBe("pre_state_observed");
    expect(r.mismatchTriggers).toEqual([]);
  });

  it("weekday_inferred window 가 지나도 overdue 일 뿐 mismatch 가 아니다 (D4)", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [preCapture("2026-10-05")],
      brokerAccounts: REGISTRY,
      today: "2026-10-20",
    });
    expect(r.settlementWindow.basis).toBe("weekday_inferred");
    expect(r.settlementCheck).toBe("settlement_overdue");
    expect(r.mismatchTriggers).toEqual([]);
  });

  it("reported window 가 지났는데 POST 가 아니면 state_mismatch (M1)", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [event({ transactions: [txn("360750", "buy", 24, "2026-10-07")] })],
      captures: [preCapture("2026-10-08")],
      brokerAccounts: REGISTRY,
      today: "2026-10-20",
    });
    expect(r.settlementWindow.basis).toBe("reported");
    expect(r.settlementCheck).toBe("state_mismatch");
    expect(r.mismatchTriggers).toContain("M1_reported_window_elapsed");
  });

  it("체결 증거가 모순이면 state_mismatch (M2)", () => {
    const r = reconcilePlan({
      plan: plan(),
      // 매수 계획인데 매도가 들어왔다 → conflicting
      events: [event({ transactions: [txn("360750", "sell", 5)] })],
      captures: [preCapture("2026-10-05")],
      brokerAccounts: REGISTRY,
      today: "2026-10-05",
    });
    expect(r.executionEvidence).toBe("conflicting");
    expect(r.settlementCheck).toBe("state_mismatch");
    expect(r.mismatchTriggers).toContain("M2_conflicting_execution");
  });

  it("중간 상태가 원장으로 설명되면 intermediate_consistent", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [event({ transactions: [txn("360750", "buy", 24)] })],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-06",
          holdings: { "360750": 91, "438080": 93, "0167A0": 37, "0181B0": 67 },
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-06",
    });
    expect(r.executionEvidence).toBe("partial");
    expect(r.settlementCheck).toBe("intermediate_state_observed");
    expect(r.intermediateDetail).toBe("intermediate_consistent");
    expect(r.mismatchTriggers).toEqual([]);
  });

  it("설명되지 않는 중간 상태도 window 안에서는 mismatch 가 아니다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-06",
          holdings: { "360750": 80, "438080": 93, "0167A0": 37, "0181B0": 67 },
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-06",
    });
    expect(r.settlementCheck).toBe("intermediate_state_observed");
    expect(r.intermediateDetail).toBe("intermediate_unexplained");
    expect(r.mismatchTriggers).toEqual([]);
  });

  it("기대와 반대 방향으로 움직이면 M3", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          // 360750 은 +24 기대인데 줄었다
          stateAsOf: "2026-10-06",
          holdings: { "360750": 50, "438080": 93, "0167A0": 37, "0181B0": 67 },
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-06",
    });
    expect(r.settlementCheck).toBe("state_mismatch");
    expect(r.mismatchTriggers).toContain("M3_direction_reversed");
  });

  it("cash 가 같은 capture 에 없으면 divergence 를 계산하지 않는다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        // holdings 만 있는 partial capture (TTTC0506R 실패)
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
        }),
        // 더 이른 날짜의 cash — **끌어오지 않는다**
        makeCapture({ instanceId: IRP_MIRAE.id, stateAsOf: "2026-10-08", cash: 999 }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.settlementCheck).toBe("post_state_verified");
    expect(r.cashDivergence).toBeNull();
  });

  it("거래기준(trade) 화면은 전이 판정에 쓰지 않는다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          settlementBasis: "trade",
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.settlementCheck).toBe("unobserved");
  });
});

// ── 비교 가능성 / 보고 전용 항목 ─────────────────────────────────────────

describe("comparability 와 보고 전용 항목", () => {
  it("생략 의미가 미확정인 source 면 0 으로 추정하지 않고 partial 이 된다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29 },
          holdingsSource: "kis_inquire_balance",
          holdingsCompleteness: "unknown",
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.comparability).toBe("partial");
    expect(r.nonComparableTickers).toEqual(["0167A0", "0181B0"]);
    expect(r.settlementCheck).toBe("unobserved");
    expect(r.warnings).toContain("non_comparable_holdings");
  });

  it("plan 밖 ticker 는 extraneous 로 보고되고 mismatch 가 아니다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [],
      captures: [
        makeCapture({
          instanceId: IRP_MIRAE.id,
          stateAsOf: "2026-10-09",
          holdings: { "360750": 91, "438080": 103, "367380": 29, "999999": 3 },
          cash: 2_458,
        }),
      ],
      brokerAccounts: REGISTRY,
      today: "2026-10-09",
    });
    expect(r.extraneousPositions).toEqual([{ ticker: "999999", quantity: 3 }]);
    expect(r.settlementCheck).toBe("post_state_cash_divergent");
  });

  it("ticker 없는 행이 있으면 partial 이고 그 행을 드러낸다", () => {
    const rows = { ...ROWS, r_x: { assetId: "x", etfName: "미등록", label: "미등록", ticker: null, orphaned: false } };
    const r = reconcilePlan({
      plan: plan({
        rowMeta: rows,
        plannedQuantities: { ...PLANNED, r_x: 4 },
        preQuantities: { ...PRE, r_x: 0 },
      }),
      events: [],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-02",
    });
    expect(r.comparability).toBe("partial");
    expect(r.unmappableRows).toEqual([{ rowId: "r_x", etfName: "미등록", quantity: 4 }]);
  });

  it("PRE 를 모르면 executionEvidence 는 indeterminate 다", () => {
    const r = reconcilePlan({
      plan: plan({ preBasis: "unknown", preQuantities: null, preCash: null }),
      events: [event({ transactions: [txn("360750", "buy", 24)] })],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-02",
    });
    expect(r.effectivePreBasis).toBe("unknown");
    expect(r.executionEvidence).toBe("indeterminate");
    expect(r.expectedDeltaByTicker).toBeNull();
    expect(r.remainingDeltaByTicker).toBeNull();
  });
});

// ── plan 1 : event N ─────────────────────────────────────────────────────

describe("plan 하나에 여러 이벤트 (복수 거래일 실행)", () => {
  const partialEvents = [
    event({ id: "rev:irp:2026-10-02", transactions: [txn("360750", "buy", 24), txn("0167A0", "sell", 37)] }),
    event({
      id: "rev:irp:2026-10-06",
      eventDate: "2026-10-06",
      transactions: [txn("438080", "buy", 10), txn("0181B0", "sell", 67)],
    }),
  ];

  it("두 이벤트가 모두 연결되고 delta 가 합산된다", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: partialEvents,
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-06",
    });
    expect(r.linkedEventIds).toEqual(["rev:irp:2026-10-02", "rev:irp:2026-10-06"]);
    expect(r.executionEvidence).toBe("partial");
    // 367380 +29 만 남는다
    expect(r.remainingDeltaByTicker).toEqual({ "367380": 29 });
  });

  it("잔량까지 들어오면 complete", () => {
    const r = reconcilePlan({
      plan: plan(),
      events: [
        ...partialEvents,
        event({ id: "rev:irp:2026-10-07", eventDate: "2026-10-07", transactions: [txn("367380", "buy", 29)] }),
      ],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-10-07",
    });
    expect(r.executionEvidence).toBe("complete");
    expect(r.remainingDeltaByTicker).toEqual({});
  });

  it("exclude overlay 로 후보에서 빼고 include 로 추가할 수 있다 (006+)", () => {
    const outside = event({
      id: "rev:irp:2026-11-02",
      eventDate: "2026-11-02",
      transactions: [txn("367380", "buy", 29)],
    });
    const r = reconcilePlan({
      plan: plan(),
      events: [...partialEvents, outside],
      captures: [],
      brokerAccounts: REGISTRY,
      today: "2026-11-02",
      eventLinks: { exclude: ["rev:irp:2026-10-06"], include: ["rev:irp:2026-11-02"] },
    });
    expect(r.linkedEventIds).toEqual(["rev:irp:2026-10-02", "rev:irp:2026-11-02"]);
  });
});

// ── 결정성 ───────────────────────────────────────────────────────────────

describe("결정성", () => {
  it("입력 순서가 달라도 결과가 같다", () => {
    const events = [
      event({ id: "e1", transactions: [txn("360750", "buy", 24)] }),
      event({ id: "e2", eventDate: "2026-10-06", transactions: [txn("438080", "buy", 10)] }),
    ];
    const captures = [
      makeCapture({ instanceId: IRP_MIRAE.id, stateAsOf: "2026-10-05", holdings: { "360750": 67, "438080": 93, "0167A0": 37, "0181B0": 67 } }),
      makeCapture({ instanceId: IRP_MIRAE.id, stateAsOf: "2026-10-06", holdings: { "360750": 91, "438080": 93, "0167A0": 37, "0181B0": 67 } }),
    ];
    const a = reconcilePlan({ plan: plan(), events, captures, brokerAccounts: REGISTRY, today: "2026-10-06" });
    const b = reconcilePlan({
      plan: plan(),
      events: [...events].reverse(),
      captures: [...captures].reverse(),
      brokerAccounts: REGISTRY,
      today: "2026-10-06",
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
