/**
 * 증권사 계좌 사용 시작일 정정 — 과거를 지우지 않고 시작일만 안전하게 고친다.
 *
 * 지키는 것:
 *   1. 시작일 외 어떤 필드도(id·label·broker·productCode·mode·fingerprint) 바뀌지 않는다
 *   2. 닫힘 관계의 직전 계좌는 종료일이 같은 날로 함께 움직인다 → 겹침·공백이 생기지 않는다
 *   3. 미래 날짜·종료일 이후·직전 계좌 시작일 이전·기간 겹침은 거부한다
 *   4. 입력 레지스트리를 변형하지 않고, 관계없는 계좌는 같은 객체다
 *   5. 정정 전후로 plan/observation 이 들고 있는 instance id 는 그대로 해소된다
 *   6. UI 는 시작일 기본값을 오늘로 채우지 않고, 확인 체크 없이는 저장하지 않는다
 *   7. 실제 사례(IRP 2026-10-09 이전, 연금저축 2026-10-14 입금 확인)가 복구된다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyConnectionChange, correctInstanceStart, connectionOf, isRealIsoDate,
} from "./broker-connection";
import { isActiveOn, resolveLedgerAccountAttribution, type BrokerAccountInstance } from "./broker-account";
import { resolveSessionAccountInstance } from "./rebalance-session";

const TODAY = "2026-10-16";
let n = 0;
const newId = () => `id${++n}`;

const MIRAE_IRP: BrokerAccountInstance = {
  id: "bai:mirae-irp", label: "미래에셋 IRP", broker: "other", logicalAccountType: "irp",
  activeFrom: "2025-12-29", connectionMode: "calc_only",
};
const MIRAE_PENSION: BrokerAccountInstance = {
  id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "other", logicalAccountType: "pension",
  activeFrom: "2025-01-01", connectionMode: "calc_only",
};

/** "오늘(10-16)을 기본값으로 저장했다"는 잘못 저장된 상태를 만든다. */
function savedWithTodayDefault(prev: BrokerAccountInstance) {
  const r = applyConnectionChange([prev], prev.logicalAccountType, { broker: "kis", mode: "api_readonly" },
    { today: TODAY, newId });
  if (!r.ok) throw new Error(r.message);
  return r.registry;
}

describe("실제 사례 복구 — 잘못 저장된 시작일 정정", () => {
  it("IRP: 오늘(10-16)로 저장된 한국투자 시작일을 이전일 2026-10-09 로 정정, 미래에셋 종료일도 함께 이동", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg.find((r) => r.broker === "kis")!;
    expect(kis.activeFrom).toBe(TODAY);
    expect(reg.find((r) => r.id === MIRAE_IRP.id)!.activeTo).toBe(TODAY);

    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    const nextKis = r.registry.find((x) => x.id === kis.id)!;
    const nextMirae = r.registry.find((x) => x.id === MIRAE_IRP.id)!;
    expect(nextKis.activeFrom).toBe("2026-10-09");
    expect(nextMirae.activeTo).toBe("2026-10-09");
    expect(r.movedPredecessor).toEqual({
      id: MIRAE_IRP.id, label: "미래에셋 IRP", previousActiveTo: TODAY, nextActiveTo: "2026-10-09",
    });
    // half-open: 이전일 당일은 한국투자만 active, 전날은 미래에셋만 active
    expect(isActiveOn(nextKis, "2026-10-09")).toBe(true);
    expect(isActiveOn(nextMirae, "2026-10-09")).toBe(false);
    expect(isActiveOn(nextMirae, "2026-10-08")).toBe(true);
    expect(isActiveOn(nextKis, "2026-10-08")).toBe(false);
  });

  it("연금저축: 입금 확인일 2026-10-14 로 정정", () => {
    const reg = savedWithTodayDefault(MIRAE_PENSION);
    const kis = reg.find((r) => r.broker === "kis")!;
    const r = correctInstanceStart(reg, kis.id, "2026-10-14", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    expect(r.registry.find((x) => x.id === kis.id)!.activeFrom).toBe("2026-10-14");
    expect(r.registry.find((x) => x.id === MIRAE_PENSION.id)!.activeTo).toBe("2026-10-14");
  });

  it("정정 전에는 이전일~오늘 사이 한국투자 거래가 미래에셋으로 잘못 귀속되고, 정정 후 바로잡힌다", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg.find((r) => r.broker === "kis")!;
    const tx = { accountType: "irp" as const, eventDate: "2026-10-12", source: "unknown_source" };
    const before = resolveLedgerAccountAttribution(tx, reg);
    expect(before).toMatchObject({ kind: "resolved", accountInstanceId: MIRAE_IRP.id }); // 잘못된 귀속
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    const after = resolveLedgerAccountAttribution(tx, r.registry);
    expect(after).toMatchObject({ kind: "resolved", accountInstanceId: kis.id });
  });
});

