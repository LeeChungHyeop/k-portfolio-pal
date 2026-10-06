import { describe, it, expect, vi, afterEach } from "vitest";
import {
  findNaverClosePriceByPaging,
  estimateNaverStartPage,
  parseNaverSiseJson,
  fetchNaverHistoryPrices,
  NAVER_MOBILE_PAGE_SIZE,
  NAVER_MAX_PAGE_STEPS,
  pickSeriesInRange,
  collectNaverSeriesByPaging,
  historySeriesRangeError,
  HISTORY_SERIES_MAX_TICKERS,
  HISTORY_SERIES_MAX_DAYS,
  type NaverPriceRow,
} from "./kis-server";
import { validateHistoricalPricesForBacktest } from "./backtest";
import { ASSET_ORDER, BUILTIN_TICKERS, type AssetKey } from "./constants";

const parsePrice = (raw: unknown): number => {
  if (typeof raw === "number") return Number.isNaN(raw) ? 0 : Math.round(raw);
  const n = parseFloat(String(raw ?? "").replaceAll(",", "").replace(/[^0-9.]/g, ""));
  return Number.isNaN(n) ? 0 : Math.round(n);
};

/** YYYY-MM-DD 내림차순 거래일 행 만들기 (주말 건너뜀) */
function makeRows(newestISO: string, count: number, price = 10_000): NaverPriceRow[] {
  const rows: NaverPriceRow[] = [];
  let t = Date.parse(`${newestISO}T00:00:00Z`);
  while (rows.length < count) {
    const d = new Date(t);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      rows.push({ localTradedAt: d.toISOString().slice(0, 10), closePrice: String(price + rows.length) });
    }
    t -= 86_400_000;
  }
  return rows;
}

/** 60행씩 연속된 페이지 묶음 (page 1 = 최신) */
function makePagedSource(newestISO: string, pages: number) {
  const all = makeRows(newestISO, NAVER_MOBILE_PAGE_SIZE * pages);
  return (page: number): NaverPriceRow[] =>
    all.slice((page - 1) * NAVER_MOBILE_PAGE_SIZE, page * NAVER_MOBILE_PAGE_SIZE);
}

describe("NAVER 모바일 JSON 상수", () => {
  it("pageSize 상한은 60 이다 (실측: 61 이상 HTTP 400)", () => {
    expect(NAVER_MOBILE_PAGE_SIZE).toBe(60);
  });

  it("종목당 요청 상한이 있다 (Cloudflare subrequest 보호)", () => {
    expect(NAVER_MAX_PAGE_STEPS).toBeGreaterThan(0);
    expect(NAVER_MAX_PAGE_STEPS).toBeLessThanOrEqual(10);
  });
});

describe("estimateNaverStartPage — 시작 페이지 추정", () => {
  const now = new Date("2026-10-04T00:00:00Z");

  it("최근 날짜는 1페이지에서 시작한다", () => {
    expect(estimateNaverStartPage("2026-10-01", now)).toBe(1);
    expect(estimateNaverStartPage("2026-08-28", now)).toBe(1);
  });

  it("약 1년 전(2025-09-10)은 5페이지쯤에서 시작한다 — 실측과 일치", () => {
    expect(estimateNaverStartPage("2025-09-10", now)).toBe(5);
  });

  it("미래/오늘 날짜도 1페이지 이상이다", () => {
    expect(estimateNaverStartPage("2026-12-31", now)).toBe(1);
  });

  it("비정상 날짜는 1페이지", () => {
    expect(estimateNaverStartPage("not-a-date", now)).toBe(1);
  });
});

