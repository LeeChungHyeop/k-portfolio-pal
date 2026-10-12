/**
 * plan API 의 **순수 검증부**를 고정한다. Supabase 없이 돌아가는 부분만 본다 —
 * 세션 인증·insert 는 기존 /api/data · /api/ledger 와 같은 경로라 여기서 다시 검증하지
 * 않는다(production 시크릿으로만 재현되는 영역이다. docs/ledger-handoff.md §8-3).
 *
 * 여기서 지키는 것은 네 가지다:
 *   1. 서버가 **해시를 다시 계산**하고, 클라이언트가 보낸 값을 믿지 않는다
 *   2. family_code / profile / actor / id / fingerprint 를 **본문에서 받지 않는다**
 *   3. **PRE 역산 금지**를 400 으로 또렷하게 거부한다 (500 으로 흘리지 않는다)
 *   4. PK 충돌을 **해시가 같을 때만** ACK 로 번역한다
 */
import { describe, it, expect } from "vitest";
import {
  PLAN_QUERY_MAX_IDS,
  parseCompletionIds,
  planConflictOutcome,
  validatePlanBody,
} from "./plan-server";
import { PLAN_HASH_VERSION, planPayloadHash, type RebalancePlan } from "./rebalance-plan";

const session = { code: "soye", profile: "hyeobi" };

const rowMeta = {
  kr: { assetId: "kr", etfName: "TIGER 200", label: "한국주식", ticker: "102110", orphaned: false },
};
const priceEvidence = {
  kr: { ticker: "102110", price: 12_345, source: "kis-live" as const, asOf: "2026-10-12" },
};

/** 유효한 본문 1개. 해시는 **실제로** 계산해 넣는다(고정 문자열을 쓰면 규칙 변경을 놓친다). */
function body(over: Partial<RebalancePlan> = {}): Record<string, unknown> {
  const core = {
    accountInstanceId: "bai:1a2b3c4d",
    planDate: "2026-10-12",
    preBasis: "session_snapshot" as const,
    preQuantities: { kr: 10 },
    preCash: 3_621,
    plannedQuantities: { kr: 14 },
    assertedPostCash: 1_200,
    targetWeights: { kr: 0.4 },
    rowMeta,
    priceEvidence,
    ...over,
  };
  const plan = {
    id: "plan:c-0001",
    completionId: "c-0001",
    accountType: "isa",
    broker: "미래에셋",
    brokerProductCode: null,
    accountRefFingerprint: null,
    recordedAt: "2026-10-12T06:00:00.000Z",
    dateMode: "today",
    preSessionId: "sess-1",
    preSessionStartedAt: "2026-10-12T05:59:00.000Z",
    preProfileKey: "growth",
    preCashAtRecord: 3_621,
    preDiscardReason: null,
    appStateQuantitiesAtRecord: { kr: 14 },
    appStateCashAtRecord: 1_200,
    projectedPostCash: 1_180,
    frozenInvested: 1_000_000,
    frozenInvestedBasis: "entry_freeze",
    baseAmount: 1_003_621,
    priceMode: "live",
    hashVersion: PLAN_HASH_VERSION,
    actor: "hyeobi",
    ...core,
    ...over,
  } as Record<string, unknown>;
  plan.planPayloadHash = planPayloadHash(core as Parameters<typeof planPayloadHash>[0]);
  return plan;
}

const ok = (b: Record<string, unknown>) => {
  const v = validatePlanBody(b, session);
  if (!v.ok) throw new Error(`유효해야 하는데 거부됨: ${v.error}`);
  return v.row;
};

const err = (b: unknown) => {
  const v = validatePlanBody(b, session);
  expect(v.ok).toBe(false);
  return v.ok ? "" : v.error;
};

describe("validatePlanBody — 유효한 본문", () => {
  it("DB 행으로 변환된다", () => {
    const row = ok(body());
    expect(row.id).toBe("plan:c-0001");
    expect(row.completion_id).toBe("c-0001");
    expect(row.account_type).toBe("isa");
    expect(row.date_mode).toBe("today");
    expect(row.planned_quantities).toEqual({ kr: 14 });
    expect(row.asserted_post_cash).toBe(1_200);
    expect(row.hash_version).toBe(PLAN_HASH_VERSION);
  });

  it("`{ plan }` 래퍼로 감싸도 받는다 (envelope 는 본문 전체를 planPayload 로 쓴다)", () => {
    const v = validatePlanBody({ plan: body() }, session);
    expect(v.ok).toBe(true);
  });

  it("preBasis=unknown 은 PRE 없이 통과한다", () => {
    const row = ok(body({ preBasis: "unknown", preQuantities: null, preCash: null }));
    expect(row.pre_basis).toBe("unknown");
    expect(row.pre_quantities).toBeNull();
    expect(row.pre_cash).toBeNull();
  });

  it("preCash=null(당시 미입력)은 session_snapshot 에서도 허용된다", () => {
    const row = ok(body({ preCash: null }));
    expect(row.pre_cash).toBeNull();
    // 0 으로 채우지 않는다 — 모르는 것과 0 은 다르다.
    expect(row.pre_cash).not.toBe(0);
  });

  it("past 모드를 저장한다", () => {
    expect(ok(body({ dateMode: "past" })).date_mode).toBe("past");
  });
});

