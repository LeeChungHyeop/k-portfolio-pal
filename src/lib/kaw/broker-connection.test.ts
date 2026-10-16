/**
 * 계좌별 증권사·운용방식 설정을 고정한다.
 *
 * 지키는 것:
 *   1. 기본값은 계산만 제공이다 (기존 사용자 = instance 없음)
 *   2. 기타 증권사는 계산만 제공으로 고정, 한국투자는 연금저축·IRP 만 API 가능
 *   3. 설정 변경은 과거 instance 를 지우지 않는다 (닫고 추가)
 *   4. 가족·프로필·논리계좌별로 독립이다
 *   5. 계산만 제공이면 API 요청을 만들지 않는다 (클라이언트 호출 게이트)
 *   6. 저장 구조에 계좌번호·키가 들어갈 자리가 없다
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allowedModes,
  applyConnectionChange,
  connectionOf,
  kisApiProductOf,
  kisApiQueryGate,
} from "./broker-connection";
import { parseBrokerAccounts, type BrokerAccountInstance } from "./broker-account";
import { GATE_REASON_TEXT, requestKisAccount } from "./kis-account-client";
import { describeKisResult } from "./kis-account-view";
import type { AccountId } from "./constants";

const TODAY = "2026-10-12";
let n = 0;
const opts = (over: Partial<Parameters<typeof applyConnectionChange>[3]> = {}) => ({
  today: TODAY, newId: () => `id${++n}`, ...over,
});

const MIRAE_PENSION: BrokerAccountInstance = {
  id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset",
  logicalAccountType: "pension", activeFrom: "2025-01-01",
};

describe("기본값 — 계산만 제공", () => {
  it("instance 가 없으면 설정 없음 + 계산만 제공이다", () => {
    for (const a of ["retirement", "isa", "pension", "irp"] as AccountId[]) {
      const c = connectionOf([], a, TODAY);
      expect(c.broker).toBeNull();
      expect(c.mode).toBe("calc_only");
      expect(c.instance).toBeNull();
    }
  });

  it("connectionMode 가 없는 기존 instance 도 계산만 제공이다", () => {
    const c = connectionOf([MIRAE_PENSION], "pension", TODAY);
    expect(c.mode).toBe("calc_only");
    // 선택지에 없는 증권사는 other 로 보인다 (내부 값은 바뀌지 않는다)
    expect(c.broker).toBe("other");
    expect(c.instance?.broker).toBe("miraeasset");
  });

  it("기존 저장 데이터(필드 없음)를 읽어도 기본값이 유지된다", () => {
    const parsed = parseBrokerAccounts([
      { id: "bai:x", broker: "kis", productCode: "29", logicalAccountType: "irp", activeFrom: "2026-01-01" },
    ]);
    expect(connectionOf(parsed, "irp", TODAY).mode).toBe("calc_only");
  });
});

describe("허용되는 운용방식", () => {
  it("기타 증권사는 계산만 제공으로 고정이다", () => {
    for (const a of ["retirement", "isa", "pension", "irp"] as AccountId[]) {
      expect(allowedModes("other", a)).toEqual(["calc_only"]);
    }
  });

  it("한국투자는 연금저축·IRP 만 API 를 고를 수 있다", () => {
    expect(allowedModes("kis", "pension")).toEqual(["calc_only", "api_readonly"]);
    expect(allowedModes("kis", "irp")).toEqual(["calc_only", "api_readonly"]);
    expect(allowedModes("kis", "retirement")).toEqual(["calc_only"]);
    expect(allowedModes("kis", "isa")).toEqual(["calc_only"]);
  });

  it("상품코드는 논리계좌에서 결정된다 (22 연금저축 / 29 IRP)", () => {
    expect(kisApiProductOf("pension")).toBe("22");
    expect(kisApiProductOf("irp")).toBe("29");
    expect(kisApiProductOf("isa")).toBeNull();
  });

  it("기타 증권사 + API 는 거부된다", () => {
    const r = applyConnectionChange([], "pension", { broker: "other", mode: "api_readonly" }, opts());
    expect(r).toMatchObject({ ok: false, reason: "mode_not_allowed" });
  });

  it("미지원 계좌 종류에 API 를 거는 것은 거부된다", () => {
    const r = applyConnectionChange([], "isa", { broker: "kis", mode: "api_readonly" }, opts());
    expect(r).toMatchObject({ ok: false, reason: "mode_not_allowed" });
  });
});

describe("설정 변경 — 과거를 지우지 않는다", () => {
  it("첫 설정은 instance 를 추가하고 기존 것은 없다", () => {
    const r = applyConnectionChange([], "irp", { broker: "kis", mode: "api_readonly" }, opts());
    expect(r.ok && r.registry).toHaveLength(1);
    if (!r.ok) return;
    expect(r.registry[0]).toMatchObject({
      broker: "kis", productCode: "29", logicalAccountType: "irp",
      activeFrom: TODAY, connectionMode: "api_readonly",
    });
    expect(r.createdId).toBe(r.registry[0].id);
    expect(r.registry[0].id).toMatch(/^bai:/);
  });

  it("**증권사를 바꾸면 기존 instance 를 닫고 새로 추가한다 (삭제 없음)**", () => {
    const r = applyConnectionChange(
      [MIRAE_PENSION], "pension", { broker: "kis", mode: "api_readonly" }, opts({ activeFrom: "2026-10-20" }),
    );
    if (!r.ok) throw new Error("ok 여야 한다");
    expect(r.registry).toHaveLength(2);
    const old = r.registry.find((i) => i.id === "bai:mirae-pension")!;
    // id·증권사·시작일 그대로, 종료일만 채워진다 (half-open)
    expect(old).toMatchObject({ broker: "miraeasset", activeFrom: "2025-01-01", activeTo: "2026-10-20" });
    expect(r.closedId).toBe("bai:mirae-pension");
    const created = r.registry.find((i) => i.id === r.createdId)!;
    expect(created).toMatchObject({ broker: "kis", productCode: "22", activeFrom: "2026-10-20" });
  });

  it("이전일에는 새 계좌만 active 이다 (같은 날 둘이 겹치지 않는다)", () => {
    const r = applyConnectionChange(
      [MIRAE_PENSION], "pension", { broker: "kis", mode: "calc_only" }, opts({ activeFrom: "2026-10-12" }),
    );
    if (!r.ok) throw new Error("ok 여야 한다");
    expect(connectionOf(r.registry, "pension", "2026-10-11").instance?.id).toBe("bai:mirae-pension");
    expect(connectionOf(r.registry, "pension", "2026-10-12").instance?.id).toBe(r.createdId);
  });

  it("같은 증권사에서 방식만 바꾸면 **같은 instance** 의 방식만 바뀐다", () => {
    const first = applyConnectionChange([], "irp", { broker: "kis", mode: "calc_only" }, opts());
    if (!first.ok) throw new Error("ok");
    const second = applyConnectionChange(first.registry, "irp", { broker: "kis", mode: "api_readonly" }, opts());
    if (!second.ok) throw new Error("ok");
    expect(second.registry).toHaveLength(1);
    expect(second.registry[0].id).toBe(first.registry[0].id);
    expect(second.registry[0].connectionMode).toBe("api_readonly");
    expect(second.createdId).toBeUndefined();
  });

  it("같은 설정을 다시 저장해도 변경이 없다", () => {
    const first = applyConnectionChange([], "irp", { broker: "kis", mode: "api_readonly" }, opts());
    if (!first.ok) throw new Error("ok");
    const again = applyConnectionChange(first.registry, "irp", { broker: "kis", mode: "api_readonly" }, opts());
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it("**미래에셋 instance 에 기타 증권사 + 계산만 제공을 다시 저장해도 바뀌지 않는다**", () => {
    const r = applyConnectionChange([MIRAE_PENSION], "pension", { broker: "other", mode: "calc_only" }, opts());
    expect(r).toMatchObject({ ok: true, changed: false });
  });

  it("입력 레지스트리를 변형하지 않는다", () => {
    const input = [{ ...MIRAE_PENSION }];
    const snapshot = JSON.stringify(input);
    applyConnectionChange(input, "pension", { broker: "kis", mode: "api_readonly" }, opts());
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("현재 계좌의 시작일 이전으로는 바꿀 수 없다", () => {
    const r = applyConnectionChange(
      [MIRAE_PENSION], "pension", { broker: "kis", mode: "calc_only" }, opts({ activeFrom: "2024-01-01" }),
    );
    expect(r).toMatchObject({ ok: false, reason: "start_before_current" });
  });

  it("시작 예정 계좌가 이미 있으면 또 만들지 않는다", () => {
    const pending: BrokerAccountInstance = {
      id: "bai:kis-pending", label: "x", broker: "kis", productCode: "22",
      logicalAccountType: "pension", activeFrom: "2026-11-01", connectionMode: "api_readonly",
    };
    const r = applyConnectionChange(
      [MIRAE_PENSION, pending], "pension", { broker: "kis", mode: "api_readonly" }, opts({ activeFrom: "2026-10-15" }),
    );
    expect(r).toMatchObject({ ok: false, reason: "pending_instance_exists" });
  });

  it("같은 날 active 가 둘이면 아무것도 바꾸지 않는다", () => {
    const dup: BrokerAccountInstance = { ...MIRAE_PENSION, id: "bai:dup" };
    const r = applyConnectionChange(
      [MIRAE_PENSION, dup], "pension", { broker: "kis", mode: "api_readonly" }, opts(),
    );
    expect(r).toMatchObject({ ok: false, reason: "ambiguous_active_instances" });
  });

  it("날짜 형식이 틀리면 거부한다", () => {
    const r = applyConnectionChange([], "irp", { broker: "kis", mode: "calc_only" }, opts({ activeFrom: "내일" }));
    expect(r).toMatchObject({ ok: false, reason: "invalid_date" });
  });

  it("**논리계좌별로 독립이다** — 한 계좌를 바꿔도 다른 계좌는 그대로다", () => {
    const a = applyConnectionChange([], "pension", { broker: "kis", mode: "api_readonly" }, opts());
    if (!a.ok) throw new Error("ok");
    expect(connectionOf(a.registry, "pension", TODAY).mode).toBe("api_readonly");
    expect(connectionOf(a.registry, "irp", TODAY)).toMatchObject({ broker: null, mode: "calc_only" });
    expect(connectionOf(a.registry, "isa", TODAY)).toMatchObject({ broker: null, mode: "calc_only" });
  });

  it("두 계좌를 각각 다른 증권사·방식으로 둘 수 있다", () => {
    const a = applyConnectionChange([], "pension", { broker: "kis", mode: "api_readonly" }, opts());
    if (!a.ok) throw new Error("ok");
    const b = applyConnectionChange(a.registry, "irp", { broker: "other", mode: "calc_only" }, opts());
    if (!b.ok) throw new Error("ok");
    expect(connectionOf(b.registry, "pension", TODAY)).toMatchObject({ broker: "kis", mode: "api_readonly" });
    expect(connectionOf(b.registry, "irp", TODAY)).toMatchObject({ broker: "other", mode: "calc_only" });
  });
});

describe("kisApiQueryGate — 호출 전 허용 판단", () => {
  const api = (over: Partial<BrokerAccountInstance> = {}): BrokerAccountInstance => ({
    id: "bai:kis-irp", label: "x", broker: "kis", productCode: "29", logicalAccountType: "irp",
    activeFrom: "2026-01-01", connectionMode: "api_readonly", ...over,
  });

  it("등록 + 한국투자 + 상품코드 일치 + API 모드면 허용한다", () => {
    expect(kisApiQueryGate([api()], "irp", TODAY)).toMatchObject({ allowed: true, productCode: "29" });
  });

  it.each([
    ["미등록(sentinel)", [], "irp", "instance_unregistered"],
    ["계산만 제공", [api({ connectionMode: "calc_only" })], "irp", "mode_calc_only"],
    ["모드 없음(기존 사용자)", [api({ connectionMode: undefined })], "irp", "mode_calc_only"],
    ["기타 증권사", [api({ broker: "other" })], "irp", "broker_not_kis"],
    ["상품코드 불일치", [api({ productCode: "22" })], "irp", "product_mismatch"],
    ["미지원 계좌 종류", [api({ logicalAccountType: "isa" })], "isa", "account_type_unsupported"],
    ["시작 전", [api({ activeFrom: "2026-12-01" })], "irp", "instance_not_active"],
    ["종료됨", [api({ activeTo: "2026-02-01" })], "irp", "instance_not_active"],
    ["중복 active", [api(), api({ id: "bai:dup" })], "irp", "instance_ambiguous"],
  ] as Array<[string, BrokerAccountInstance[], AccountId, string]>)(
    "%s → 허용하지 않는다", (_n, registry, account, reason) => {
      expect(kisApiQueryGate(registry, account, TODAY)).toEqual({ allowed: false, reason });
    },
  );

  it("요청 상품코드가 레지스트리와 다르면 거부한다 (22 요청 → IRP instance)", () => {
    expect(kisApiQueryGate([api()], "irp", TODAY, "22")).toEqual({ allowed: false, reason: "product_mismatch" });
  });

  it("모든 거부 사유에 사용자 문구가 있다", () => {
    const reasons = [
      "mode_calc_only", "broker_not_kis", "account_type_unsupported",
      "instance_unregistered", "instance_ambiguous", "instance_not_active", "product_mismatch",
    ] as const;
    for (const r of reasons) expect(GATE_REASON_TEXT[r]).toBeTruthy();
  });
});

describe("requestKisAccount — 계산만 제공이면 요청을 만들지 않는다", () => {
  it("게이트가 막으면 fetch 를 호출하지 않는다", async () => {
    const fetchSpy = vi.fn();
    const r = await requestKisAccount([], "irp", TODAY, fetchSpy as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: "blocked", gate: { reason: "instance_unregistered" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("계산만 제공 계좌도 요청하지 않는다", async () => {
    const fetchSpy = vi.fn();
    const reg: BrokerAccountInstance[] = [{
      id: "bai:k", label: "x", broker: "kis", productCode: "29", logicalAccountType: "irp",
      activeFrom: "2026-01-01", connectionMode: "calc_only",
    }];
    const r = await requestKisAccount(reg, "irp", TODAY, fetchSpy as unknown as typeof fetch);
    expect(r.kind).toBe("blocked");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("조회 결과 문구 — 0 으로 쓰지 않는다", () => {
  it("차단·거부는 값이 아니라 사유를 말한다", () => {
    const v = describeKisResult({
      kind: "blocked", gate: { allowed: false, reason: "instance_unregistered" },
    });
    expect(v.tone).toBe("warn");
    expect(v.lines.join(" ")).not.toMatch(/0원|보유종목 없음/);
    expect(describeKisResult({ kind: "denied" }).title).toContain("권한");
  });
});

describe("저장 구조·소스 불변식", () => {
  const code = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("설정 모듈이 원장·cashflow·보유수량을 읽거나 쓰지 않는다", () => {
    const src = code("./broker-connection.ts");
    expect(src).not.toMatch(/ledger|cashflow|holdings|history|liveQuantities|cashBalance/);
    expect(src).not.toMatch(/console\./);
  });

  it("설정 UI 가 계좌번호·키 입력을 받지 않는다", () => {
    const src = code("../../components/kaw/BrokerConnectionCard.tsx");
    expect(src).not.toMatch(/cano|appkey|appsecret|계좌번호|password|secret/i);
    // 텍스트 입력은 없다. 날짜(date) 입력만 있다: 새 계좌 시작일 + 저장된 계좌의 시작일 정정(2곳).
    const inputs = [...src.matchAll(/<Input\b[^>]*type="([^"]+)"/g)].map((m) => m[1]);
    expect(inputs).toEqual(["date", "date"]);
  });

  it("클라이언트 조회는 자동 호출되지 않는다 (사용자 동작 안에서만)", () => {
    const card = code("../../components/kaw/BrokerConnectionCard.tsx");
    expect(card).not.toMatch(/useEffect|setInterval|setTimeout/);
    const uses = [...card.matchAll(/requestKisAccount\(/g)];
    expect(uses).toHaveLength(1);
    expect(card.indexOf("async function check()")).toBeLessThan(uses[0].index!);
  });

  it("store 가 초기화·가져오기에서 레지스트리를 보존한다", () => {
    const store = code("./store.ts");
    const reset = store.slice(store.indexOf("const resetAll"), store.indexOf("const importJson"));
    expect(reset).toContain("keepRegistry");
    const imp = store.slice(store.indexOf("const importJson"), store.indexOf("const setBrokerConnection"));
    expect(imp).toContain("keepRegistry");
  });

  it("_meta 저장에 레지스트리가 포함된다 (저장 때 사라지지 않는다)", () => {
    const store = code("./store.ts");
    expect(store).toMatch(/_meta[^}]*brokerAccounts: state\.brokerAccounts \?\? \[\]/);
    expect(store).toContain("parseBrokerAccounts((row.data as");
  });

  it("설정 변경 액션은 레지스트리 외 상태를 건드리지 않는다", () => {
    const store = code("./store.ts");
    const start = store.indexOf("const setBrokerConnection");
    const fn = store.slice(start, store.indexOf("\n  );", start));
    expect(fn).toContain("brokerAccounts: r.registry");
    expect(fn).not.toMatch(/accounts:|liveQuantities|cashBalance|history|cashflows/);
  });
});