describe("findNaverClosePriceByPaging — 과거 종가 pagination", () => {
  it("1) page 1 에 목표일이 있으면 바로 반환한다 (요청 1회)", async () => {
    const src = makePagedSource("2026-10-02", 3);
    const loadPage = vi.fn(async (p: number) => src(p));
    const r = await findNaverClosePriceByPaging("2026-09-30", 1, loadPage, parsePrice);
    expect(r.price).toBeGreaterThan(0);
    expect(r.pagesRead).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("2) page 1 에 없고 page 2 에 있으면 더 깊이 가서 찾는다", async () => {
    const src = makePagedSource("2026-10-02", 3);
    const page2Oldest = src(2)[NAVER_MOBILE_PAGE_SIZE - 1].localTradedAt;
    const loadPage = vi.fn(async (p: number) => src(p));
    const r = await findNaverClosePriceByPaging(page2Oldest, 1, loadPage, parsePrice);
    expect(r.price).toBe(parsePrice(src(2)[NAVER_MOBILE_PAGE_SIZE - 1].closePrice));
    expect(r.pagesRead).toBe(2);
    expect(loadPage).toHaveBeenNthCalledWith(2, 2);
  });

  it("3) 목표일이 휴장일이면 그 이전 가장 최근 거래일 종가를 쓴다", async () => {
    // 2026-05-31 은 일요일 → 2026-05-29(금) 종가
    const rows = makeRows("2026-06-05", NAVER_MOBILE_PAGE_SIZE);
    const loadPage = async () => rows;
    const r = await findNaverClosePriceByPaging("2026-05-31", 1, loadPage, parsePrice);
    const friday = rows.find((x) => x.localTradedAt === "2026-05-29")!;
    expect(r.price).toBe(parsePrice(friday.closePrice));
  });

  it("4) 아무 페이지에도 목표일 이전 데이터가 없으면 실패를 보고한다", async () => {
    // 2025 년 데이터를 찾는데 상장 이력이 2026 년부터인 종목
    const src = makePagedSource("2026-10-02", 2);
    const loadPage = async (p: number) => src(p);
    const r = await findNaverClosePriceByPaging("2025-01-05", 1, loadPage, parsePrice);
    expect(r.price).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("5) 빈 페이지가 나오면 얕은 쪽으로 한 번 돌린 뒤 멈춘다 (무한 탐색 금지)", async () => {
    const rows = makeRows("2026-10-02", NAVER_MOBILE_PAGE_SIZE);
    const loadPage = vi.fn(async (p: number) => (p === 1 ? rows : []));
    const r = await findNaverClosePriceByPaging("2026-09-30", 3, loadPage, parsePrice);
    expect(r.price).toBeGreaterThan(0); // 1페이지로 돌아와 찾았다
    expect(loadPage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("6) HTTP 실패(null)면 즉시 중단하고 다음 fallback 으로 넘긴다", async () => {
    const loadPage = vi.fn(async () => null);
    const r = await findNaverClosePriceByPaging("2025-09-10", 5, loadPage, parsePrice);
    expect(r.price).toBe(0);
    expect(r.error).toContain("실패");
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("7) malformed JSON(null)도 같은 경로로 실패 처리된다", async () => {
    const r = await findNaverClosePriceByPaging("2025-09-10", 1, async () => null, parsePrice);
    expect(r.price).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("8) closePrice 가 0/비정상이면 성공으로 보지 않는다", async () => {
    const rows: NaverPriceRow[] = [
      { localTradedAt: "2026-09-30", closePrice: "0" },
      { localTradedAt: "2026-09-29", closePrice: "" },
    ];
    const r = await findNaverClosePriceByPaging("2026-09-30", 1, async () => rows, parsePrice);
    expect(r.price).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("9) maxPage 상한을 넘어 무한 요청하지 않는다", async () => {
    // 항상 "목표일이 더 과거" 라고 답하는(=끝없이 깊어지는) 소스
    const loadPage = vi.fn(async () => makeRows("2026-10-02", NAVER_MOBILE_PAGE_SIZE));
    const r = await findNaverClosePriceByPaging("2000-01-03", 1, loadPage, parsePrice);
    expect(loadPage.mock.calls.length).toBe(NAVER_MAX_PAGE_STEPS);
    expect(r.pagesRead).toBe(NAVER_MAX_PAGE_STEPS);
    expect(r.price).toBe(0);
  });

  it("10) 약 1년 전(2025-09-10) 날짜를 추정 페이지에서 1회 요청으로 찾는다", async () => {
    // 2026-10-02 가 최신인 6페이지 fixture — 실제 응답 구조와 같다
    const src = makePagedSource("2026-10-02", 6);
    const loadPage = vi.fn(async (p: number) => src(p));
    const startPage = estimateNaverStartPage("2025-09-10", new Date("2026-10-04T00:00:00Z"));
    const r = await findNaverClosePriceByPaging("2025-09-10", startPage, loadPage, parsePrice);
    expect(r.price).toBeGreaterThan(0);
    expect(r.pagesRead).toBe(1); // 추정이 맞아 한 번에 끝났다
  });

  it("추정이 너무 깊었으면 얕은 쪽으로 조정해 가장 가까운 거래일을 찾는다", async () => {
    const src = makePagedSource("2026-10-02", 4);
    const loadPage = vi.fn(async (p: number) => src(p));
    // 목표일은 page 1 구간인데 page 3 에서 시작
    const r = await findNaverClosePriceByPaging("2026-09-30", 3, loadPage, parsePrice);
    const expected = src(1).find((x) => x.localTradedAt <= "2026-09-30")!;
    expect(r.price).toBe(parsePrice(expected.closePrice));
    expect(loadPage.mock.calls.length).toBeLessThanOrEqual(NAVER_MAX_PAGE_STEPS);
  });
});

describe("parseNaverSiseJson — siseJson 구간 응답 파싱", () => {
  // 실제 응답 모양 (정식 JSON 이 아니다 — 작은따옴표 헤더 + 숫자 배열)
  const real = `[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
\t\t\t\t["20250901", 55670, 55870, 55070, 55205, 116920, 0.00],
\t\t\t\t["20250902", 55300, 56000, 55100, 55900, 100000, 0.00],
\t\t\t\t["20250910", 58000, 58900, 58100, 58675, 123456, 0.00]]`;

  it("행을 뽑아 내림차순으로 돌려준다 (종가는 5번째 숫자)", () => {
    const rows = parseNaverSiseJson(real);
    expect(rows[0]).toEqual({ localTradedAt: "2025-09-10", closePrice: "58675" });
    expect(rows.map((r) => r.localTradedAt)).toEqual(["2025-09-10", "2025-09-02", "2025-09-01"]);
  });

  it("목표일 이하 첫 행이 그 날 또는 직전 거래일이다", () => {
    const rows = parseNaverSiseJson(real);
    expect(rows.find((r) => r.localTradedAt <= "2025-09-05")?.localTradedAt).toBe("2025-09-02");
  });

  it("헤더만 있거나 쓰레기 응답이면 빈 배열", () => {
    expect(parseNaverSiseJson("[['날짜','시가']]")).toEqual([]);
    expect(parseNaverSiseJson("<html>error</html>")).toEqual([]);
    expect(parseNaverSiseJson("")).toEqual([]);
  });
});

describe("fetchNaverHistoryPrices — 종목별 partial 결과 contract 유지", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("12) 한 종목이 실패해도 다른 종목 결과는 그대로 돌려준다", async () => {
    const rows = makeRows("2026-10-02", NAVER_MOBILE_PAGE_SIZE, 50_000);
    vi.stubGlobal("fetch", async (url: string) => {
      // 294400 만 성공, 나머지는 전 경로 실패
      if (url.includes("294400") && url.includes("m.stock.naver.com")) {
        return { ok: true, status: 200, json: async () => rows, text: async () => "" };
      }
      return { ok: false, status: 410, json: async () => null, text: async () => "" };
    });

    const { results } = await fetchNaverHistoryPrices(["294400", "999999"], "20260930");
    expect(results["294400"].source).toBe("naver");
    expect(results["294400"].price).toBeGreaterThan(0);
    expect(results["999999"]).toMatchObject({ price: 0, source: "failed" });
    expect(results["999999"].error).toBeTruthy();
  });

  it("실패 응답은 price 0 + source failed 형식을 유지한다 (v5 consumer 계약)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => null, text: async () => "" }));
    const { results, timestamp } = await fetchNaverHistoryPrices(["294400"], "20250910");
    expect(results["294400"]).toMatchObject({ price: 0, source: "failed" });
    expect(typeof timestamp).toBe("string");
  });

  it("siseJson fallback 으로도 성공할 수 있다 (모바일 JSON 실패 시)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("m.stock.naver.com")) return { ok: false, status: 500, json: async () => null, text: async () => "" };
      if (url.includes("siseJson")) {
        return {
          ok: true,
          status: 200,
          text: async () => `[['날짜'],["20250909", 1, 2, 3, 58675, 10, 0.0],["20250910", 1, 2, 3, 58700, 10, 0.0]]`,
          json: async () => null,
        };
      }
      return { ok: false, status: 410, json: async () => null, text: async () => "" };
    });
    const { results } = await fetchNaverHistoryPrices(["294400"], "20250910");
    expect(results["294400"]).toMatchObject({ price: 58700, source: "naver" });
  });
});

describe("11) kr/us 가 조회되면 v5 fail-closed validator 를 통과한다", () => {
  it("실측 2025-09-10 종가 세트는 검증을 통과한다", () => {
    // 실제 네이버 조회로 확인한 2025-09-10 종가 (전 종목 1회 요청으로 성공)
    const real: Record<AssetKey, number> = {
      us: 22_490, kr: 58_675, cn: 14_040, in: 13_420, gold: 11_120,
      ust10: 10_260, ust30: 9_095, ktb30: 80_175, cash: 109_665,
    };
    const byAsset = { "2025-09-10": real };
    expect(validateHistoricalPricesForBacktest(["2025-09-10"], byAsset)).toEqual([]);
    // 모든 자산에 종목코드가 있어 조회 대상이 된다
    for (const k of ASSET_ORDER) expect(BUILTIN_TICKERS[k]).toBeTruthy();
  });

  it("kr/us 가 빠지면 여전히 fail-closed 로 막힌다 (이번 수정이 validator 를 약화시키지 않았다)", () => {
    const byAsset = { "2025-09-10": { cn: 14_040 } as Partial<Record<AssetKey, number>> };
    expect(validateHistoricalPricesForBacktest(["2025-09-10"], byAsset).length).toBeGreaterThan(0);
  });
});

// ── 과거 종가 "날짜 범위" 조회 (과거 성과 복원 전용) ─────────────────────────
describe("pickSeriesInRange — (15) 가격 range parser", () => {
  const rows: NaverPriceRow[] = [
    { localTradedAt: "2026-01-08", closePrice: "12,345" },
    { localTradedAt: "2026-01-07", closePrice: "12300" },
    { localTradedAt: "2026-01-06", closePrice: "12,100" },
    { localTradedAt: "2026-01-02", closePrice: "12000" },
  ];

  it("구간 안의 거래일만 날짜 오름차순으로 돌려준다", () => {
    expect(pickSeriesInRange(rows, "2026-01-05", "2026-01-07")).toEqual([
      { date: "2026-01-06", price: 12_100 },
      { date: "2026-01-07", price: 12_300 },
    ]);
  });

  it("siseJson 응답을 파싱해 구간 series 로 만든다 (종목당 요청 1회 경로)", () => {
    const text = `[['날짜','시가','고가','저가','종가','거래량','외국인소진율'],`
      + `["20260102", 11900, 12100, 11800, 12000, 1000, 0.0],`
      + `["20260106", 12000, 12200, 11950, 12100, 1200, 0.0],`
      + `["20260107", 12100, 12400, 12050, 12300, 1300, 0.0]]`;
    expect(pickSeriesInRange(parseNaverSiseJson(text), "2026-01-01", "2026-01-31")).toEqual([
      { date: "2026-01-02", price: 12_000 },
      { date: "2026-01-06", price: 12_100 },
      { date: "2026-01-07", price: 12_300 },
    ]);
  });

  it("휴장일을 만들어내지 않는다 — 응답에 있는 날짜만 나온다", () => {
    const out = pickSeriesInRange(rows, "2026-01-01", "2026-01-31");
    expect(out.map((p) => p.date)).toEqual(["2026-01-02", "2026-01-06", "2026-01-07", "2026-01-08"]);
  });

  it("같은 날짜가 두 번 오면 한 번만 남는다", () => {
    const dup: NaverPriceRow[] = [
      { localTradedAt: "2026-01-07", closePrice: "12300" },
      { localTradedAt: "2026-01-07", closePrice: "99999" },
    ];
    expect(pickSeriesInRange(dup, "2026-01-01", "2026-01-31")).toEqual([
      { date: "2026-01-07", price: 12_300 },
    ]);
  });
});

describe("(16) 잘못된 가격 / 빈 series 는 fail closed", () => {
  it("0 · 음수 · 비숫자 종가는 버린다 (0 을 가격으로 넘기지 않는다)", () => {
    const bad: NaverPriceRow[] = [
      { localTradedAt: "2026-01-02", closePrice: "0" },
      { localTradedAt: "2026-01-05", closePrice: "" },
      { localTradedAt: "2026-01-06", closePrice: "-100" },
      { localTradedAt: "2026-01-07", closePrice: "N/A" },
      { localTradedAt: "2026-01-08", closePrice: "12,300" },
    ];
    expect(pickSeriesInRange(bad, "2026-01-01", "2026-01-31")).toEqual([
      { date: "2026-01-08", price: 12_300 },
    ]);
  });

  it("날짜 형식이 깨진 행은 버린다", () => {
    const bad = [
      { localTradedAt: "20260108", closePrice: "12300" },
      { localTradedAt: "", closePrice: "12300" },
    ] as NaverPriceRow[];
    expect(pickSeriesInRange(bad, "2026-01-01", "2026-01-31")).toEqual([]);
  });

  it("빈 응답 / 파싱 불가 텍스트는 빈 series 다", () => {
    expect(pickSeriesInRange([], "2026-01-01", "2026-01-31")).toEqual([]);
    expect(pickSeriesInRange(parseNaverSiseJson("<html>error</html>"), "2026-01-01", "2026-01-31")).toEqual([]);
  });
});

describe("historySeriesRangeError — 요청 범위 guard", () => {
  const ok = ["100000", "200000"];

  it("정상 요청은 통과한다", () => {
    expect(historySeriesRangeError(ok, "2025-01-02", "2026-01-02")).toBeNull();
  });

  it("종목이 비었거나 상한을 넘으면 거부한다", () => {
    expect(historySeriesRangeError([], "2026-01-01", "2026-01-02")).toBeTruthy();
    const many = Array.from({ length: HISTORY_SERIES_MAX_TICKERS + 1 }, (_, i) =>
      String(100_000 + i));
    expect(historySeriesRangeError(many, "2026-01-01", "2026-01-02")).toContain("종목 수 상한");
  });

  it("구간 길이 상한을 넘으면 거부한다", () => {
    const from = "2000-01-01";
    expect(historySeriesRangeError(ok, from, "2026-01-01")).toContain("구간 상한");
    expect(HISTORY_SERIES_MAX_DAYS).toBeGreaterThan(365);
  });

  it("날짜 형식 오류 / 역순 구간을 거부한다", () => {
    expect(historySeriesRangeError(ok, "20260101", "2026-01-02")).toBe("날짜 형식 오류");
    expect(historySeriesRangeError(ok, "2026-01-05", "2026-01-02")).toBeTruthy();
  });
});

describe("collectNaverSeriesByPaging — 폴백 요청 수가 묶여 있다", () => {
  const page = (dates: string[]): NaverPriceRow[] =>
    dates.map((d) => ({ localTradedAt: d, closePrice: "1000" }));

  it("fromDate 에 닿으면 더 깊이 들어가지 않는다", async () => {
    const seen: number[] = [];
    const out = await collectNaverSeriesByPaging("2026-01-06", "2026-01-09", async (p) => {
      seen.push(p);
      if (p === 1) return page(["2026-01-09", "2026-01-08", "2026-01-07"]);
      if (p === 2) return page(["2026-01-06", "2026-01-05"]);
      return page(["2026-01-02"]);
    });
    expect(seen).toEqual([1, 2]);
    expect(out.map((x) => x.date)).toEqual([
      "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
    ]);
  });

  it("구간이 아무리 길어도 NAVER_MAX_PAGE_STEPS 회를 넘지 않는다", async () => {
    let calls = 0;
    await collectNaverSeriesByPaging("1990-01-01", "2026-01-09", async () => {
      calls += 1;
      return page(["2026-01-09"]);
    });
    expect(calls).toBe(NAVER_MAX_PAGE_STEPS);
  });

  it("응답 실패(null)/빈 페이지면 그 자리에서 멈춘다", async () => {
    let calls = 0;
    const out = await collectNaverSeriesByPaging("2026-01-01", "2026-01-09", async (p) => {
      calls += 1;
      return p === 1 ? page(["2026-01-09"]) : null;
    });
    expect(calls).toBe(2);
    expect(out).toEqual([{ date: "2026-01-09", price: 1_000 }]);
  });
});
