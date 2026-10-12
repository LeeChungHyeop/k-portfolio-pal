/**
 * 관측 source 레지스트리 — 해석을 파생으로 두는 경계와 **보수값**을 고정한다.
 *
 * 특히 두 항목은 실측 근거의 강도가 달라서 값이 다르다. 그게 흔들리면 안 된다:
 *   · kis_pension_present_balance(IRP)  sell-to-zero 실측 있음 → non_zero_only
 *   · kis_inquire_balance(연금저축 22)   빈 계좌 0행만 봤음     → unknown (보수)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOURCE_REGISTRY,
  UNKNOWN_SOURCE_CAPABILITIES,
  capabilitiesOf,
  effectiveHoldingsOmission,
  evidenceGradeOf,
  isAutoReconcilable,
} from "./source-registry";

describe("source registry — 불변식", () => {
  it("A-exec 등급은 레지스트리에 존재하지 않는다 (체결 증거는 원장 전용)", () => {
    for (const [key, cap] of Object.entries(SOURCE_REGISTRY)) {
      expect(["P", "H", "B", "unknown"], key).toContain(cap.grade);
    }
  });

  it("소스 텍스트에 A-exec 승격 경로가 없다", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/kaw/source-registry.ts"), "utf-8");
    // 주석에서 설명으로 언급하는 것은 허용하되, 등급 값으로는 쓰이지 않아야 한다.
    expect(src).not.toMatch(/grade:\s*["']A-exec["']/);
    expect(src).not.toMatch(/grade:\s*["']T["']/);
  });

  it("모든 항목이 근거(source)와 verifiedAt 을 들고 있다", () => {
    for (const [key, cap] of Object.entries(SOURCE_REGISTRY)) {
      expect(cap.source.length, key).toBeGreaterThan(10);
      expect(cap.verifiedAt, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("source registry — 실측 근거별 capability", () => {
  it("IRP present balance: sell-to-zero 실측이 있으므로 non_zero_only", () => {
    const cap = capabilitiesOf("kis_pension_present_balance");
    expect(cap.grade).toBe("P");
    expect(cap.holdingsOmission).toBe("non_zero_only");
    expect(cap.supportsHoldings).toBe(true);
    // output2 에 예수금 필드가 없다 — cash 는 inquire-deposit 에서 따로 받는다.
    expect(cap.supportsCash).toBe(false);
  });

  it("IRP deposit: cash 만 지원한다", () => {
    const cap = capabilitiesOf("kis_pension_deposit");
    expect(cap.supportsHoldings).toBe(false);
    expect(cap.supportsCash).toBe(true);
  });

  it("연금저축 22: sell-to-zero 실증이 없으므로 holdingsOmission 은 보수값 unknown", () => {
    const cap = capabilitiesOf("kis_inquire_balance");
    expect(cap.grade).toBe("P");
    // 빈 계좌가 0행을 돌려준 것은 "보유가 없으면 0행"일 뿐이고
    // "보유 중 0주인 것을 생략한다"와 다른 주장이다.
    expect(cap.holdingsOmission).toBe("unknown");
  });

  it("미래에셋 과거잔고: settlementBasis 를 사실로 주장하지 않고 자동 판정에서 제외한다", () => {
    const cap = capabilitiesOf("broker_historical_balance");
    expect(cap.grade).toBe("H");
    // §9 R1 — 검증된 모델이지 확인된 공식 필드 정의가 아니다.
    expect(cap.settlementBasis).toBe("unknown");
    expect(cap.supportsHoldings).toBe(false);
    expect(cap.supportsCash).toBe(false);
    expect(cap.autoReconcile).toBe(false);
    expect(isAutoReconcilable("broker_historical_balance")).toBe(false);
  });

  it("사용자 입력: 증권사를 source 로 단정하지 않는다", () => {
    const cap = capabilitiesOf("user_broker_screen");
    expect(cap.grade).toBe("B");
    expect(cap.broker).toBeNull();
    expect(cap.holdingsOmission).toBe("unknown");
  });
});

describe("source registry — fail closed", () => {
  it("미지 source 는 throw 하지 않고 보수값을 돌려준다", () => {
    const cap = capabilitiesOf("kis_some_future_endpoint");
    expect(cap).toBe(UNKNOWN_SOURCE_CAPABILITIES);
    expect(evidenceGradeOf("kis_some_future_endpoint")).toBe("unknown");
    expect(cap.autoReconcile).toBe(false);
    expect(cap.supportsHoldings).toBe(false);
    expect(cap.holdingsOmission).toBe("unknown");
  });
});

describe("effectiveHoldingsOmission — 행 값 우선 (R8)", () => {
  it("행이 all_positions 면 registry 가 unknown 이어도 0 normalize 가능", () => {
    expect(effectiveHoldingsOmission("user_broker_screen", "all_positions")).toBe("non_zero_only");
    expect(effectiveHoldingsOmission("kis_inquire_balance", "all_positions")).toBe("non_zero_only");
  });

  it("행이 partial 이면 registry 가 non_zero_only 여도 추정하지 않는다", () => {
    expect(effectiveHoldingsOmission("kis_pension_present_balance", "partial")).toBe("unknown");
  });

  it("행 값이 unknown 이면 추정하지 않는다 (registry 로 덮지 않는다)", () => {
    expect(effectiveHoldingsOmission("kis_pension_present_balance", "unknown")).toBe("unknown");
  });

  it("행 값이 없으면 registry 기본값을 쓴다", () => {
    expect(effectiveHoldingsOmission("kis_pension_present_balance", null)).toBe("non_zero_only");
    expect(effectiveHoldingsOmission("kis_inquire_balance", undefined)).toBe("unknown");
  });
});
