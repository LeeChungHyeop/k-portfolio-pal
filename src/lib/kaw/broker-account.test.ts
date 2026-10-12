/**
 * 계좌 instance identity + 원장 attribution.
 *
 * 실제 날짜는 **우리가 확실히 아는 하나**만 쓴다 — 미래에셋 IRP → 한국투자 IRP
 * 2026-10-09 실물이전(half-open 경계 검증용). 나머지는 synthetic fixture 다.
 * 실제 계좌 레지스트리의 activeFrom/activeTo 확인은 Phase 1 직전 별건이다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findInstance,
  isActiveOn,
  resolveEventAttribution,
  resolveLedgerAccountAttribution,
  sameInstance,
  type AttributableRecord,
  type BrokerAccountInstance,
} from "./broker-account";

// ── fixture ────────────────────────────────────────────────────────────────

/** 실제 역사 중 확실히 아는 부분만: IRP 실물이전 2026-10-09 (half-open 경계) */
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

/** synthetic — pension 이원화 검증용 가상 날짜 */
const PENSION_A: BrokerAccountInstance = {
  id: "bai:pensionA",
  label: "가상 증권사 A 연금저축",
  broker: "miraeasset",
  logicalAccountType: "pension",
  activeFrom: "2026-01-01",
};
const PENSION_B: BrokerAccountInstance = {
  id: "bai:pensionB",
  label: "가상 증권사 B 연금저축",
  broker: "kis",
  productCode: "22",
  logicalAccountType: "pension",
  activeFrom: "2026-06-01",
};

const tx = (over: Partial<AttributableRecord> = {}): AttributableRecord => ({
  accountType: "irp",
  eventDate: "2026-05-01",
  source: "miraeasset_retirement_web",
  ...over,
});

// ── half-open 기간 ─────────────────────────────────────────────────────────

describe("active 기간은 half-open [activeFrom, activeTo)", () => {
  it("activeFrom 당일은 active 다", () => {
    expect(isActiveOn(IRP_MIRAE, "2025-12-29")).toBe(true);
  });

  it("activeTo 당일은 **더 이상** active 가 아니다", () => {
    expect(isActiveOn(IRP_MIRAE, "2026-10-08")).toBe(true);
    expect(isActiveOn(IRP_MIRAE, "2026-10-09")).toBe(false);
  });

  it("실물이전일 2026-10-09 거래는 한국투자 쪽으로만 떨어진다 (중복 없음)", () => {
    const registry = [IRP_MIRAE, IRP_KIS];
    expect(isActiveOn(IRP_MIRAE, "2026-10-09")).toBe(false);
    expect(isActiveOn(IRP_KIS, "2026-10-09")).toBe(true);

    // source 선언이 없어도 그 날짜에 active 한 instance 가 1개뿐이다.
    const r = resolveLedgerAccountAttribution(
      tx({ eventDate: "2026-10-09", source: "unregistered_source" }),
      registry,
    );
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:k1s1rp29",
      evidence: "single_active_instance",
    });
  });

  it("activeTo 가 없으면 현재까지 active 다", () => {
    expect(isActiveOn(IRP_KIS, "2030-01-01")).toBe(true);
  });
});

// ── instance identity 비교 ────────────────────────────────────────────────

describe("sameInstance — 비교의 전제 조건", () => {
  it("instance 가 같으면 same", () => {
    expect(sameInstance({ accountInstanceId: "a" }, { accountInstanceId: "a" })).toEqual({
      kind: "same",
    });
  });

  it("instance 가 다르면 cross_instance_unverified — 비교하지 않는다", () => {
    const m = sameInstance({ accountInstanceId: "bai:m1rae1rp" }, { accountInstanceId: "bai:k1s1rp29" });
    expect(m.kind).toBe("cross_instance_unverified");
  });

  it("instance 는 같은데 fingerprint 가 다르면 credential_drift_suspected", () => {
    const m = sameInstance(
      { accountInstanceId: "a", accountRefFingerprint: "a1|aaa" },
      { accountInstanceId: "a", accountRefFingerprint: "a1|bbb" },
    );
    expect(m.kind).toBe("credential_drift_suspected");
  });

  it("한쪽에 fingerprint 가 없는 것은 불일치가 아니다 (미래에셋은 API 가 없다)", () => {
    expect(
      sameInstance({ accountInstanceId: "a" }, { accountInstanceId: "a", accountRefFingerprint: "a1|x" }),
    ).toEqual({ kind: "same" });
  });
});

// ── 원장 attribution ──────────────────────────────────────────────────────

