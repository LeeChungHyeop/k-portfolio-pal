/**
 * HistoryEntry 병합의 **순수 규칙**을 고정한다.
 *
 * 여기서 지키는 것은 네 가지다:
 *   1. 경제값 해시가 **파생 필드(returnPct / backtestGrowth / rowLabelSnap)를 뺀다** —
 *      재계산된 재시도가 409 가 되면 완료 저장이 영구히 막힌다
 *   2. 0 과 "키 없음"은 같고, **cashBalance 의 0 과 모름(null)은 다르다**
 *   3. 본문 검증이 모르는 필드를 거부한다 (`kaw_data.data` 는 지워지지 않는 문서다)
 *   4. 같은 id 의 재전송은 **해시가 같을 때만** ACK 다
 */
import { describe, it, expect } from "vitest";
import {
  DERIVED_KEYS,
  ENTRY_KEYS,
  HISTORY_HASH_VERSION,
  canonicalHistoryPayload,
  historyConflictOutcome,
  historyEntryHash,
  historyHashVersionOf,
  readHistoryMergeResult,
  validateHistoryMergeBody,
  type HistoryEntryInput,
} from "./history-merge";

const entry = (over: Partial<HistoryEntryInput> = {}): HistoryEntryInput => ({
  id: "hist:c-0001",
  date: "2026-10-12",
  baseAmount: 1_003_621,
  totalValue: 1_010_000,
  deposit: 688_074,
  cashBalance: 3_621,
  returnPct: 1.23,
  holdings: { kr: 500_000, us: 510_000 },
  rowQuantitiesSnap: { kr: 14, us: 7 },
  rowHoldingsSnap: { kr: 500_000, us: 510_000 },
  rowEtfSnap: { kr: "TIGER 200", us: "TIGER 미국S&P500" },
  rowLabelSnap: { kr: "한국주식", us: "미국주식" },
  rowAssetSnap: { kr: "kr", us: "us" },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  accountType: "isa",
  entry: entry(),
  ...over,
});

const ok = (b: unknown) => {
  const v = validateHistoryMergeBody(b);
  if (!v.ok) throw new Error(`유효해야 하는데 거부됨: ${v.error}`);
  return v.request;
};

const err = (b: unknown) => {
  const v = validateHistoryMergeBody(b);
  expect(v.ok).toBe(false);
  return v.ok ? "" : v.error;
};

describe("경제값 해시 — 파생 필드는 빠진다", () => {
  it("returnPct 가 달라도 같은 해시다 (체인에서 나오는 파생값)", () => {
    expect(historyEntryHash(entry({ returnPct: 9.99 })))
      .toBe(historyEntryHash(entry({ returnPct: null })));
  });

  it("backtestGrowth 가 붙거나 빠져도 같은 해시다", () => {
    const withBt = entry({
      backtestGrowth: { totalValue: 1, returnPct: 2, schemaVersion: 6, cashflowKey: "x" },
    });
    expect(historyEntryHash(withBt)).toBe(historyEntryHash(entry()));
  });

  it("rowLabelSnap(표시용 자산명)이 달라도 같은 해시다", () => {
    expect(historyEntryHash(entry({ rowLabelSnap: { kr: "국내주식" } })))
      .toBe(historyEntryHash(entry()));
  });

  it("DERIVED_KEYS 는 canonical payload 에 없다", () => {
    const payload = canonicalHistoryPayload(entry()) as unknown as Record<string, unknown>;
    for (const k of DERIVED_KEYS) expect(payload).not.toHaveProperty(k);
  });

  it("id 는 해시에 들어가지 않는다 (identity 는 비교의 열쇠다)", () => {
    expect(historyEntryHash(entry({ id: "hist:other" }))).toBe(historyEntryHash(entry()));
  });
});

describe("경제값 해시 — 경제값이 바뀌면 달라진다", () => {
  const base = historyEntryHash(entry());
  it.each([
    ["date", { date: "2026-10-13" }],
    ["baseAmount", { baseAmount: 1 }],
    ["totalValue", { totalValue: 1 }],
    ["deposit", { deposit: 1 }],
    ["cashBalance", { cashBalance: 1 }],
    ["holdings", { holdings: { kr: 1 } }],
    ["rowQuantitiesSnap", { rowQuantitiesSnap: { kr: 15, us: 7 } }],
    ["rowHoldingsSnap", { rowHoldingsSnap: { kr: 1, us: 2 } }],
    ["rowEtfSnap", { rowEtfSnap: { kr: "KODEX 200" } }],
    ["rowAssetSnap", { rowAssetSnap: { kr: "kr2" } }],
  ] as Array<[string, Partial<HistoryEntryInput>]>)("%s 가 달라지면 해시가 달라진다", (_k, over) => {
    expect(historyEntryHash(entry(over))).not.toBe(base);
  });

  it("버전 prefix 를 들고 있다", () => {
    expect(historyEntryHash(entry())).toMatch(/^h1\|[0-9a-f]{32}$/);
    expect(historyHashVersionOf(historyEntryHash(entry()))).toBe(HISTORY_HASH_VERSION);
    expect(historyHashVersionOf("p1|abc")).toBeNull();
    expect(historyHashVersionOf(undefined)).toBeNull();
  });
});

