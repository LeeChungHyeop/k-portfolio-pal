// 스냅샷 품질 판정 + 구간 단절 + 휴면 복원 엔진 방어
//
// 픽스처는 2026-10-20 운영 DB 에서 실측한 값이다 (연금저축 broker_sync 1건, 일별 스냅샷 updated_at).
import { describe, it, expect } from "vitest";
import { classifySnapshotQuality, splitByQuality, type QualityRow } from "./snapshot-quality";
import {
  aggregateByDate,
  calculatePerformance,
  computePeriodPerformance,
  type DailySnapshotRow,
} from "./performance";
import {
  buildPerformanceTimeline,
  buildReconstructedRows,
  mergeTimeline,
  reconstructionAnchors,
  validAnchors,
} from "./historical-performance";

const APPROVED_AT = "2026-10-20T12:24:53.030Z";
const sync = (over: Record<string, unknown> = {}) => ({
  id: "bsync:73347a2ff7bdffc5b8295389",
  kind: "broker_sync",
  version: 1,
  accountType: "pension",
  holdingsEffectiveFrom: "2026-10-14",
  quantities: { us: 230 },
  approvedAt: APPROVED_AT,
  transfer: { anchorDate: "2026-10-13", approvedAt: "2026-10-19T08:57:45.006Z", toInstanceId: "x", containsEstimates: true },
  affectedSnapshots: {
    dates: ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"],
    reason: "computed_from_pre_transfer_holdings_and_cash", preserved: true,
  },
  ...over,
});

// 실측 updated_at (cron 15:40 KST = 06:40 UTC)
const UPDATED: Record<string, string> = {
  "2026-10-12": "2026-10-12T06:40:54Z", "2026-10-13": "2026-10-13T06:40:52Z",
  "2026-10-14": "2026-10-14T06:40:19Z", "2026-10-15": "2026-10-15T06:41:11Z",
  "2026-10-16": "2026-10-16T06:40:29Z", "2026-10-19": "2026-10-19T06:40:28Z",
  "2026-10-20": "2026-10-20T06:40:29Z",
  "2026-10-21": "2026-10-21T06:40:25Z", "2026-10-22": "2026-10-22T06:40:25Z",
};
const DATES = Object.keys(UPDATED);
const TOTAL: Record<string, number> = {
  pension: 10_000_000, retirement: 70_000_000, isa: 50_000_000, irp: 4_600_000,
};
const snapRows = (accountIds = ["pension", "retirement", "isa", "irp"]): DailySnapshotRow[] =>
  DATES.flatMap((d) =>
    accountIds.map((a) => ({
      snapshotDate: d, accountId: a, marketValue: TOTAL[a], cashBalance: 0, totalAssetValue: TOTAL[a],
      updatedAt: UPDATED[d],
    })),
  );
const SYNCS = { pension: [sync()] };