describe("불변성 — 시작일 외에는 아무것도 바뀌지 않는다", () => {
  it("id·label·broker·productCode·connectionMode·activeTo 가 그대로이고 입력은 변형되지 않는다", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const snapshot = JSON.stringify(reg);
    const kis = reg.find((r) => r.broker === "kis")!;
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    expect(JSON.stringify(reg)).toBe(snapshot);            // 입력 불변
    const nextKis = r.registry.find((x) => x.id === kis.id)!;
    expect({ ...nextKis, activeFrom: "x" }).toEqual({ ...kis, activeFrom: "x" });
    const nextMirae = r.registry.find((x) => x.id === MIRAE_IRP.id)!;
    expect({ ...nextMirae, activeTo: "x" }).toEqual({ ...reg.find((x) => x.id === MIRAE_IRP.id)!, activeTo: "x" });
    expect(r.registry).toHaveLength(reg.length);           // 삭제·추가 없음
  });

  it("다른 논리계좌의 instance 는 같은 객체다", () => {
    const reg = [...savedWithTodayDefault(MIRAE_IRP), MIRAE_PENSION];
    const kis = reg.find((r) => r.broker === "kis")!;
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    expect(r.registry.find((x) => x.id === MIRAE_PENSION.id)).toBe(MIRAE_PENSION);
  });

  it("instance id 가 그대로라서 이미 저장된 plan/observation 이 가리키는 계좌가 바뀌지 않는다", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg.find((r) => r.broker === "kis")!;
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    const storedEvidenceIds = [MIRAE_IRP.id, kis.id];      // plan/observation 이 복사해 둔 값은 id 뿐이다
    for (const id of storedEvidenceIds) expect(r.registry.some((x) => x.id === id)).toBe(true);
  });

  it("완료 기록(plan)의 instance 는 레지스트리와 무관한 sentinel 이라 영향이 없다", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg.find((r) => r.broker === "kis")!;
    const before = resolveSessionAccountInstance("irp", "2026-10-12", undefined);
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    const after = resolveSessionAccountInstance("irp", "2026-10-12", undefined);
    expect(after).toEqual(before);
  });

  it("정정 후에도 현재 연결 설정(방식·증권사)은 그대로다", () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg.find((r) => r.broker === "kis")!;
    const before = connectionOf(reg, "irp", TODAY);
    const r = correctInstanceStart(reg, kis.id, "2026-10-09", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    const after = connectionOf(r.registry, "irp", TODAY);
    expect(after.broker).toBe(before.broker);
    expect(after.mode).toBe(before.mode);
    expect(after.instance?.id).toBe(before.instance?.id);
  });
});

