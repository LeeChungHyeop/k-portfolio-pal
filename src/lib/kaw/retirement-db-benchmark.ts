/**
 * 퇴직연금 "DB 유지 가정" 비교선 데이터.
 *
 * ## 성격 — historical estimate (실측 아님)
 *
 * 2025-03-25 에 실제로 DB → DC 전환을 했다. 그 시점의 **DB 기준 퇴직급여 산정액**이
 * 아래 첫 점(60,923,460원)이고, **그 이후 값은 "DB를 유지했다면 받았을 퇴직급여"의
 * 월별 추정치**다 — 실제로 지급받은 돈도, 회사가 통보한 금액도 아니다.
 * (DB 퇴직급여 = 평균임금 × 근속연수 구조라서, 임금 인상·상여 지급 시점에 계단식으로 올라간다.)
 *
 * 투자 성과가 아니므로 **투자 수익률(%)을 붙이지 않는다.** 이 선은 "DC로 바꾼 선택이
 * DB 유지보다 나았나"를 금액으로만 비교하기 위한 것이다.
 *
 * ## 이 데이터를 backtestGrowth 에 넣지 않는 이유
 *
 * `backtestGrowth` 는 시세로 계산되고 schemaVersion/장부 지문에 따라 자동 재계산되는
 * **계산 결과물**이다. DB 추정치는 급여 정보에서 나온 **입력 데이터**라서, 거기에 섞으면
 * 재계산 한 번에 날아가거나 fail-closed 게이트에 함께 막힌다. 그래서 독립 파일로 둔다.
 *
 * ## 정밀도
 *
 * 2025-03-25 를 뺀 나머지는 "그 달" 단위 추정이라 일자를 특정할 수 없다. false precision 을
 * 만들지 않도록 원본은 `month: "YYYY-MM"` 으로만 보관하고, 차트 정렬이 필요하면
 * `dbBenchmarkSortDate()`(월말) 로 변환한다. 화면 표시 단위도 `YYYY.MM` 이다.
 *
 * 2026-10 이후는 아직 없다 — 실제 급여가 확인되면 줄을 추가한다. 없는 달을 보간하지 않는다.
 */

export interface RetirementDbBenchmarkPoint {
  /** 추정 기준 월 (YYYY-MM) */
  month: string;
  /** DB 유지 가정 시 예상 퇴직급여 (원) */
  value: number;
  /**
   * 그 달 안에서 기준이 되는 실제 일자가 있을 때만 적는다.
   * 첫 점(2025-03-25)은 실제 DB→DC 전환일의 산정액이라 추정이 아니다.
   */
  asOfDate?: string;
}

export const RETIREMENT_DB_BENCHMARK: readonly RetirementDbBenchmarkPoint[] = [
  { month: "2025-03", value: 60_923_460, asOfDate: "2025-03-25" }, // 실제 DB→DC 전환 시점 기준액
  { month: "2025-04", value: 61_995_202 },
  { month: "2025-05", value: 62_526_256 },
  { month: "2025-06", value: 63_511_968 },
  { month: "2025-07", value: 71_201_627 },
  { month: "2025-08", value: 76_932_178 },
  { month: "2025-09", value: 77_296_406 },
  { month: "2025-10", value: 82_296_246 },
  { month: "2025-11", value: 83_018_114 },
  { month: "2025-12", value: 76_317_689 },
  { month: "2026-01", value: 78_012_332 },
  { month: "2026-02", value: 80_045_970 },
  { month: "2026-03", value: 78_524_506 },
  { month: "2026-04", value: 79_531_756 },
  { month: "2026-05", value: 80_315_588 },
  { month: "2026-06", value: 81_189_072 },
  { month: "2026-07", value: 81_966_939 },
  { month: "2026-08", value: 82_148_107 },
  { month: "2026-09", value: 86_097_152 },
];

/** 차트 x축 라벨 (YYYY.MM) — 리밸런싱 기록 쪽 월 라벨과 같은 형식이라 같은 점으로 합쳐진다. */
export const dbBenchmarkLabel = (month: string): string => month.replace("-", ".");

/**
 * 정렬·비교용 날짜. 월 단위 추정치를 그 달 **말일**로 놓는다 (실제 일자를 아는 첫 점은 그 날짜).
 * 월말을 쓰는 이유: 그 달의 리밸런싱 기록(월 중 아무 날)보다 뒤로 가므로, 같은 달 안에서
 * 순서가 뒤집히지 않는다.
 */
export function dbBenchmarkSortDate(point: RetirementDbBenchmarkPoint): string {
  if (point.asOfDate) return point.asOfDate;
  const [y, m] = point.month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${point.month}-${String(lastDay).padStart(2, "0")}`;
}

/** 월(YYYY-MM) → DB 유지 가정액. 없는 달은 undefined (보간하지 않는다). */
export function dbBenchmarkByMonth(): Map<string, number> {
  return new Map(RETIREMENT_DB_BENCHMARK.map((p) => [p.month, p.value]));
}