describe("validatePlanBody — 세션이 유일한 근거다", () => {
  it("본문의 family_code / profile 을 쓰지 않는다", () => {
    const row = ok({ ...body(), family_code: "침입자", profile: "다른사람" });
    expect(row.family_code).toBe("soye");
    expect(row.profile).toBe("hyeobi");
  });

  it("본문의 actor 를 쓰지 않는다", () => {
    expect(ok(body({ actor: "스푸핑" })).actor).toBe("hyeobi");
  });

  it("본문의 id 를 믿지 않고 completionId 에서 다시 만든다", () => {
    expect(ok({ ...body(), id: "plan:엉뚱한값" }).id).toBe("plan:c-0001");
  });

  it("account_ref_fingerprint 는 항상 null 이다 (계산은 Phase 3)", () => {
    expect(ok(body({ accountRefFingerprint: "a1|deadbeef" })).account_ref_fingerprint).toBeNull();
  });
});

describe("validatePlanBody — 해시를 서버가 다시 계산한다", () => {
  it("해시가 본문과 다르면 거부한다", () => {
    expect(err({ ...body(), planPayloadHash: "p1|0000000000000000" })).toMatch(/일치하지 않습니다/);
  });

  it("경제값만 바꿔 해시를 그대로 두면 거부된다", () => {
    const b = body();
    // 해시를 다시 계산하지 않고 수량만 바꾼다 = 클라이언트 버그/변조 모양.
    b.plannedQuantities = { kr: 99 };
    expect(err(b)).toMatch(/일치하지 않습니다/);
  });

  it("identity·volatile 값을 바꿔도 해시는 그대로다 (재시도가 통과한다)", () => {
    const b = body();
    b.recordedAt = "2026-10-12T23:59:59.000Z";
    b.brokerProductCode = "22";
    const v = validatePlanBody(b, session);
    expect(v.ok).toBe(true);
  });

  it("해시가 없으면 거부한다", () => {
    const b = body();
    delete b.planPayloadHash;
    expect(err(b)).toMatch(/planPayloadHash/);
  });

  it("버전 prefix 가 hashVersion 과 다르면 거부한다", () => {
    const b = body();
    b.planPayloadHash = String(b.planPayloadHash).replace(/^p1\|/, "p2|");
    expect(err(b)).toMatch(/버전 prefix/);
  });

  it("서버가 모르는 해시 버전은 거부한다 (조용히 재계산하지 않는다)", () => {
    expect(err(body({ hashVersion: PLAN_HASH_VERSION + 1 }))).toMatch(/hashVersion/);
  });
});

describe("validatePlanBody — PRE 역산 금지 (400 으로 거부한다)", () => {
  it("unknown 인데 preQuantities 가 있으면 거부한다", () => {
    const b = body({ preBasis: "unknown", preCash: null });
    b.preQuantities = { kr: 10 };
    b.planPayloadHash = planPayloadHash({
      accountInstanceId: "bai:1a2b3c4d", planDate: "2026-10-12", preBasis: "unknown",
      preQuantities: { kr: 10 }, preCash: null, plannedQuantities: { kr: 14 },
      assertedPostCash: 1_200, targetWeights: { kr: 0.4 }, rowMeta, priceEvidence,
    });
    // 해시가 맞더라도 거부한다 — 모양이 아니라 **정책** 위반이다.
    expect(err(b)).toMatch(/preBasis=unknown/);
  });

  it("unknown 인데 preCash 가 있으면 거부한다", () => {
    const b = body({ preBasis: "unknown", preQuantities: null });
    b.preCash = 0;
    b.planPayloadHash = planPayloadHash({
      accountInstanceId: "bai:1a2b3c4d", planDate: "2026-10-12", preBasis: "unknown",
      preQuantities: null, preCash: 0, plannedQuantities: { kr: 14 },
      assertedPostCash: 1_200, targetWeights: { kr: 0.4 }, rowMeta, priceEvidence,
    });
    expect(err(b)).toMatch(/preBasis=unknown/);
  });

  it("session_snapshot 인데 preQuantities 가 없으면 거부한다", () => {
    expect(err(body({ preBasis: "session_snapshot", preQuantities: null }))).toMatch(
      /preQuantities 가 필요합니다/,
    );
  });
});

