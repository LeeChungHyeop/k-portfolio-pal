export interface RetirementDbPayRow {
  /** YYYY-MM */
  month: string;
  /** 기본급 + 직무평가급 + 직무급 + 시간외근무수당 합계 */
  regularPay?: number;
  /** 평균임금에 포함되는 상여금 */
  bonus?: number;
  /** 내부평가급 */
  internalEval?: number;
  /** 경영평가성과급 */
  managementEval?: number;
  /**
   * 실제 지급월과 퇴직급여 계산상 귀속월이 다를 때 사용한다.
   * 예: 2025-07 조기지급분은 원래 2025-09 지급예정이므로 "2025-09".
   */
  internalEvalEffectiveMonth?: string;
  note?: string;
}

export interface RetirementDbBenchmark {
  enabled: boolean;
  employmentStart: string;
  anchorDate: string;
  anchorAmount: number;
  investmentStart?: string;
  promotionDate?: string;
  rows: RetirementDbPayRow[];
}

export interface RetirementDbWageBreakdown {
  month: string;
  regular3m: number;
  bonus12mMonthly: number;
  internalEvalMonthly: number;
  managementEvalMonthly: number;
  wageIndex: number;
  internalEvalSource?: string;
  managementEvalSource?: string;
}

export interface RetirementDbPoint extends RetirementDbWageBreakdown {
  date: string;
  amount: number;
  serviceDays: number;
}

export const HYEOBI_RETIREMENT_DB_BENCHMARK: RetirementDbBenchmark = {
  enabled: true,
  employmentStart: "2016-07-01",
  anchorDate: "2025-03-25",
  anchorAmount: 60_923_460,
  investmentStart: "2025-09-01",
  promotionDate: "2025-07-01",
  rows: [
    { month: "2024-06", bonus: 2_840_850, internalEval: 1_868_100 },
    { month: "2024-09", bonus: 2_899_420, managementEval: 8_040_670 },
    { month: "2024-12", regularPay: 4_985_540, bonus: 2_899_420, internalEval: 3_736_200 },
    { month: "2025-01", regularPay: 4_595_140 },
    { month: "2025-02", regularPay: 4_833_040 },
    { month: "2025-03", regularPay: 4_595_140, bonus: 2_993_620, internalEval: 1_965_750 },
    { month: "2025-04", regularPay: 4_724_910 },
    { month: "2025-05", regularPay: 4_811_400 },
    { month: "2025-06", regularPay: 4_595_140, bonus: 2_993_620, internalEval: 1_965_750 },
    {
      month: "2025-07",
      regularPay: 5_087_720,
      internalEval: 7_863_000,
      internalEvalEffectiveMonth: "2025-09",
      note: "원래 9월 지급예정 내부평가급 조기지급분",
    },
    { month: "2025-08", regularPay: 6_459_440 },
    { month: "2025-09", regularPay: 6_458_760, bonus: 780_730, managementEval: 2_285_770 },
    { month: "2025-10", regularPay: 6_458_760 },
    { month: "2025-11", regularPay: 6_458_760 },
    { month: "2025-12", regularPay: 6_811_100, internalEval: 3_931_500 },
    { month: "2026-01", regularPay: 6_773_960 },
    { month: "2026-02", regularPay: 6_893_960 },
    { month: "2026-03", regularPay: 6_878_860, internalEval: 2_881_190 },
    { month: "2026-04", regularPay: 6_878_860 },
    { month: "2026-05", regularPay: 6_923_219 },
    { month: "2026-06", regularPay: 6_773_960, internalEval: 2_881_190 },
    { month: "2026-07", regularPay: 6_905_100 },
    { month: "2026-08", regularPay: 6_773_960 },
    { month: "2026-09", regularPay: 6_773_960, managementEval: 6_891_230 },
  ],
};

function ymIndex(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return year * 12 + (mon - 1);
}