describe("맵 정규화 — 0 과 '키 없음'", () => {
  it("수량 0 은 키가 없는 것과 같다", () => {
    expect(historyEntryHash(entry({ rowQuantitiesSnap: { kr: 14, us: 7, cn: 0 } })))
      .toBe(historyEntryHash(entry()));
  });

  it("종목명이 빈 문자열이면 없는 것과 같다", () => {
    expect(historyEntryHash(entry({ rowEtfSnap: { kr: "TIGER 200", us: "TIGER 미국S&P500", cn: "" } })))
      .toBe(historyEntryHash(entry()));
  });

  it("**cashBalance 는 0 과 모름을 구분한다**", () => {
    const unknown = historyEntryHash(entry({ cashBalance: undefined }));
    const zero = historyEntryHash(entry({ cashBalance: 0 }));
    expect(unknown).not.toBe(zero);
    // 키를 아예 빼는 것과 null 은 같다 (JSON 은 undefined 를 보내지 못한다)
    expect(historyEntryHash(entry({ cashBalance: null }))).toBe(unknown);
  });
});

describe("validateHistoryMergeBody", () => {
  it("유효한 본문을 요청으로 바꾼다", () => {
    const req = ok(body());
    expect(req.accountType).toBe("isa");
    expect(req.entry.id).toBe("hist:c-0001");
    expect(req.entryHash).toBe(historyEntryHash(entry()));
    expect(req.hashVersion).toBe(HISTORY_HASH_VERSION);
  });

  it("파생 필드는 **저장한다** (해시에서만 빠진다)", () => {
    const req = ok(body({ entry: entry({ backtestGrowth: { schemaVersion: 6 } }) }));
    expect(req.entry.returnPct).toBe(1.23);
    expect(req.entry.backtestGrowth).toEqual({ schemaVersion: 6 });
    expect(req.entry.rowLabelSnap).toEqual({ kr: "한국주식", us: "미국주식" });
  });

  it("cashBalance 미입력은 키를 만들지 않는다 (0 으로 채우지 않는다)", () => {
    const req = ok(body({ entry: entry({ cashBalance: null }) }));
    expect("cashBalance" in req.entry).toBe(false);
  });

  it.each([
    ["본문이 객체가 아님", null],
    ["accountType 없음", { entry: entry() }],
    ["accountType 이 계좌가 아님", { accountType: "_meta", entry: entry() }],
    ["entry 없음", { accountType: "isa" }],
  ])("%s → 400", (_n, b) => expect(err(b)).toBeTruthy());

  it("모르는 필드를 거부한다", () => {
    expect(err(body({ entry: { ...entry(), evil: 1, typo: 2 } }))).toContain("evil, typo");
  });

  it.each([
    ["id", { id: "" }],
    ["date 모양", { date: "2026-10-1" }],
    ["baseAmount", { baseAmount: "1" as unknown as number }],
    ["totalValue", { totalValue: Number.NaN }],
    ["deposit", { deposit: undefined as unknown as number }],
    ["cashBalance 모양", { cashBalance: "3621" as unknown as number }],
    ["returnPct 모양", { returnPct: "1.2" as unknown as number }],
    ["holdings 모양", { holdings: [] as unknown as Record<string, number> }],
    ["rowQuantitiesSnap 값", { rowQuantitiesSnap: { kr: "14" as unknown as number } }],
    ["rowEtfSnap 값", { rowEtfSnap: { kr: 1 as unknown as string } }],
  ] as Array<[string, Partial<HistoryEntryInput>]>)("entry.%s 가 틀리면 400", (_n, over) => {
    expect(err(body({ entry: { ...entry(), ...over } }))).toBeTruthy();
  });

  it("backtestGrowth 는 객체이기만 하면 통과한다 (내부 모양은 backtest.ts 의 책임)", () => {
    expect(ok(body({ entry: entry({ backtestGrowth: { 아무거나: true } }) })).entry.backtestGrowth)
      .toEqual({ 아무거나: true });
    expect(err(body({ entry: { ...entry(), backtestGrowth: 1 } }))).toBeTruthy();
  });

  it("ENTRY_KEYS 는 store.ts HistoryEntry 의 필드 집합과 같다", () => {
    // store.ts 를 import 하지 않는다(클라이언트 모듈이다). 목록이 갈라지면 여기서 깨진다.
    expect([...ENTRY_KEYS].sort()).toEqual([
      "backtestGrowth", "baseAmount", "cashBalance", "date", "deposit", "holdings",
      "id", "returnPct", "rowAssetSnap", "rowEtfSnap", "rowHoldingsSnap",
      "rowLabelSnap", "rowQuantitiesSnap", "totalValue",
    ]);
  });
});