describe("validatePlanBody — 그 밖의 거부", () => {
  it.each([
    ["본문이 객체가 아니다", null, /객체가 아닙니다/],
    ["completionId 없음", { ...body(), completionId: "" }, /completionId/],
    ["계좌 유형 오류", { ...body(), accountType: "savings" }, /accountType/],
    ["broker 없음", { ...body(), broker: "" }, /broker/],
    ["instance 없음", { ...body(), accountInstanceId: "" }, /accountInstanceId/],
    ["날짜 모양 오류", { ...body(), planDate: "2026/10/12" }, /YYYY-MM-DD/],
    ["priceMode 오류", { ...body(), priceMode: "guess" }, /priceMode/],
    ["frozen basis 오류", { ...body(), frozenInvestedBasis: "추정" }, /frozenInvestedBasis/],
    ["수량 맵에 문자열", { ...body(), plannedQuantities: { kr: "14" } }, /plannedQuantities/],
    ["rowMeta 없음", { ...body(), rowMeta: null }, /rowMeta/],
  ])("%s → 거부", (_label, b, re) => {
    expect(err(b)).toMatch(re as RegExp);
  });

  it("dateMode=future 는 저장하지 않는다", () => {
    expect(err({ ...body(), dateMode: "future" })).toMatch(/future/);
  });

  it("completionId 에 ':' 가 있으면 거부한다 (id 파싱이 모호해진다)", () => {
    expect(err({ ...body(), completionId: "c:1" })).toMatch(/':'/);
  });

  it("assertedPostCash 는 0 이상의 정수여야 한다", () => {
    for (const v of [-1, 1200.5]) {
      const b = body({ assertedPostCash: v });
      expect(err(b)).toMatch(/assertedPostCash/);
    }
  });

  it("assertedPostCash=0 은 유효하다 (예수금 0원을 직접 입력한 경우)", () => {
    expect(ok(body({ assertedPostCash: 0 })).asserted_post_cash).toBe(0);
  });
});

describe("validatePlanBody — preDiscardReason 화이트리스트", () => {
  // 005 의 kaw_rebalance_plan_pre_discard_chk 와 같은 네 값이다. plan 은 immutable 이라
  // 오타 값이 한 번 들어가면 영구히 남는다.
  it.each(["no_session", "past_date_mode", "date_mode_changed", "instance_changed"])(
    "%s 는 유효하다",
    (reason) => {
      expect(ok(body({ preDiscardReason: reason as never })).pre_discard_reason).toBe(reason);
    },
  );

  it("null 은 정상이다 — 폐기할 일이 없었다는 뜻이다", () => {
    expect(ok(body({ preDiscardReason: null })).pre_discard_reason).toBeNull();
  });

  it("필드가 아예 없어도 null 로 들어간다", () => {
    const b = body();
    delete b.preDiscardReason;
    expect(ok(b).pre_discard_reason).toBeNull();
  });

  it.each(["", " ", "unknown", "PAST_DATE_MODE", "그밖의사유", "no_session "])(
    "%o 는 400 으로 거부한다",
    (reason) => {
      const b = body();
      b.preDiscardReason = reason;
      expect(err(b)).toMatch(/preDiscardReason/);
    },
  );

  it("숫자·객체·배열도 거부한다 — 모양이 틀린 값을 조용히 null 로 바꾸지 않는다", () => {
    for (const v of [1, 0, false, { reason: "no_session" }, ["no_session"]]) {
      const b = body();
      b.preDiscardReason = v;
      expect(err(b)).toMatch(/preDiscardReason/);
    }
  });
});

describe("parseCompletionIds", () => {
  const url = (q: string) => new URL(`https://x/api/rebalance/plan${q}`);

  it("쉼표와 반복 파라미터를 모두 받는다", () => {
    expect(parseCompletionIds(url("?completionId=a,b"))).toEqual(["a", "b"]);
    expect(parseCompletionIds(url("?completionId=a&completionId=b"))).toEqual(["a", "b"]);
  });

  it("중복을 접고 공백을 버린다", () => {
    expect(parseCompletionIds(url("?completionId=a,%20a%20,,b"))).toEqual(["a", "b"]);
  });

  it("비어 있으면 오류다", () => {
    expect(parseCompletionIds(url(""))).toEqual({ error: "completionId 가 필요합니다" });
  });

  it("상한을 넘으면 오류다", () => {
    const many = Array.from({ length: PLAN_QUERY_MAX_IDS + 1 }, (_, i) => `c${i}`).join(",");
    const r = parseCompletionIds(url(`?completionId=${many}`));
    expect(r).toHaveProperty("error");
  });
});

describe("planConflictOutcome — PK 충돌의 번역", () => {
  it("해시가 같으면 재시도다 → ACK", () => {
    expect(planConflictOutcome("p1|aaa", "p1|aaa")).toEqual({ kind: "already_exists" });
  });

  it("해시가 다르면 ACK 하지 않는다 — 같은 completionId 에 다른 계획이다", () => {
    expect(planConflictOutcome("p1|aaa", "p1|bbb")).toEqual({ kind: "hash_mismatch" });
  });

  it("저장된 해시를 못 읽었으면 **모른다** (성공으로 올리지 않는다)", () => {
    expect(planConflictOutcome(null, "p1|aaa")).toEqual({ kind: "unverified" });
    expect(planConflictOutcome(undefined, "p1|aaa")).toEqual({ kind: "unverified" });
  });
});