describe("거부 규칙", () => {
  const base = () => {
    const reg = savedWithTodayDefault(MIRAE_IRP);
    return { reg, kis: reg.find((r) => r.broker === "kis")! };
  };

  it("미래 날짜", () => {
    const { reg, kis } = base();
    expect(correctInstanceStart(reg, kis.id, "2026-10-17", { today: TODAY })).toMatchObject({ ok: false, reason: "future_date" });
  });
  it("현재와 같은 날짜", () => {
    const { reg, kis } = base();
    expect(correctInstanceStart(reg, kis.id, TODAY, { today: TODAY })).toMatchObject({ ok: false, reason: "no_change" });
  });
  it("직전 계좌의 시작일 이전·같은 날", () => {
    const { reg, kis } = base();
    expect(correctInstanceStart(reg, kis.id, "2025-12-29", { today: TODAY })).toMatchObject({ ok: false, reason: "before_predecessor_start" });
    expect(correctInstanceStart(reg, kis.id, "2025-01-01", { today: TODAY })).toMatchObject({ ok: false, reason: "before_predecessor_start" });
  });
  it("형식이 틀렸거나 존재하지 않는 날짜", () => {
    const { reg, kis } = base();
    for (const d of ["", "2026-13-01", "2026-02-30", "20261009", "2026-10-9"]) {
      expect(correctInstanceStart(reg, kis.id, d, { today: TODAY })).toMatchObject({ ok: false, reason: "invalid_date" });
    }
  });
  it("없는 계좌", () => {
    const { reg } = base();
    expect(correctInstanceStart(reg, "bai:nope", "2026-10-09", { today: TODAY })).toMatchObject({ ok: false, reason: "not_found" });
  });
  it("종료일이 있는 계좌의 시작일을 종료일 이후로 정정할 수 없다", () => {
    const closed: BrokerAccountInstance = { ...MIRAE_IRP, activeTo: "2026-10-09" };
    const r = correctInstanceStart([closed], closed.id, "2026-10-09", { today: TODAY });
    expect(r).toMatchObject({ ok: false, reason: "after_end" });
  });
  it("다른 계좌와 기간이 겹치면 거부한다 (닫힘 관계가 아닌 경우)", () => {
    const a: BrokerAccountInstance = { ...MIRAE_IRP, activeTo: "2026-06-01" };
    const b: BrokerAccountInstance = {
      id: "bai:b", label: "B", broker: "kis", productCode: "29", logicalAccountType: "irp", activeFrom: "2026-08-01",
    };
    // a 와 b 는 닫힘 관계가 아니다(공백 있음). b 를 a 기간 안으로 당기면 겹친다.
    expect(correctInstanceStart([a, b], b.id, "2026-05-01", { today: TODAY })).toMatchObject({ ok: false, reason: "overlap" });
    // 공백 안에서의 정정은 허용된다.
    const ok = correctInstanceStart([a, b], b.id, "2026-07-01", { today: TODAY });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.movedPredecessor).toBeUndefined();
  });
  it("직전 계좌가 둘 이상 같은 날 끝났다면 추측하지 않는다", () => {
    const p1: BrokerAccountInstance = { ...MIRAE_IRP, id: "bai:p1", activeTo: TODAY };
    const p2: BrokerAccountInstance = { ...MIRAE_IRP, id: "bai:p2", activeFrom: "2026-01-01", activeTo: TODAY };
    const k: BrokerAccountInstance = {
      id: "bai:k", label: "K", broker: "kis", productCode: "29", logicalAccountType: "irp", activeFrom: TODAY,
    };
    expect(correctInstanceStart([p1, p2, k], k.id, "2026-10-09", { today: TODAY })).toMatchObject({ ok: false, reason: "ambiguous_predecessor" });
  });
  it("실패하면 레지스트리를 만들어 돌려주지 않는다", () => {
    const { reg, kis } = base();
    const r = correctInstanceStart(reg, kis.id, "2030-01-01", { today: TODAY });
    expect("registry" in r).toBe(false);
  });
});