describe("validateHistoryMergeBody — 클라이언트 해시는 믿지 않고 비교만 한다", () => {
  it("일치하면 통과한다", () => {
    expect(ok(body({ entryHash: historyEntryHash(entry()) })).entryHash)
      .toBe(historyEntryHash(entry()));
  });

  it("어긋나면 400 이다 (조용히 서버 값으로 덮지 않는다)", () => {
    expect(err(body({ entryHash: "h1|00000000000000000000000000000000" }))).toContain("일치하지");
  });

  it("버전 prefix 가 다르면 400 이다", () => {
    expect(err(body({ entryHash: "h9|00000000000000000000000000000000" }))).toContain("버전");
  });

  it("미래 버전은 해석하지 않는다", () => {
    expect(err(body({ hashVersion: HISTORY_HASH_VERSION + 1 }))).toContain("해석할 수 없습니다");
  });
});

describe("historyConflictOutcome — 해시가 같을 때만 ACK", () => {
  const incoming = historyEntryHash(entry());

  it("저장된 기록의 경제값이 같으면 already_exists", () => {
    const stored = { ...entry(), returnPct: 7.77, backtestGrowth: { schemaVersion: 6 } };
    const r = historyConflictOutcome(stored, incoming);
    expect(r.kind).toBe("already_exists");
  });

  it("경제값이 다르면 hash_mismatch", () => {
    const r = historyConflictOutcome({ ...entry(), totalValue: 999 }, incoming);
    expect(r.kind).toBe("hash_mismatch");
    if (r.kind === "hash_mismatch") expect(r.storedHash).not.toBe(incoming);
  });

  it("저장된 기록을 읽지 못하면 unverified (성공으로 올리지 않는다)", () => {
    expect(historyConflictOutcome(undefined, incoming).kind).toBe("unverified");
    expect(historyConflictOutcome(null, incoming).kind).toBe("unverified");
    expect(historyConflictOutcome({ id: "x" }, incoming).kind).toBe("unverified");
  });

  it("레거시 경로로 들어온 기록(모르는 키 / 빠진 필드)도 멱등 판정이 된다", () => {
    // `/api/data` 문서 교체로 저장된 기록에는 모르는 키가 있을 수 있다. 그것 때문에
    // 재시도가 409 가 되면 완료 저장이 영구히 막힌다.
    const stored = { ...entry(), 레거시필드: "남아있음", rowLabelSnap: undefined };
    expect(historyConflictOutcome(stored, incoming).kind).toBe("already_exists");
  });
});

describe("readHistoryMergeResult — 모르는 반환값을 성공으로 읽지 않는다", () => {
  it("created", () => {
    const r = readHistoryMergeResult({
      outcome: "created", revision: 3, history_count: 12, stale_return_pct_ids: ["hist:next", 1],
    });
    expect(r).toEqual({
      kind: "created", revision: 3, historyCount: 12, staleReturnPctIds: ["hist:next"],
    });
  });

  it("already_exists 는 저장된 기록을 같이 들고 온다", () => {
    const r = readHistoryMergeResult({
      outcome: "already_exists", revision: 3, history_count: 12, entry: { id: "x" },
    });
    expect(r.kind).toBe("exists");
    if (r.kind === "exists") expect(r.entry).toEqual({ id: "x" });
  });

  it("account_row_missing", () => {
    expect(readHistoryMergeResult({ outcome: "account_row_missing" }).kind)
      .toBe("account_row_missing");
  });

  it.each([null, undefined, 1, "created", {}, { outcome: "merged" }])(
    "%s 는 unexpected 다", (raw) => {
      expect(readHistoryMergeResult(raw).kind).toBe("unexpected");
    },
  );
});
