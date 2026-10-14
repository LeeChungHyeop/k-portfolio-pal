/**
 * 주문안 화면 문구와 미리보기 카드의 **호출 경계**를 고정한다.
 *
 *   1. 미리보기는 주문·확정·체결을 말하지 않는다
 *   2. 매수가능금액 미확인은 어디서든 "예상"으로 읽힌다
 *   3. 카드는 서버를 자동 호출하지 않는다 (사용자 클릭에서만)
 *   4. 카드는 기존 수동 리밸런싱 상태를 쓰거나 바꾸지 않는다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUDGET_BASIS_TEXT,
  LINE_NOTE_TEXT,
  PRICE_SOURCE_TEXT,
  SCOPE_TEXT,
  STRATEGY_TEXT,
  formatAsOf,
  orderabilityBadge,
  sortedWarnings,
  strategySwitchHint,
} from "./buy-order-plan-view";
import { buildBuyOrderPlan, type BuyOrderPlan } from "./buy-order-plan";

const NOW = "2026-10-12T06:04:00.000Z"; // KST 15:04

const readyPlan = (verified: boolean): BuyOrderPlan =>
  buildBuyOrderPlan(
    [{ rowId: "a", label: "A", etfName: "ETF-A", ticker: "1", allocPct: 100, orphaned: false }],
    { "1": { price: 10_000, source: "kis", asOf: NOW } },
    verified
      ? {
          kind: "kis_api", observedAt: NOW,
          buyingPower: { asOf: NOW, entries: [{ ticker: "1", price: 10_000, amount: 500_000, qty: 50 }] },
          plan: {
            accountInstanceId: "bai:x", accountType: "irp", productCode: "29", broker: "kis",
            stateAsOf: "2026-10-12", holdings: {}, holdingsCompleteness: "non_zero_only", cash: 500_000,
            buyBudget: { kind: "cash_upper_bound", amount: 500_000 }, ready: true,
            blockers: [], warnings: [], captureParts: [], captureId: "cap:x",
          },
        }
      : { kind: "manual", quantities: { a: 0 }, cash: 500_000 },
    { accountType: "irp", now: NOW },
  );

describe("배지 — 예상과 확인을 구분한다", () => {
  it("수동 입력·매수가능금액 미확인은 예상이다", () => {
    const b = orderabilityBadge(readyPlan(false));
    expect(b.tone).toBe("warn");
    expect(b.text).toContain("예상");
    expect(b.text).toContain("미확인");
  });

  it("매수가능금액이 확인되면 그렇게 표시한다", () => {
    const b = orderabilityBadge(readyPlan(true));
    expect(b.tone).toBe("ok");
    expect(b.text).toContain("확인됨");
  });

  it("계산 불가는 별도 표시다", () => {
    const blocked = buildBuyOrderPlan([], {}, { kind: "manual", quantities: {}, cash: null }, { accountType: "irp" });
    expect(orderabilityBadge(blocked).tone).toBe("blocked");
  });
});

describe("참고용·전환 안내", () => {
  const one = [{ rowId: "a", label: "A", etfName: "ETF-A", ticker: "1", allocPct: 100, orphaned: false }];
  const quote = { "1": { price: 10_000, source: "kis" as const, asOf: NOW } };

  it("평가가 불완전하면 참고용 배지다", () => {
    const p = buildBuyOrderPlan(
      one, quote, { kind: "manual", quantities: {}, cash: 500_000 }, { accountType: "irp", now: NOW },
    );
    const b = orderabilityBadge(p);
    expect(b.tone).toBe("warn");
    expect(b.text).toContain("참고용");
    expect(b.text).toContain("계좌 전체 비중을 계산하지 못함");
  });

  it("보유가 있는 연금저축의 신규 매수는 보유 반영 전환을 안내한다", () => {
    const p = buildBuyOrderPlan(
      one, quote, { kind: "manual", quantities: { a: 10 }, cash: 500_000 },
      { accountType: "pension", now: NOW, strategy: "cash_new_buy" },
    );
    const h = strategySwitchHint(p)!;
    expect(h.to).toBe("with_holdings");
    expect(h.text).toContain("전체 리밸런싱");
    expect(SCOPE_TEXT[p.scope]).toContain("별도 추가매수");
  });

  it("이미 맞는 전략이면 안내하지 않는다", () => {
    expect(strategySwitchHint(readyPlan(false))).toBeNull();
  });

  it("계산 불가에서는 안내하지 않는다", () => {
    const blocked = buildBuyOrderPlan([], {}, { kind: "manual", quantities: {}, cash: null }, { accountType: "pension" });
    expect(strategySwitchHint(blocked)).toBeNull();
  });
});

describe("문구", () => {
  it("예산 기준 문구가 매수가능금액 미확인을 드러낸다", () => {
    expect(BUDGET_BASIS_TEXT.cash_upper_bound).toContain("미확인");
    expect(BUDGET_BASIS_TEXT.cash_upper_bound).toContain("상한 추정");
  });

  it("모든 비고·출처·전략에 문구가 있다", () => {
    for (const k of ["non_tradable", "price_missing", "already_at_target", "overweight_no_sell", "below_one_share", "budget_limited"] as const) {
      expect(LINE_NOTE_TEXT[k]).toBeTruthy();
    }
    for (const k of ["kis", "naver", "history", "manual", "unavailable"] as const) {
      expect(PRICE_SOURCE_TEXT[k]).toBeTruthy();
    }
    expect(STRATEGY_TEXT.cash_new_buy).toContain("신규 매수");
    expect(STRATEGY_TEXT.with_holdings).toContain("보유");
  });

  it("주문·체결·확정을 말하지 않는다", () => {
    const all = [
      ...Object.values(LINE_NOTE_TEXT), ...Object.values(PRICE_SOURCE_TEXT),
      ...Object.values(BUDGET_BASIS_TEXT), ...Object.values(STRATEGY_TEXT),
    ].join(" ");
    expect(all).not.toMatch(/주문 완료|체결|확정|전송/);
  });

  it("경고는 심각한 것부터 정렬되고 원본을 바꾸지 않는다", () => {
    const plan = buildBuyOrderPlan(
      [
        { rowId: "a", label: "A", etfName: "ETF-A", ticker: "1", allocPct: 50, orphaned: false },
        { rowId: "b", label: "B", etfName: "ETF-B", ticker: "2", allocPct: 50, orphaned: false },
      ],
      { "1": { price: 10_000, source: "naver", asOf: NOW }, "2": { price: null, source: "unavailable", asOf: null } },
      { kind: "manual", quantities: {}, cash: 100_000 },
      { accountType: "irp", now: NOW },
    );
    const before = plan.warnings.map((w) => w.code);
    const sorted = sortedWarnings(plan);
    expect(sorted[0].level).toBe("critical");
    expect(plan.warnings.map((w) => w.code)).toEqual(before);
  });
});

describe("formatAsOf", () => {
  it("ISO 는 KST 로, 날짜는 종가로 표기한다", () => {
    expect(formatAsOf(NOW)).toBe("10/12 15:04");
    expect(formatAsOf("2026-10-09")).toBe("10/09 종가");
  });

  it("모르면 기준시각 미상이다", () => {
    expect(formatAsOf(null)).toBe("기준시각 미상");
    expect(formatAsOf("엉터리")).toBe("기준시각 미상");
  });
});

describe("미리보기 카드의 호출 경계 (소스 단위)", () => {
  const code = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const card = code("../../components/kaw/BuyOrderPreviewCard.tsx");

  it("서버 조회는 클릭 핸들러 안에서만 일어난다 (자동 호출 없음)", () => {
    expect(card).not.toMatch(/useEffect|setInterval|setTimeout/);
    const uses = [...card.matchAll(/requestKisAccount\(/g)];
    expect(uses).toHaveLength(1);
    expect(card.indexOf("async function load()")).toBeLessThan(uses[0].index!);
    expect(card).toContain("onClick={load}");
  });

  it("API 모드에서 조회 전에는 계산하지 않는다", () => {
    expect(card).toContain("if (!apiResult) return null;");
  });

  it("조회 결과는 준비 여부를 계산 모듈이 판단한다 (카드가 보정하지 않는다)", () => {
    expect(card).toContain('kind: "kis_api", plan: apiResult.plan');
    expect(card).not.toMatch(/\.ready\s*=|cash\s*\?\?\s*0|holdings\s*\?\?\s*\{\}/);
  });

  it("저장·주문·원장 경로를 쓰지 않는다", () => {
    expect(card).not.toMatch(/finalizeRebalance|addHistory|updateAccount|saveAccount|setBrokerConnection/);
    expect(card).not.toMatch(/method:\s*["']POST["']|order-cash|ledger|\/api\/rebalance|\/api\/data/);
  });

  it("카드가 종류·참고용·전환 안내를 화면에 낸다", () => {
    expect(card).toContain("SCOPE_TEXT[plan.scope]");
    expect(card).toContain('plan.reliability === "reference_only"');
    expect(card).toContain("strategySwitchHint(plan)");
    // 전환은 사용자가 누를 때만 일어난다
    expect(card).toContain("onClick={() => setStrategyChoice(switchHint.to)}");
    expect(card.match(/setStrategyChoice\(/g) ?? []).toHaveLength(2); // select onChange + 전환 버튼
  });

  it("카드가 쓰는 AccountPage 입력은 읽기 전용 prop 이다", () => {
    const page = code("../../components/kaw/AccountPage.tsx");
    const at = page.indexOf("<BuyOrderPreviewCard");
    expect(at).toBeGreaterThan(-1);
    const props = page.slice(at, page.indexOf("/>", at));
    // setter·저장 함수를 넘기지 않는다
    expect(props).not.toMatch(/set[A-Z]\w+=|update\w+=|save\w+=|finalize\w*=/);
  });

  it("예수금 미입력은 null 로 넘긴다 (0 으로 바꾸지 않는다)", () => {
    const page = code("../../components/kaw/AccountPage.tsx");
    expect(page).toContain("cash={account.cashBalance ?? null}");
  });
});