describe("classifySnapshotQuality — 판정", () => {
  const flags = classifySnapshotQuality(snapRows(), SYNCS);
  const of = (d: string) => flags.find((f) => f.accountId === "pension" && f.date === d);

  it("영향받은 5건은 excluded, 두 근거가 일치한다(agree)", () => {
    for (const d of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]) {
      expect(of(d)?.kind).toBe("excluded");
      expect(of(d)?.crossCheck).toBe("agree");
      expect(of(d)?.reasons.length).toBe(2);
    }
  });

  it("10-13 은 정상도 오류도 단정하지 않는 boundary 이고, excluded 가 아니다", () => {
    expect(of("2026-10-13")?.kind).toBe("boundary");
    expect(splitByQuality(snapRows(), flags).excluded.some((r) => r.snapshotDate === "2026-10-13")).toBe(false);
  });

  it("동기화 이후 정상 스냅샷(10-21~)과 이전(10-12)은 flag 가 없다 — 이전을 정상으로 보증하지도 않는다", () => {
    expect(of("2026-10-21")).toBeUndefined();
    expect(of("2026-10-22")).toBeUndefined();
    expect(of("2026-10-12")).toBeUndefined();
  });

  it("다른 계좌와 broker_sync 없는 계좌는 flag 가 없다", () => {
    expect(flags.every((f) => f.accountId === "pension")).toBe(true);
    expect(classifySnapshotQuality(snapRows(), {})).toEqual([]);
    expect(classifySnapshotQuality(snapRows(), { retirement: [], isa: undefined, irp: "x" })).toEqual([]);
  });

  it("다른 계좌 유형의 동기화 기록은 이 계좌에 적용하지 않는다", () => {
    expect(classifySnapshotQuality(snapRows(), { retirement: [sync()] })).toEqual([]);
  });

  it("감사 기록(affectedSnapshots)이 없어도 독립 규칙(효력일 이후 + 승인 전 기록)으로 잡는다", () => {
    const f = classifySnapshotQuality(snapRows(), { pension: [sync({ affectedSnapshots: null })] });
    const ex = f.filter((x) => x.kind === "excluded").map((x) => x.date);
    expect(ex).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
    expect(f.find((x) => x.date === "2026-10-14")?.crossCheck).toBe("independent_only");
  });

  it("독립 규칙이 반대여도(승인 뒤에 다시 쓰인 행) 감사 기록이 있으면 보수적으로 제외하고 primary_only 로 남긴다", () => {
    const rows = snapRows().map((r) =>
      r.accountId === "pension" && r.snapshotDate === "2026-10-20" ? { ...r, updatedAt: "2026-10-21T01:00:00Z" } : r);
    const f = classifySnapshotQuality(rows, SYNCS).find((x) => x.date === "2026-10-20");
    expect(f?.kind).toBe("excluded");
    expect(f?.crossCheck).toBe("primary_only");
  });

  it("updated_at 이 없으면 교차 검증 불가(unverifiable) — 감사 기록만으로 판정한다", () => {
    const rows = snapRows().map((r) => ({ ...r, updatedAt: undefined }));
    const f = classifySnapshotQuality(rows, SYNCS);
    expect(f.filter((x) => x.kind === "excluded")).toHaveLength(5);
    expect(f.find((x) => x.date === "2026-10-14")?.crossCheck).toBe("unverifiable");
    // 감사 기록도 없고 updated_at 도 없으면 잡을 근거가 없다 — 추측으로 제외하지 않는다
    expect(classifySnapshotQuality(rows, { pension: [sync({ affectedSnapshots: null })] })
      .filter((x) => x.kind === "excluded")).toEqual([]);
  });

  it("판정은 입력 행을 수정하지 않는다", () => {
    const rows = snapRows();
    const before = JSON.stringify(rows);
    const f = classifySnapshotQuality(rows, SYNCS);
    splitByQuality(rows, f);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

// ── 구간 단절 ───────────────────────────────────────────────────────────────

const ALL4 = ["retirement", "isa", "pension", "irp"];
const flags = classifySnapshotQuality(snapRows(), SYNCS);
const pensionOnly = { accountIds: ["pension"] };
const allScope = { requireAccountIds: ALL4 };

describe("calculatePerformance — 계좌 이전 구간을 확정 수익률로 이어붙이지 않는다", () => {
  it("전체 scope: 연금저축이 빠진 5일은 point 가 아니다 → 가짜 급락이 없다", () => {
    const { usable } = splitByQuality(snapRows(), flags);
    const pts = aggregateByDate(usable, allScope);
    expect(pts.map((p) => p.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-21", "2026-10-22"]);
    // 모든 point 가 4계좌 합계 — 3계좌만 합한 낮은 값이 섞이지 않는다
    expect(new Set(pts.map((p) => p.total))).toEqual(new Set([134_600_000]));
  });

  it("break 를 가로지르는 일간 구간은 returnPct=null + 사유, 정상 일간은 그대로 계산된다", () => {
    const rs = calculatePerformance(snapRows(), [], allScope, "daily", flags);
    const by = Object.fromEntries(rs.map((r) => [r.key, r]));
    // 10-13 경계일을 끝점으로 하는 구간, 그리고 10-13 → 10-21 (제외 5일을 건너뜀)
    expect(by["2026-10-13"].returnPct).toBeNull();
    expect(by["2026-10-13"].unconfirmedReason).toMatch(/2026-10-13/);
    expect(by["2026-10-21"].returnPct).toBeNull();
    expect(by["2026-10-21"].unconfirmedReason).toMatch(/2026-10-14/);
    // 이전을 넘지 않는 정상 구간
    expect(by["2026-10-22"].unconfirmedReason).toBeUndefined();
    expect(by["2026-10-22"].returnPct).toBe(0); // 실제 0% 는 0 이다 (null 이 아님)
  });

  it("월간·연간도 이전 구간을 포함하면 null + 사유", () => {
    for (const p of ["monthly", "yearly"] as const) {
      const rs = calculatePerformance(snapRows(), [], allScope, p, flags);
      expect(rs).toHaveLength(1);
      expect(rs[0].returnPct).toBeNull();
      expect(rs[0].unconfirmedReason).toBeTruthy();
    }
  });

  it("연금저축 단독 scope 도 같은 날짜를 같은 사유로 처리한다 (계좌별·전체 일치)", () => {
    const one = calculatePerformance(snapRows(), [], pensionOnly, "daily", flags);
    const all = calculatePerformance(snapRows(), [], allScope, "daily", flags);
    const keys = (rs: typeof one) => rs.map((r) => [r.key, r.unconfirmedReason !== undefined]);
    expect(keys(one)).toEqual(keys(all));
  });

  it("flag 가 없는 계좌(퇴직·ISA·IRP)와 flag 를 주지 않은 호출은 기존 결과와 완전히 같다", () => {
    for (const id of ["retirement", "isa", "irp"]) {
      for (const p of ["daily", "monthly", "yearly"] as const) {
        const withFlags = calculatePerformance(snapRows(), [], { accountIds: [id] }, p, flags);
        const without = calculatePerformance(snapRows(), [], { accountIds: [id] }, p);
        expect(withFlags).toEqual(without);
        expect(withFlags.every((r) => r.unconfirmedReason === undefined)).toBe(true);
      }
    }
    // 기본 인자(flags 생략) == 빈 flags
    expect(calculatePerformance(snapRows(), [], allScope, "daily"))
      .toEqual(calculatePerformance(snapRows(), [], allScope, "daily", []));
  });

  it("computePeriodPerformance 에 flag 를 주지 않으면 기존 동작이다", () => {
    const pts = aggregateByDate(snapRows(), pensionOnly);
    expect(computePeriodPerformance(pts, "daily").every((r) => r.unconfirmedReason === undefined)).toBe(true);
  });

  it("원본 스냅샷 배열은 바뀌지 않는다", () => {
    const rows = snapRows();
    const before = JSON.stringify(rows);
    calculatePerformance(rows, [], allScope, "monthly", flags);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

// ── 휴면 복원 엔진 방어 ─────────────────────────────────────────────────────

describe("historical-performance — 제외된 날짜의 무단 복구 금지", () => {
  const library = [{ defaultEtf: "ETF-A", ticker: "AAA" }];
  const dates = ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
  const priceSeries = { AAA: Object.fromEntries(dates.map((d) => [d, 1000])) };
  const anchor = { date: "2026-10-01", rowQuantitiesSnap: { a: 10 }, rowEtfSnap: { a: "ETF-A" } };
  const actual = (d: string): DailySnapshotRow => ({
    snapshotDate: d, accountId: "pension", marketValue: 9000, cashBalance: 0, totalAssetValue: 9000,
  });

  it("첫 실제 스냅샷이 제외 대상이어도 복원 상한은 원본 기준 — 그 날짜를 복원으로 되살리지 않는다", () => {
    const originals = ["2026-10-04", "2026-10-05", "2026-10-06"].map(actual);
    const timeline = buildPerformanceTimeline({
      accounts: [{ accountId: "pension", history: [anchor] }], library,
      actualSnapshots: originals, priceSeries,
      excluded: [{ accountId: "pension", date: "2026-10-04" }],
    });
    const got = timeline.filter((r) => r.accountId === "pension").map((r) => [r.snapshotDate, r.source]);
    expect(got).toEqual([
      ["2026-10-01", "reconstructed"], ["2026-10-02", "reconstructed"],
      ["2026-10-05", "snapshot"], ["2026-10-06", "snapshot"],
    ]);
    // 대조: 제외 후의 배열을 상한 계산에 넘기면 10-04 가 되살아난다 — 이것이 막으려는 사고다
    const wrong = buildReconstructedRows({
      accounts: [{ accountId: "pension", history: [anchor] }], library,
      actualSnapshots: originals.slice(1), priceSeries,
    });
    expect(wrong.some((r) => r.snapshotDate === "2026-10-04")).toBe(true);
  });

  it("mergeTimeline 도 제외 키의 실제 행·복원 행을 모두 뺀다", () => {
    const merged = mergeTimeline([actual("2026-10-05")], [
      { ...actual("2026-10-05"), source: "reconstructed" },
      { ...actual("2026-10-06"), source: "reconstructed" },
    ], [{ accountId: "pension", date: "2026-10-05" }, { accountId: "pension", date: "2026-10-06" }]);
    expect(merged).toEqual([]);
  });

  it("broker_sync anchor 구간은 예수금을 모르므로 총자산 행을 만들지 않는다 (cash 0 확정 금지)", () => {
    const syncAnchor = {
      date: "2026-10-05", source: "broker_sync",
      rowQuantitiesSnap: { a: 5 }, rowEtfSnap: { a: "ETF-A" },
    };
    const rows = buildReconstructedRows({
      accounts: [{ accountId: "pension", history: [anchor, syncAnchor] }], library,
      actualSnapshots: [], priceSeries,
    });
    expect(rows.map((r) => r.snapshotDate)).toEqual(["2026-10-01", "2026-10-02", "2026-10-04"]);
  });

  it("broker_sync 가 없는 계좌의 복원은 기존과 같다 (cash 0, 상한 이전만)", () => {
    const rows = buildReconstructedRows({
      accounts: [{ accountId: "isa", history: [anchor] }], library,
      actualSnapshots: [{ ...actual("2026-10-06"), accountId: "isa" }], priceSeries,
    });
    expect(rows.map((r) => r.snapshotDate)).toEqual(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05"]);
    expect(rows.every((r) => r.cashBalance === 0 && r.totalAssetValue === 10_000)).toBe(true);
  });
});

describe("QualityRow 타입 호환", () => {
  it("DailySnapshotRow 는 그대로 QualityRow 로 쓸 수 있다", () => {
    const rows: QualityRow[] = snapRows();
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── 경계(boundary)를 제외하지 않는 설계의 증명 ──────────────────────────────

describe("boundary 날짜를 가로지르는 구간은 제외 없이도 unconfirmed 이다", () => {
  const boundaryOnly = [
    { accountId: "pension", date: "2026-10-13", kind: "boundary" as const, reasons: ["경계"], crossCheck: "unverifiable" as const, syncId: "s" },
  ];

  it("boundary 행은 평가에서 빠지지 않고(point 유지), 그 날을 끝점·시작점으로 삼는 구간만 확정 수익률이 없다", () => {
    const used = snapRows(); // 제외 flag 가 없으므로 모든 행이 그대로 쓰인다
    expect(aggregateByDate(used, allScope).map((p) => p.date)).toContain("2026-10-13");
    const rs = Object.fromEntries(
      calculatePerformance(used, [], allScope, "daily", boundaryOnly).map((r) => [r.key, r]),
    );
    expect(rs["2026-10-13"].returnPct).toBeNull(); // 10-12 → 10-13 (끝점이 경계)
    expect(rs["2026-10-13"].unconfirmedReason).toMatch(/경계 불확실/);
    expect(rs["2026-10-14"].returnPct).toBeNull(); // 10-13 → 10-14 (시작점이 경계)
    expect(rs["2026-10-15"].unconfirmedReason).toBeUndefined(); // 경계를 벗어나면 확정
    expect(rs["2026-10-15"].returnPct).toBe(0);
  });

  it("경계 + 오염 5건이 함께 있어도: 10-13→10-21 연결은 없고, 전체·연금저축 단독 모두 같고, 10-21 이후는 확정이다", () => {
    for (const scope of [allScope, pensionOnly]) {
      const rs = Object.fromEntries(
        calculatePerformance(snapRows(), [], scope, "daily", flags).map((r) => [r.key, r]),
      );
      const cross = rs["2026-10-21"]; // 점들 중 10-13 다음은 10-21
      expect(cross.fromDate).toBe("2026-10-13");
      expect(cross.returnPct).toBeNull();
      expect(cross.unconfirmedReason).toBeTruthy();
      expect(rs["2026-10-22"].fromDate).toBe("2026-10-21");
      expect(rs["2026-10-22"].returnPct).not.toBeNull();
      expect(rs["2026-10-22"].unconfirmedReason).toBeUndefined();
    }
  });

  it("break 전체가 하나의 사유로 보인다 — 제외 5일이 모두 사유 문구에 들어 있다", () => {
    const r = calculatePerformance(snapRows(), [], allScope, "daily", flags).find((x) => x.key === "2026-10-21")!;
    for (const d of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]) {
      expect(r.unconfirmedReason).toContain(d);
    }
  });
});

// ── 전량 0주 broker_sync 경계 ───────────────────────────────────────────────

describe("복원 엔진 — 전량 0주 동기화는 경계로 남는다 (옛 수량으로 되돌아가지 않는다)", () => {
  const library = [{ defaultEtf: "ETF-A", ticker: "AAA" }];
  const dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const priceSeries = { AAA: Object.fromEntries(dates.map((d) => [d, 1000])) };
  const positive = { id: "h1", date: "2026-10-01", rowQuantitiesSnap: { a: 10 }, rowEtfSnap: { a: "ETF-A" } };
  const zeroSync = {
    id: "bsync:1", date: "2026-10-05", source: "broker_sync",
    rowQuantitiesSnap: { a: 0 }, rowEtfSnap: { a: "ETF-A" },
  };
  const rowsFor = (history: object[], extra: Record<string, unknown> = {}) =>
    buildReconstructedRows({
      accounts: [{ accountId: "pension", history: history as never }], library,
      actualSnapshots: [], priceSeries, ...extra,
    }).map((r) => r.snapshotDate);

  it("reconstructionAnchors 는 양수 history 와 전량 0주 동기화를 함께 남긴다 (validAnchors 는 그대로)", () => {
    expect(reconstructionAnchors([positive, zeroSync] as never).map((a) => a.date)).toEqual(["2026-10-01", "2026-10-05"]);
    expect(validAnchors([positive, zeroSync] as never).map((a) => a.date)).toEqual(["2026-10-01"]);
  });

  it("★ 양수 history → 전량 0주 동기화 → 이후 날짜: 동기화 날짜부터 옛 수량 복원 행이 생기지 않는다", () => {
    expect(rowsFor([positive, zeroSync])).toEqual(["2026-10-01", "2026-10-02"]);
    // 대조: 경계가 없으면 옛 수량이 계속 복원된다 — 이것이 막으려는 사고다
    expect(rowsFor([positive])).toEqual(dates);
  });

  it("일반 리밸런싱 history 의 0주 기록은 기존대로 무시된다 (정책 변경 없음)", () => {
    const zeroRebalance = { id: "h2", date: "2026-10-05", rowQuantitiesSnap: { a: 0 }, rowEtfSnap: { a: "ETF-A" } };
    expect(rowsFor([positive, zeroRebalance])).toEqual(dates);
  });

  it("경계 이후에 양수 동기화가 다시 와도 동기화 anchor 는 행을 만들지 않는다 (예수금 미상)", () => {
    const later = { id: "bsync:2", date: "2026-10-07", source: "broker_sync", rowQuantitiesSnap: { a: 3 }, rowEtfSnap: { a: "ETF-A" } };
    expect(rowsFor([positive, zeroSync, later])).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("원본 스냅샷 기준 상한과 제외 키 재생성 금지는 경계가 있어도 유지된다", () => {
    const actual = ["2026-10-02"].map((d) => ({
      snapshotDate: d, accountId: "pension", marketValue: 1, cashBalance: 0, totalAssetValue: 1,
    }));
    // 상한 10-02 → 10-01 만. 제외 키(10-01) 는 복원하지 않는다.
    expect(rowsFor([positive, zeroSync], { actualSnapshots: actual })).toEqual(["2026-10-01"]);
    expect(rowsFor([positive, zeroSync], { actualSnapshots: actual, excluded: [{ accountId: "pension", date: "2026-10-01" }] })).toEqual([]);
  });
});