function indexToYm(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthsEndingAt(month: string, count: number): string[] {
  const end = ymIndex(month);
  return Array.from({ length: count }, (_, i) => indexToYm(end - (count - 1 - i)));
}

function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${year}-${String(mon).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function utcDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function serviceDaysInclusive(start: string, end: string): number {
  return Math.max(1, utcDay(end) - utcDay(start) + 1);
}

function byMonth(config: RetirementDbBenchmark): Map<string, RetirementDbPayRow> {
  return new Map(config.rows.map((row) => [row.month, row]));
}

interface InternalCandidate {
  effectiveMonth: string;
  monthlyAmount: number;
  source: string;
}

function buildInternalCandidates(config: RetirementDbBenchmark): InternalCandidate[] {
  const rows = byMonth(config);
  const years = [...new Set(config.rows.map((r) => Number(r.month.slice(0, 4))))].sort();

  const candidates: InternalCandidate[] = [];
  for (const year of years) {
    const mar = rows.get(`${year}-03`)?.internalEval;
    const jun = rows.get(`${year}-06`)?.internalEval;
    if ((mar ?? 0) > 0 && (jun ?? 0) > 0) {
      candidates.push({
        effectiveMonth: `${year}-06`,
        monthlyAmount: ((mar ?? 0) + (jun ?? 0)) / 6,
        source: `${year}.03+${year}.06`,
      });
    }

    const dec = rows.get(`${year}-12`)?.internalEval;
    if ((dec ?? 0) > 0) {
      candidates.push({
        effectiveMonth: `${year}-12`,
        monthlyAmount: (dec ?? 0) / 6,
        source: `${year}.12`,
      });
    }
  }

  // 3/6/12월 정규 패턴 밖의 특수 지급분은 단독 후보로 보존한다.
  // 귀속월이 있으면 실제 지급월 대신 귀속월을 기준으로 효력이 생긴다.
  for (const row of config.rows) {
    if (!(row.internalEval && row.internalEval > 0)) continue;
    const mon = Number(row.month.slice(5, 7));
    const isSpecial = !!row.internalEvalEffectiveMonth || ![3, 6, 12].includes(mon);
    if (!isSpecial) continue;
    candidates.push({
      effectiveMonth: row.internalEvalEffectiveMonth ?? row.month,
      monthlyAmount: row.internalEval / 6,
      source: row.internalEvalEffectiveMonth
        ? `${row.month} 지급→${row.internalEvalEffectiveMonth} 귀속`
        : row.month,
    });
  }

  return candidates.sort((a, b) => ymIndex(a.effectiveMonth) - ymIndex(b.effectiveMonth));
}

export function calcRetirementDbWageBreakdown(
  config: RetirementDbBenchmark,
  month: string,
): RetirementDbWageBreakdown | null {
  const rows = byMonth(config);

  const regularMonths = monthsEndingAt(month, 3);
  const regularValues = regularMonths.map((m) => rows.get(m)?.regularPay);
  if (regularValues.some((v) => !(v && v > 0))) return null;
  const regular3m = regularValues.reduce((sum, v) => sum + (v ?? 0), 0) / 3;

  const bonusMonths = monthsEndingAt(month, 12);
  const bonus12mMonthly =
    bonusMonths.reduce((sum, m) => sum + (rows.get(m)?.bonus ?? 0), 0) / 12;

  const internalCandidate = buildInternalCandidates(config)
    .filter((c) => ymIndex(c.effectiveMonth) <= ymIndex(month))
    .at(-1);
  const internalEvalMonthly = internalCandidate?.monthlyAmount ?? 0;

  const managementMonths = new Set(monthsEndingAt(month, 12));
  const managementRow = [...config.rows]
    .filter((row) =>
      managementMonths.has(row.month) &&
      (row.managementEval ?? 0) > 0 &&
      ymIndex(row.month) <= ymIndex(month),
    )
    .sort((a, b) => ymIndex(a.month) - ymIndex(b.month))
    .at(-1);
  const managementEvalMonthly = (managementRow?.managementEval ?? 0) / 12;

  return {
    month,
    regular3m,
    bonus12mMonthly,
    internalEvalMonthly,
    managementEvalMonthly,
    wageIndex: regular3m + bonus12mMonthly + internalEvalMonthly + managementEvalMonthly,
    internalEvalSource: internalCandidate?.source,
    managementEvalSource: managementRow?.month,
  };
}

/**
 * 2025-03-25 실제 DB 정산액을 앵커로 사용한다.
 * 이후 값은 "평균임금 지수 변화 × 근속일수 변화"를 반영해 이어 붙인다.
 * 이 방식은 회사의 세부 일할/반올림 규칙 차이를 앵커 시점에서 흡수하면서,
 * 이후 급여·성과급·근속기간 변화는 월별로 그대로 반영한다.
 */
export function calcRetirementDbAtMonth(
  config: RetirementDbBenchmark,
  month: string,
): RetirementDbPoint | null {
  const anchorMonth = config.anchorDate.slice(0, 7);
  if (ymIndex(month) < ymIndex(anchorMonth)) return null;

  const anchorBreakdown = calcRetirementDbWageBreakdown(config, anchorMonth);
  const breakdown = calcRetirementDbWageBreakdown(config, month);
  if (!anchorBreakdown || !breakdown || !(anchorBreakdown.wageIndex > 0)) return null;

  const date = month === anchorMonth ? config.anchorDate : monthEnd(month);
  const anchorServiceDays = serviceDaysInclusive(config.employmentStart, config.anchorDate);
  const serviceDays = serviceDaysInclusive(config.employmentStart, date);

  const amount = month === anchorMonth
    ? config.anchorAmount
    : config.anchorAmount
      * (breakdown.wageIndex / anchorBreakdown.wageIndex)
      * (serviceDays / anchorServiceDays);

  return {
    ...breakdown,
    date,
    amount,
    serviceDays,
  };
}

export function buildRetirementDbSeries(config: RetirementDbBenchmark): RetirementDbPoint[] {
  if (!config.enabled) return [];
  const anchorMonth = config.anchorDate.slice(0, 7);
  const latestRegularMonth = [...config.rows]
    .filter((r) => (r.regularPay ?? 0) > 0)
    .sort((a, b) => ymIndex(a.month) - ymIndex(b.month))
    .at(-1)?.month;
  if (!latestRegularMonth) return [];

  const out: RetirementDbPoint[] = [];
  for (let i = ymIndex(anchorMonth); i <= ymIndex(latestRegularMonth); i++) {
    const point = calcRetirementDbAtMonth(config, indexToYm(i));
    if (point) out.push(point);
  }
  return out;
}

export function upsertRetirementDbPayRow(
  config: RetirementDbBenchmark,
  row: RetirementDbPayRow,
): RetirementDbBenchmark {
  const normalized: RetirementDbPayRow = {
    month: row.month,
    ...(row.regularPay && row.regularPay > 0 ? { regularPay: Math.round(row.regularPay) } : {}),
    ...(row.bonus && row.bonus > 0 ? { bonus: Math.round(row.bonus) } : {}),
    ...(row.internalEval && row.internalEval > 0 ? { internalEval: Math.round(row.internalEval) } : {}),
    ...(row.managementEval && row.managementEval > 0 ? { managementEval: Math.round(row.managementEval) } : {}),
    ...(row.internalEvalEffectiveMonth ? { internalEvalEffectiveMonth: row.internalEvalEffectiveMonth } : {}),
    ...(row.note?.trim() ? { note: row.note.trim() } : {}),
  };

  const rows = config.rows.filter((r) => r.month !== row.month);
  rows.push(normalized);
  rows.sort((a, b) => ymIndex(a.month) - ymIndex(b.month));
  return { ...config, rows };
}

export function removeRetirementDbPayRow(
  config: RetirementDbBenchmark,
  month: string,
): RetirementDbBenchmark {
  return { ...config, rows: config.rows.filter((row) => row.month !== month) };
}
