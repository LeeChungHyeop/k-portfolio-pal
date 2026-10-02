import { describe, expect, it } from "vitest";
import {
  HYEOBI_RETIREMENT_DB_BENCHMARK,
  buildRetirementDbSeries,
  calcRetirementDbAtMonth,
  calcRetirementDbWageBreakdown,
} from "./retirement-db";

describe("retirement DB benchmark", () => {
  it("uses the real 2025-03-25 settlement as an exact anchor", () => {
    const point = calcRetirementDbAtMonth(HYEOBI_RETIREMENT_DB_BENCHMARK, "2025-03");
    expect(point).not.toBeNull();
    expect(point?.date).toBe("2025-03-25");
    expect(point?.amount).toBe(60_923_460);
  });

  it("applies the 2025-07 early internal-evaluation payment from its September effective month", () => {
    const aug = calcRetirementDbWageBreakdown(HYEOBI_RETIREMENT_DB_BENCHMARK, "2025-08");
    const sep = calcRetirementDbWageBreakdown(HYEOBI_RETIREMENT_DB_BENCHMARK, "2025-09");
    const dec = calcRetirementDbWageBreakdown(HYEOBI_RETIREMENT_DB_BENCHMARK, "2025-12");

    expect(aug?.internalEvalMonthly).toBeCloseTo(655_250, 6);
    expect(sep?.internalEvalMonthly).toBeCloseTo(1_310_500, 6);
    expect(sep?.internalEvalSource).toContain("2025-07");
    expect(dec?.internalEvalMonthly).toBeCloseTo(655_250, 6);
  });

  it("builds the monthly series through the latest complete salary month", () => {
    const series = buildRetirementDbSeries(HYEOBI_RETIREMENT_DB_BENCHMARK);
    expect(series[0]?.date).toBe("2025-03-25");
    expect(series.at(-1)?.date).toBe("2026-09-30");
    expect(Math.round(series.at(-1)?.amount ?? 0)).toBe(86_097_152);
  });

  it("keeps the September 2026 wage components auditable", () => {
    const b = calcRetirementDbWageBreakdown(HYEOBI_RETIREMENT_DB_BENCHMARK, "2026-09");
    expect(Math.round(b?.regular3m ?? 0)).toBe(6_817_673);
    expect(b?.bonus12mMonthly).toBe(0);
    expect(Math.round(b?.internalEvalMonthly ?? 0)).toBe(960_397);
    expect(Math.round(b?.managementEvalMonthly ?? 0)).toBe(574_269);
    expect(Math.round(b?.wageIndex ?? 0)).toBe(8_352_339);
  });
});