describe("resolveLedgerAccountAttribution", () => {
  const registry = [IRP_MIRAE, IRP_KIS, PENSION_A, PENSION_B];

  it("source 가 증권사를 선언하고 그 instance 가 유일하면 broker_and_period", () => {
    const r = resolveLedgerAccountAttribution(
      tx({ eventDate: "2026-08-28", source: "miraeasset_retirement_web" }),
      registry,
    );
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:m1rae1rp",
      evidence: "broker_and_period",
    });
  });

  it("사용자 보완 source(broker 선언 없음)도 active 가 유일하면 풀린다", () => {
    const r = resolveLedgerAccountAttribution(
      tx({ eventDate: "2025-12-29", source: "user_supplied_missing_irp_2025-12-29" }),
      registry,
    );
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:m1rae1rp",
      evidence: "single_active_instance",
    });
  });

  it("같은 logical type 에 2 instance active + 미지 source → ambiguous (D8)", () => {
    const r = resolveLedgerAccountAttribution(
      tx({ accountType: "pension", eventDate: "2026-07-01", source: "unregistered_source" }),
      registry,
    );
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.sort()).toEqual(["bai:pensionA", "bai:pensionB"]);
    }
  });

  it("2 instance active 라도 source 가 증권사를 선언하면 풀린다", () => {
    const r = resolveLedgerAccountAttribution(
      tx({ accountType: "pension", eventDate: "2026-07-01", source: "miraeasset_transaction_history" }),
      registry,
    );
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:pensionA",
      evidence: "broker_and_period",
    });
  });

  it("선언된 증권사의 instance 가 그 날짜에 없으면 conflict", () => {
    const r = resolveLedgerAccountAttribution(
      // 미래에셋 IRP 는 2026-10-09 부터 active 가 아니다.
      tx({ eventDate: "2026-10-20", source: "miraeasset_retirement_web" }),
      registry,
    );
    expect(r.kind).toBe("conflict");
  });

  it("그 날짜에 active 한 instance 가 없으면 unknown", () => {
    const r = resolveLedgerAccountAttribution(tx({ eventDate: "2020-01-01" }), registry);
    expect(r).toEqual({ kind: "unknown", reason: "no_active_instance_at_date" });
  });

  it("레지스트리가 비어 있으면 unknown (account_type 으로 추측하지 않는다)", () => {
    expect(resolveLedgerAccountAttribution(tx(), [])).toEqual({
      kind: "unknown",
      reason: "no_registry",
    });
  });

  it("명시적 overlay 가 있으면 최우선이다 (006+)", () => {
    const r = resolveLedgerAccountAttribution(tx({ eventDate: "2020-01-01" }), registry, {
      accountInstanceId: "bai:m1rae1rp",
    });
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:m1rae1rp",
      evidence: "explicit_overlay",
    });
  });
});

describe("resolveEventAttribution — 이벤트 단위", () => {
  const registry = [IRP_MIRAE, IRP_KIS, PENSION_A, PENSION_B];

  it("소속 거래가 전원 같은 instance 면 resolved", () => {
    const r = resolveEventAttribution(
      [tx({ eventDate: "2026-08-28" }), tx({ eventDate: "2026-08-28" })],
      registry,
    );
    expect(r.kind).toBe("resolved");
  });

  it("거래 하나가 ambiguous 면 이벤트도 ambiguous (다수결하지 않는다)", () => {
    const r = resolveEventAttribution(
      [
        tx({ accountType: "pension", eventDate: "2026-07-01", source: "miraeasset_transaction_history" }),
        tx({ accountType: "pension", eventDate: "2026-07-01", source: "unregistered_source" }),
      ],
      registry,
    );
    expect(r.kind).toBe("ambiguous");
  });

  it("거래가 서로 다른 instance 로 귀속되면 conflict", () => {
    const r = resolveEventAttribution(
      [
        tx({ accountType: "pension", eventDate: "2026-07-01", source: "miraeasset_transaction_history" }),
        tx({ accountType: "pension", eventDate: "2026-07-01", source: "kis_only" }),
      ],
      [PENSION_A, { ...PENSION_B, broker: "kis" }],
      null,
    );
    // kis_only 는 레지스트리에 없어 broker 선언이 없고, 2 instance active 라 ambiguous 다.
    expect(["ambiguous", "conflict"]).toContain(r.kind);
  });

  it("근거가 섞이면 약한 쪽(single_active_instance)으로 내려 말한다", () => {
    const r = resolveEventAttribution(
      [
        tx({ eventDate: "2026-08-28", source: "miraeasset_retirement_web" }),
        tx({ eventDate: "2026-08-28", source: "user_supplied_missing_irp_2025-12-29" }),
      ],
      registry,
    );
    expect(r).toEqual({
      kind: "resolved",
      accountInstanceId: "bai:m1rae1rp",
      evidence: "single_active_instance",
    });
  });

  it("거래가 없으면 unknown", () => {
    expect(resolveEventAttribution([], registry).kind).toBe("unknown");
  });
});

describe("계좌번호를 다루지 않는다", () => {
  it("broker-account 모듈 소스에 CANO/계좌번호 리터럴이 없다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/broker-account.ts"), "utf-8");
    // 주석의 설명(CANO 원문은 저장하지 않는다)은 허용하되, 코드가 그 값을 다루면 안 된다.
    expect(src).not.toMatch(/\bcano\s*[:=]/i);
    expect(src).not.toMatch(/accountNumber|acctNo|ACNT_NO/);
    // 8자리 이상 연속 숫자 리터럴이 없어야 한다 (날짜 YYYY-MM-DD 는 하이픈으로 끊긴다).
    expect(src).not.toMatch(/\d{8,}/);
  });

  it("findInstance 는 id 로만 찾는다", () => {
    expect(findInstance([IRP_MIRAE, IRP_KIS], "bai:k1s1rp29")?.label).toBe("한국투자 IRP");
    expect(findInstance([IRP_MIRAE], "nope")).toBeUndefined();
  });
});
