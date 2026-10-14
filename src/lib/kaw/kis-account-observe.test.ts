/**
 * 한국투자 연금계좌 실잔고 → 관측/주문안 입력 구조를 고정한다.
 *
 * 지키는 것:
 *   1. 22(연금저축)와 29(IRP)가 서로 다른 instance·source 로 분리된다
 *   2. **미조회·실패는 잔고 0 이 아니다** (null / not_queried / failed)
 *   3. 빈 응답은 실증된 source(IRP)에서만 확정 0 이다
 *   4. 이전 중인 계좌는 조회하지 않는다
 *   5. 계좌번호가 출력에 나오지 않고, 이전을 거래/입금으로 만들지 않는다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KIS_ACCOUNT_IDENTITY,
  KIS_BUYING_POWER_SUPPORT,
  KIS_PRODUCTS,
  buildBuyPlanInputs,
  buildKisObservation,
  buyBudgetOf,
  capturePartsOf,
  kisUnregisteredInstanceId,
  resolveKisInstance,
  type KisInstanceResolution,
} from "./kis-account-observe";
import { captureId } from "./settlement-observation";
import type { BrokerAccountInstance } from "./broker-account";
import type { KisBalanceSnapshot, KisDepositResult } from "./kis-account-server";

const CANO = "12345678";

const inst = (over: Partial<BrokerAccountInstance>): BrokerAccountInstance => ({
  id: "bai:kis-irp",
  label: "한국투자 IRP",
  broker: "kis",
  productCode: "29",
  logicalAccountType: "irp",
  activeFrom: "2026-10-09",
  ...over,
});

const MIRAE_PENSION = inst({
  id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset",
  productCode: undefined, logicalAccountType: "pension", activeFrom: "2025-01-01",
});
const KIS_PENSION = inst({
  id: "bai:kis-pension", label: "한국투자 연금저축", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-11-01",
});
const KIS_IRP = inst({ connectionMode: "api_readonly" });
const KIS_PENSION_API = inst({
  id: "bai:kis-pension-api", label: "한국투자 연금저축", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-01-01", connectionMode: "api_readonly",
});
const MIRAE_IRP = inst({
  id: "bai:mirae-irp", label: "미래에셋 IRP", broker: "miraeasset", productCode: undefined,
  activeFrom: "2025-12-29", activeTo: "2026-10-09",
});

const okBalance = (over: Partial<KisBalanceSnapshot> = {}): KisBalanceSnapshot => ({
  ok: true, httpStatus: 200, rtCd: "0",
  holdings: [], holdingsCount: 0, cash: 0, summary: {},
  ...over,
});
const failedBalance = (): KisBalanceSnapshot => ({
  ok: false, httpStatus: 200, rtCd: "2", msgCd: "OPSQ2000", msg1: "ERROR : INPUT INVALID_CHECK_ACNO",
  holdings: [], holdingsCount: 0, cash: null, summary: {},
});
const okDeposit = (cash: number | null): KisDepositResult => ({
  ok: true, httpStatus: 200, rtCd: "0", cash,
});

const build = (
  productCode: "22" | "29",
  resolution: KisInstanceResolution,
  extra: Parameters<typeof buildKisObservation>[0] extends infer T
    ? Partial<T> : never = {},
) =>
  buildKisObservation({
    productCode, resolution, stateAsOf: "2026-10-12", observedAt: "2026-10-12T06:00:00.000Z",
    ...extra,
  });

const registered = (i: BrokerAccountInstance): KisInstanceResolution => ({
  kind: "registered", accountInstanceId: i.id, instance: i,
});
const sentinel = (code: "22" | "29"): KisInstanceResolution => ({
  kind: "unregistered", accountInstanceId: kisUnregisteredInstanceId(code),
});

describe("상품코드 22 / 29 분리", () => {
  it("서로 다른 논리계좌·source 를 쓴다", () => {
    expect(KIS_PRODUCTS["22"].logicalAccountType).toBe("pension");
    expect(KIS_PRODUCTS["29"].logicalAccountType).toBe("irp");
    expect(KIS_PRODUCTS["22"].holdingsSource).toBe("kis_inquire_balance");
    expect(KIS_PRODUCTS["29"].holdingsSource).toBe("kis_pension_present_balance");
    expect(KIS_PRODUCTS["29"].cashSource).toBe("kis_pension_deposit");
  });

  it("sentinel id 가 상품코드를 담는다 (논리계좌만 담지 않는다)", () => {
    expect(kisUnregisteredInstanceId("22")).toBe("bai:unregistered:kis:22");
    expect(kisUnregisteredInstanceId("29")).toBe("bai:unregistered:kis:29");
    expect(kisUnregisteredInstanceId("22")).not.toBe(kisUnregisteredInstanceId("29"));
  });
});

describe("resolveKisInstance — 증권사·상품코드·논리계좌로 분리", () => {
  it("같은 논리계좌의 미래에셋 instance 와 섞이지 않는다", () => {
    const r = resolveKisInstance("22", [MIRAE_PENSION, { ...KIS_PENSION, activeFrom: "2026-01-01" }], "2026-10-12");
    expect(r).toMatchObject({ kind: "registered", accountInstanceId: "bai:kis-pension" });
  });

  it("레지스트리에 KIS instance 가 없으면 sentinel 이다 (미래에셋 id 를 빌리지 않는다)", () => {
    const r = resolveKisInstance("22", [MIRAE_PENSION], "2026-10-12");
    expect(r).toEqual({ kind: "unregistered", accountInstanceId: "bai:unregistered:kis:22" });
  });

  it("**이전 진행 중**(아직 active 아님)이면 not_yet_active 다", () => {
    const r = resolveKisInstance("22", [MIRAE_PENSION, KIS_PENSION], "2026-10-12");
    expect(r).toEqual({
      kind: "not_yet_active", accountInstanceId: "bai:kis-pension", activeFrom: "2026-11-01",
    });
  });

  it("실물이전일 경계: activeFrom 당일부터 active, 전날은 아니다 (half-open)", () => {
    expect(resolveKisInstance("29", [MIRAE_IRP, KIS_IRP], "2026-10-09").kind).toBe("registered");
    expect(resolveKisInstance("29", [MIRAE_IRP, KIS_IRP], "2026-10-08").kind).toBe("not_yet_active");
  });

  it("종료된 instance 는 no_longer_active 다", () => {
    const r = resolveKisInstance("29", [inst({ activeFrom: "2025-01-01", activeTo: "2026-01-01" })], "2026-10-12");
    expect(r.kind).toBe("no_longer_active");
  });

  it("같은 날짜에 active 가 둘이면 추측하지 않는다", () => {
    const r = resolveKisInstance(
      "29", [KIS_IRP, inst({ id: "bai:kis-irp-2", activeFrom: "2026-01-01" })], "2026-10-12",
    );
    expect(r).toEqual({ kind: "ambiguous", candidates: ["bai:kis-irp", "bai:kis-irp-2"] });
  });

  it("상품코드가 다른 KIS instance 는 후보가 아니다", () => {
    const r = resolveKisInstance("29", [KIS_PENSION], "2026-12-01");
    expect(r.kind).toBe("unregistered");
  });
});

describe("미조회 ≠ 잔고 0", () => {
  it("이전 중인 연금저축은 holdings/cash 모두 not_queried 이고 plan 값은 null 이다", () => {
    const res = resolveKisInstance("22", [KIS_PENSION], "2026-10-12");
    const obs = build("22", res);
    expect(obs.holdings).toEqual({ kind: "not_queried", reason: "not_yet_active" });
    expect(obs.cash).toEqual({ kind: "not_queried", reason: "not_yet_active" });

    const plan = buildBuyPlanInputs(obs);
    expect(plan.holdings).toBeNull(); // {} 가 아니다
    expect(plan.cash).toBeNull(); // 0 이 아니다
    expect(plan.ready).toBe(false);
    expect(plan.blockers[0].code).toBe("instance_not_active");
    expect(plan.blockers[0].message).toContain("잔고 0 이 아닙니다");
    expect(plan.captureParts).toEqual([]);
  });

  it("이전 중이면 조회 결과가 있어도 쓰지 않는다 (빈 응답을 0 으로 읽지 않는다)", () => {
    const res = resolveKisInstance("22", [KIS_PENSION], "2026-10-12");
    // 호출자가 실수로 balance 를 넘겨도 관측은 not_queried 다
    const obs = build("22", res, { balance: okBalance() });
    expect(obs.holdings.kind).toBe("not_queried");
    expect(obs.cash.kind).toBe("not_queried");
  });

  it("실패한 조회는 failed 이고 0 이 아니다", () => {
    const obs = build("22", registered(KIS_PENSION_API), { balance: failedBalance() });
    expect(obs.holdings.kind).toBe("failed");
    expect(obs.cash.kind).toBe("failed");
    const plan = buildBuyPlanInputs(obs);
    expect(plan.holdings).toBeNull();
    expect(plan.cash).toBeNull();
    expect(plan.buyBudget).toEqual({ kind: "unknown" });
  });

  it("예수금 0 은 관측된 0 이고, 필드 없음은 모름이다", () => {
    const zero = build("22", registered(KIS_PENSION_API), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "KODEX 200", quantity: 3 }], cash: 0 }),
    });
    expect(zero.cash).toEqual({ kind: "observed", value: 0 });

    const missing = build("22", registered(KIS_PENSION_API), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "KODEX 200", quantity: 3 }], cash: null }),
    });
    expect(missing.cash.kind).toBe("failed");
    expect(buildBuyPlanInputs(missing).cash).toBeNull();
  });

  it("credential 이 없으면 not_queried 다", () => {
    const obs = build("29", registered(KIS_IRP), { skipped: "credentials_missing" });
    expect(obs.holdings).toEqual({ kind: "not_queried", reason: "credentials_missing" });
  });
});

describe("빈 응답의 의미", () => {
  it("IRP(생략이 실증된 source)의 빈 응답은 확정 0 이다", () => {
    const obs = build("29", registered(KIS_IRP), { balance: okBalance(), deposit: okDeposit(0) });
    expect(obs.holdings).toMatchObject({
      kind: "observed",
      value: { emptyMeaning: "confirmed_zero", completeness: "non_zero_only", positions: {} },
    });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.holdings).toEqual({});
    expect(plan.ready).toBe(true);
  });

  it("**연금저축(22)의 빈 응답은 확정 0 이 아니다** (생략 실증 없음)", () => {
    const obs = build("22", registered(KIS_PENSION_API), { balance: okBalance({ cash: 1000 }) });
    expect(obs.holdings).toMatchObject({
      kind: "observed", value: { emptyMeaning: "empty_unverified", completeness: "unknown" },
    });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toContain("holdings_unverified_empty");
  });

  it("보유가 있으면 22 도 준비된다", () => {
    const obs = build("22", registered(KIS_PENSION_API), {
      balance: okBalance({
        holdings: [{ ticker: "069500", name: "KODEX 200", quantity: 12 }], holdingsCount: 1, cash: 3621,
      }),
    });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.holdings).toEqual({ "069500": 12 });
    expect(plan.cash).toBe(3621);
    expect(plan.ready).toBe(true);
  });

  it("읽지 못한 행이 있으면 불완전이다 (조용히 빼고 완전하다고 하지 않는다)", () => {
    const obs = build("29", registered(KIS_IRP), {
      balance: okBalance({
        holdings: [
          { ticker: "069500", name: "KODEX 200", quantity: 5 },
          { ticker: null, name: "알 수 없음", quantity: 3 },
          { ticker: "360750", name: "TIGER 미국S&P500", quantity: null },
        ],
        holdingsCount: 3,
      }),
      deposit: okDeposit(100),
    });
    expect(obs.holdings).toMatchObject({
      kind: "observed", value: { skippedRows: 2, completeness: "partial" },
    });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toContain("holdings_incomplete");
  });

  it("같은 종목이 여러 행이면 수량을 합치고, 0주 행은 보유로 치지 않는다", () => {
    const obs = build("29", registered(KIS_IRP), {
      balance: okBalance({
        holdings: [
          { ticker: "069500", name: "KODEX 200", quantity: 5 },
          { ticker: "069500", name: "KODEX 200", quantity: 2 },
          { ticker: "360750", name: "TIGER", quantity: 0 },
        ],
        holdingsCount: 3,
      }),
      deposit: okDeposit(0),
    });
    expect(buildBuyPlanInputs(obs).holdings).toEqual({ "069500": 7 });
  });
});

describe("IRP — 두 호출의 부분 성공", () => {
  it("예수금 호출만 실패하면 보유종목은 남고 plan 은 준비되지 않는다", () => {
    const obs = build("29", registered(KIS_IRP), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1 }),
      deposit: { ok: false, httpStatus: 500, cash: null },
    });
    expect(obs.holdings.kind).toBe("observed");
    expect(obs.cash.kind).toBe("failed");
    const plan = buildBuyPlanInputs(obs);
    expect(plan.ready).toBe(false);
    expect(plan.holdings).toEqual({ "069500": 1 });
    expect(plan.cash).toBeNull();
    // 관측된 축만 part 로 만든다 (partial capture)
    expect(plan.captureParts.map((p) => p.sourceType)).toEqual(["kis_pension_present_balance"]);
  });

  it("두 호출이 모두 성공하면 part 가 둘이고 각자 자기 축만 갖는다", () => {
    const obs = build("29", registered(KIS_IRP), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1 }),
      deposit: okDeposit(500),
    });
    const parts = capturePartsOf(obs);
    expect(parts).toHaveLength(2);
    const h = parts.find((p) => p.sourceType === "kis_pension_present_balance")!;
    const c = parts.find((p) => p.sourceType === "kis_pension_deposit")!;
    expect(h.holdings).toEqual({ "069500": 1 });
    expect(h.cash).toBeNull();
    expect(c.holdings).toBeNull(); // 예수금 part 는 보유를 말하지 않는다
    expect(c.cash).toBe(500);
  });

  it("연금저축은 part 하나에 두 축이 같이 들어간다", () => {
    const obs = build("22", registered(KIS_PENSION_API), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1, cash: 9 }),
    });
    const parts = capturePartsOf(obs);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ sourceType: "kis_inquire_balance", cash: 9, holdings: { "069500": 1 } });
  });

  it("captureId 는 settlement-observation 의 규칙 그대로이고 내용에서 결정적이다", () => {
    const obs = build("29", registered(KIS_IRP), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1 }),
      deposit: okDeposit(500),
    });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.captureId).toBe(captureId(plan.accountInstanceId, plan.stateAsOf, plan.captureParts));
    expect(plan.captureId).toMatch(/^cap:bai:kis-irp:2026-10-12:[0-9a-f]{12}$/);
    // 두 instance 의 같은 내용은 다른 capture 다 (섞이지 않는다)
    const other = buildBuyPlanInputs({ ...obs, accountInstanceId: "bai:other" });
    expect(other.captureId).not.toBe(plan.captureId);
  });
});

describe("매수 주문안 예산", () => {
  it("매수가능금액이 없으면 예수금을 **상한**으로만 표시한다", () => {
    const obs = build("29", registered(KIS_IRP), { balance: okBalance(), deposit: okDeposit(250_000) });
    expect(buyBudgetOf(obs)).toEqual({ kind: "cash_upper_bound", amount: 250_000 });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.warnings.map((w) => w.code)).toContain("buying_power_unavailable");
  });

  it("예수금 0 이면 예산 0 이다 (모름과 구분된다)", () => {
    const obs = build("29", registered(KIS_IRP), { balance: okBalance(), deposit: okDeposit(0) });
    expect(buyBudgetOf(obs)).toEqual({ kind: "cash_upper_bound", amount: 0 });
  });

  it("매수가능금액이 관측되면 그것을 쓴다", () => {
    const obs = build("29", registered(KIS_IRP), { balance: okBalance(), deposit: okDeposit(250_000) });
    const withBp = { ...obs, buyingPower: { kind: "observed" as const, value: { amount: 100_000, sourceType: "x" } } };
    expect(buyBudgetOf(withBp)).toEqual({ kind: "buying_power", amount: 100_000 });
  });

  it("매수가능조회 API 지원 현황이 상품별로 기록돼 있다", () => {
    expect(KIS_BUYING_POWER_SUPPORT["29"].trId).toBe("TTTC0503R");
    expect(KIS_BUYING_POWER_SUPPORT["29"].path).toContain("pension/inquire-psbl-order");
    expect(KIS_BUYING_POWER_SUPPORT["29"].status).toBe("documented_unverified");
    // 22 는 2026-10-14 에 실증됐다 (사용자 승인 하 읽기 전용 1회 조회)
    expect(KIS_BUYING_POWER_SUPPORT["22"].status).toBe("verified_2026_10_14");
    expect(KIS_BUYING_POWER_SUPPORT["22"].trId).toBe("TTTC8908R");
    // 종목·단가를 요구한다 = 계좌 단위 한도가 아니다
    expect(KIS_BUYING_POWER_SUPPORT["29"].requires).toContain("PDNO");
    expect(KIS_BUYING_POWER_SUPPORT["29"].requires).toContain("ORD_UNPR");
  });

  it("**sentinel(미등록)은 조회의 근거가 아니다** — 조회 결과가 있어도 not_queried 다", () => {
    const obs = build("29", {
      kind: "unregistered", accountInstanceId: kisUnregisteredInstanceId("29"),
    }, { balance: okBalance(), deposit: okDeposit(500) });
    expect(obs.holdings).toEqual({ kind: "not_queried", reason: "instance_unregistered" });
    expect(obs.cash).toEqual({ kind: "not_queried", reason: "instance_unregistered" });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.ready).toBe(false);
    expect(plan.holdings).toBeNull();
    expect(plan.cash).toBeNull();
    expect(plan.blockers[0].code).toBe("api_not_available");
    expect(plan.blockers[0].message).toContain("잔고 0 이 아닙니다");
  });

  it("계산만 제공으로 설정된 계좌의 사유가 구분된다", () => {
    const obs = build("29", registered(KIS_IRP), { skipped: "mode_calc_only" });
    const plan = buildBuyPlanInputs(obs);
    expect(plan.blockers[0].code).toBe("api_not_available");
    expect(plan.blockers[0].message).toContain("계산만 제공");
  });

  it("권한 미확인 사유는 잔고 0 이 아니라 조회 안 함이다", () => {
    const obs = build("22", registered(KIS_PENSION_API), { skipped: "not_authorized" });
    expect(obs.cash).toEqual({ kind: "not_queried", reason: "not_authorized" });
    expect(buildBuyPlanInputs(obs).blockers[0].message).toContain("조회 권한");
  });
});

describe("계좌 식별 가정 — 주문의 근거가 아니다", () => {
  it("22/29 동일 종합계좌번호 가정이 미검증으로 명시돼 있다", () => {
    expect(KIS_ACCOUNT_IDENTITY.sharedCanoAcrossProducts).toBe("unverified");
    expect(KIS_ACCOUNT_IDENTITY.usableAsOrderAccountIdentity).toBe(false);
    expect(KIS_ACCOUNT_IDENTITY.note).toContain("주문 계좌의 식별 근거로 쓰지 않는다");
  });
});

describe("계좌번호·이전 처리", () => {
  it("출력 어디에도 계좌번호가 없다", () => {
    const obs = build("22", registered(KIS_PENSION), {
      balance: okBalance({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1, cash: 5 }),
    });
    const dump = JSON.stringify([obs, buildBuyPlanInputs(obs)]);
    expect(dump).not.toContain(CANO);
  });

  it("관측 구조에 거래·입금·이전 필드가 없다 (이전을 거래로 만들지 않는다)", () => {
    const obs = build("29", registered(KIS_IRP), { balance: okBalance(), deposit: okDeposit(0) });
    const keys = Object.keys(buildBuyPlanInputs(obs)).concat(Object.keys(obs));
    expect(keys.join(",")).not.toMatch(/transaction|ledger|cashflow|deposit|transfer|trade|order/i);
  });

  it("모듈이 원장·cashflow 를 가져오지 않는다", () => {
    const src = readFileSync(fileURLToPath(new URL("./kis-account-observe.ts", import.meta.url)), "utf-8")
      .split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    expect(src).not.toMatch(/from "\.\/(ledger|cashflow|store|verified-)/);
    expect(src).not.toMatch(/console\./);
  });

  it("두 instance 의 잔고를 이어 붙이는 코드가 없다", () => {
    // 주석은 금지 항목을 설명하느라 그 단어를 쓴다 — 코드만 본다.
    const src = readFileSync(fileURLToPath(new URL("./kis-account-observe.ts", import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(src).not.toMatch(/lineage|carry|transferIn|merge.*instance/i);
  });
});