describe("시작일을 뒤로 정정 (너무 이르게 저장한 경우)", () => {
  it("한국투자 시작일을 10-09 → 10-12 로 늦추면 미래에셋 종료일도 10-12 로 늘어난다", () => {
    const reg0 = savedWithTodayDefault(MIRAE_IRP);
    const kis = reg0.find((r) => r.broker === "kis")!;
    const early = correctInstanceStart(reg0, kis.id, "2026-10-09", { today: TODAY });
    if (!early.ok) throw new Error(early.message);
    const r = correctInstanceStart(early.registry, kis.id, "2026-10-12", { today: TODAY });
    if (!r.ok) throw new Error(r.message);
    expect(r.registry.find((x) => x.id === kis.id)!.activeFrom).toBe("2026-10-12");
    expect(r.registry.find((x) => x.id === MIRAE_IRP.id)!.activeTo).toBe("2026-10-12");
  });
});

describe("날짜 검증 함수 — UI 저장 버튼·정정 미리보기가 쓰는 단일 판정", () => {
  it("실제 달력에 있는 YYYY-MM-DD 만 통과한다", () => {
    for (const d of ["2026-10-09", "2026-10-14", "2024-02-29"]) expect(isRealIsoDate(d)).toBe(true);
    for (const d of ["", "2026-13-01", "2026-02-30", "2025-02-29", "20261009", "2026-10-9", "2026/10/09", "abcd-ef-gh", "dddd-dd-dd"]) {
      expect(isRealIsoDate(d)).toBe(false);
    }
  });
  it("카드는 날짜 판정을 이 함수 하나로 한다 (손으로 쓴 정규식·역슬래시 누락 금지)", () => {
    const card = readFileSync(fileURLToPath(new URL("../../components/kaw/BrokerConnectionCard.tsx", import.meta.url)), "utf8");
    expect((card.match(/isRealIsoDate\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(card).not.toContain("d{4}-d{2}");      // 역슬래시가 빠진 잘못된 날짜 정규식이 없다
    expect(card).not.toMatch(/\\d\{4\}/);          // 손으로 쓴 날짜 정규식 자체가 없다 (판정은 isRealIsoDate 하나)
  });
});

describe("UI — 시작일을 임의로 확정하지 않는다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../components/kaw/BrokerConnectionCard.tsx", import.meta.url)), "utf8");

  it("시작일 입력의 기본값이 오늘이 아니다(빈 값)", () => {
    expect(src).toContain('useState("")');
    expect(src).not.toMatch(/useState\(today\)/);
    expect(src).not.toMatch(/setSince\(today\)/);
  });
  it("날짜 입력 + 실제 확인 체크가 있어야 저장 버튼이 열린다", () => {
    expect(src).toContain("startReady");
    expect(src).toMatch(/disabled=\{!dirty \|\| !startReady\}/);
    expect(src).toContain("실제 계좌 이전 완료일 또는 자금 입금 확인일");
  });
  it("오늘 날짜를 입력하면 경고한다", () => {
    expect(src).toMatch(/since === today/);
  });
  it("저장된 계좌의 시작일 정정 UI 가 있고 미리보기·확인 체크를 거친다", () => {
    expect(src).toContain("시작일 정정");
    expect(src).toContain("correctInstanceStart");
    expect(src).toContain("fixConfirmed");
    expect(src).toContain("수량·예수금·거래·완료 기록은 바뀌지 않습니다");
  });
  it("정정 경로는 레지스트리 외 어떤 상태도 읽거나 쓰지 않는다", () => {
    const store = readFileSync(fileURLToPath(new URL("./store.ts", import.meta.url)), "utf8");
    const start = store.indexOf("const correctBrokerStart");
    const body = store.slice(start, store.indexOf("const updateAssetLibrary", start));
    expect(body).toContain("brokerAccounts");
    expect(body).not.toMatch(/accounts\[|cashflows|history|liveQuantities|cashBalance/);
  });
});
