/**
 * 원장 source 레지스트리.
 *
 * production 원장에 **실제로 존재하는** source 가 전부 등록돼 있는지 데이터셋으로
 * 확인한다. 누락되면 그 거래의 attribution 이 조용히 약해지므로(broker 선언 없음)
 * 여기서 드러내는 것이 가장 싸다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVerifiedDataset } from "./verified-transactions";
import {
  LEDGER_SOURCE_REGISTRY,
  UNKNOWN_LEDGER_SOURCE,
  declaredBrokerOf,
  ledgerSourceInfoOf,
} from "./ledger-source-registry";

const DATASET = parseVerifiedDataset(
  JSON.parse(readFileSync(resolve(process.cwd(), "data/verified-transactions.v1.json"), "utf-8")),
);

describe("데이터셋과의 정합", () => {
  it("원장에 실제로 있는 source 가 전부 등록돼 있다", () => {
    const actual = [...new Set(DATASET.transactions.map((t) => t.source))].sort();
    expect(actual).toEqual([
      "miraeasset_retirement_web",
      "miraeasset_transaction_history",
      "user_supplied_missing_irp_2025-12-29",
    ]);
    for (const s of actual) {
      expect(Object.keys(LEDGER_SOURCE_REGISTRY), s).toContain(s);
    }
  });

  it("미래에셋 export 두 종은 증권사를 선언한다", () => {
    expect(declaredBrokerOf("miraeasset_retirement_web")).toBe("miraeasset");
    expect(declaredBrokerOf("miraeasset_transaction_history")).toBe("miraeasset");
  });

  it("사용자 보완 source 는 증권사를 **이름에서 유추하지 않는다**", () => {
    // source 이름에 irp 가 들어 있어도 어느 증권사인지 보장하지 않는다.
    expect(declaredBrokerOf("user_supplied_missing_irp_2025-12-29")).toBeNull();
  });

  it("모든 항목이 근거와 verifiedAt 을 들고 있다", () => {
    for (const [key, info] of Object.entries(LEDGER_SOURCE_REGISTRY)) {
      expect(info.source.length, key).toBeGreaterThan(10);
      expect(info.verifiedAt, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("한국투자 API 출처 (Phase 4-C-2)", () => {
  it("kis_api_daily_ccld 는 증권사 kis 를 선언한다 (이름이 아니라 레지스트리 선언으로)", () => {
    expect(Object.keys(LEDGER_SOURCE_REGISTRY)).toContain("kis_api_daily_ccld");
    expect(declaredBrokerOf("kis_api_daily_ccld")).toBe("kis");
  });
  it("관측 source(kis_inquire_balance)와 섞이지 않는다", () => {
    expect(Object.keys(LEDGER_SOURCE_REGISTRY)).not.toContain("kis_inquire_balance");
  });
});

describe("fail closed", () => {
  it("미지 source 는 throw 하지 않고 broker 를 선언하지 않는다", () => {
    expect(ledgerSourceInfoOf("kis_inquire_daily_ccld")).toBe(UNKNOWN_LEDGER_SOURCE);
    expect(declaredBrokerOf("kis_inquire_daily_ccld")).toBeNull();
  });
});

describe("관측 레지스트리와 별개 맵이다", () => {
  it("원장 source 와 관측 source 가 섞이지 않는다", () => {
    // 관측 source_type 이 원장 레지스트리에 들어와 있으면 A-exec 와 P/H/B 가 섞인다.
    for (const observationSource of [
      "kis_pension_present_balance",
      "kis_pension_deposit",
      "kis_inquire_balance",
      "broker_historical_balance",
      "user_broker_screen",
    ]) {
      expect(Object.keys(LEDGER_SOURCE_REGISTRY), observationSource).not.toContain(observationSource);
    }
  });
});
