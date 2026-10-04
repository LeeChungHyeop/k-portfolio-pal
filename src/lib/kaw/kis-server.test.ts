import { describe, it, expect, vi, afterEach } from "vitest";
import {
  findNaverClosePriceByPaging,
  estimateNaverStartPage,
  parseNaverSiseJson,
  fetchNaverHistoryPrices,
  NAVER_MOBILE_PAGE_SIZE,
  NAVER_MAX_PAGE_STEPS,
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
