/**
 * **순서 독립성** 회귀 테스트.
 *
 * 이 파일이 있는 이유는 실제로 production 에서 드러났기 때문이다. `compareIntraDayOrder`
 * 가 유효한 전순서가 아니어서 — 계좌가 달라 비교할 근거가 없는 거래끼리 행 번호를
 * 비교했다 — `Array.prototype.sort` 가 **입력 순서에 따라 다른 결과**를 냈다.
 *
 * 그때까지의 547건 테스트는 전부 **데이터셋 파일 순서 하나**만 먹였고, 그 순서가 우연히
 * 맞는 답을 줘서 아무도 못 잡았다. DB 에서 읽은 순서로는 postQuantity 불일치 12건,
 * 무작위 순열에서는 최악 22건 + 음수 보유수량 5건이 나왔다.
 *
 * 그래서 여기서는 **같은 463건을 여러 입력 순서로** 넣고 결과가 line 단위까지 완전히
 * 같은지 본다. 순열은 고정 seed LCG 로 만들어 CI 에서 flaky 하지 않다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVerifiedDataset } from "./verified-transactions";
import {
  assignFingerprints, compareIntraDayOrder, replayFinalHoldings, resolveEvents,
  type LedgerTransaction,
} from "./ledger";

const DATASET = parseVerifiedDataset(
  JSON.parse(readFileSync(resolve(process.cwd(), "data/verified-transactions.v1.json"), "utf-8")),
);
const BASE: readonly LedgerTransaction[] = DATASET.transactions;

/** 고정 seed LCG — 같은 seed 면 항상 같은 순열이라 CI 에서 재현된다. */
function shuffled(list: readonly LedgerTransaction[], seed: number): LedgerTransaction[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x1_0000_0000;
  };
  const c = [...list];
  for (let i = c.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
}

/** 비교 대상 — 집계값뿐 아니라 **line 단위 순서와 수량**까지 본다. */
function snapshot(list: readonly LedgerTransaction[]) {
  const events = resolveEvents({ transactions: list });
  const lines = events.flatMap((e) => e.lines);
  return {
    eventCount: events.length,
    // 각 이벤트의 거래 line 순서 (이게 달라지면 이전→이후 수량이 달라진다)
    eventLineOrder: events.map((e) => ({
      id: e.id,
      lines: e.lines.map((l) => l.transaction.id),
    })),
    // 정렬된 transaction id 순서
    sortedIds: lines.map((l) => l.transaction.id),
    // 수량 재생 결과
    quantities: lines.map((l) => [l.transaction.id, l.beforeQuantity, l.afterQuantity] as const),
    negativeHolding: lines.filter((l) => l.afterQuantity < 0).length,
    postQuantityMismatch: lines.filter((l) => l.postQuantityMismatch === true).length,
    comparable: lines.filter((l) => l.postQuantityMismatch !== null).length,
    finalHoldings: replayFinalHoldings(list),
    // fingerprint 는 assignFingerprints 가 같은 비교자로 occurrence 를 매긴다
    fingerprints: [...assignFingerprints(list)]
      .map((t) => [t.id, t.sourceFingerprint] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}

/** 검사할 입력 순서들. 이름이 실패 메시지에 그대로 나온다. */
const ORDERS: [string, LedgerTransaction[]][] = [
  ["원본 순서", [...BASE]],
  ["역순", [...BASE].reverse()],
  ["id 오름차순 (DB 조회 순서)", [...BASE].sort((a, b) => (a.id < b.id ? -1 : 1))],
  ["id 내림차순", [...BASE].sort((a, b) => (a.id < b.id ? 1 : -1))],
  ["eventDate 역순", [...BASE].sort((a, b) => (a.eventDate < b.eventDate ? 1 : -1))],
  ["ticker 순", [...BASE].sort((a, b) => (a.ticker < b.ticker ? -1 : 1))],
  ...[1, 7, 42, 1337, 20261007, 999983].map(
    (seed) => [`고정 seed 순열 #${seed}`, shuffled(BASE, seed)] as [string, LedgerTransaction[]],
  ),
];

const REFERENCE = snapshot(BASE);

describe("일중 정렬은 입력 순서에 독립이다", () => {
  it("기준 스냅샷이 검증된 기대값과 맞는다", () => {
    expect(BASE.length).toBe(463);
    expect(REFERENCE.eventCount).toBe(65);
    expect(REFERENCE.negativeHolding).toBe(0);
    expect(REFERENCE.postQuantityMismatch).toBe(0);
    expect(REFERENCE.comparable).toBe(171);
  });

  it.each(ORDERS)("%s — 정렬된 transaction id 순서가 같다", (_name, list) => {
    expect(snapshot(list).sortedIds).toEqual(REFERENCE.sortedIds);
  });

  it.each(ORDERS)("%s — 각 event 의 line 순서가 같다", (_name, list) => {
    expect(snapshot(list).eventLineOrder).toEqual(REFERENCE.eventLineOrder);
  });

  it.each(ORDERS)("%s — 이전/이후 보유수량이 같다", (_name, list) => {
    expect(snapshot(list).quantities).toEqual(REFERENCE.quantities);
  });

  it.each(ORDERS)("%s — event 수 / 음수 / postQuantity 불일치", (_name, list) => {
    const s = snapshot(list);
    expect(s.eventCount).toBe(65);
    expect(s.negativeHolding).toBe(0);
    expect(s.postQuantityMismatch).toBe(0);
    expect(s.comparable).toBe(171);
  });

  it.each(ORDERS)("%s — finalHoldings 가 같다", (_name, list) => {
    expect(snapshot(list).finalHoldings).toEqual(REFERENCE.finalHoldings);
  });

  it.each(ORDERS)("%s — id 별 fingerprint 가 같다", (_name, list) => {
    expect(snapshot(list).fingerprints).toEqual(REFERENCE.fingerprints);
  });
});

describe("compareIntraDayOrder 는 유효한 전순서다", () => {
  // 전수 검사는 463^3 이라 과하다. 같은 event_date 그룹 안에서만 본다 —
  // 정렬이 실제로 비교하는 범위가 그 안이고, 버그도 거기서 났다.
  const byDate = new Map<string, LedgerTransaction[]>();
  for (const t of BASE) byDate.set(t.eventDate, [...(byDate.get(t.eventDate) ?? []), t]);
  const groups = [...byDate.values()];

  it("반대칭 — compare(a,b) 와 compare(b,a) 의 부호가 반대다", () => {
    let checked = 0;
    for (const g of groups) {
      for (const a of g) for (const b of g) {
        const ab = Math.sign(compareIntraDayOrder(a, b));
        const ba = Math.sign(compareIntraDayOrder(b, a));
        // 합이 0 인지로 본다 — toBe(-ba) 는 ba 가 0 일 때 -0 과 0 을 다르게 본다.
        expect(ab + ba).toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("같은 거래끼리는 0 이다", () => {
    for (const t of BASE) expect(compareIntraDayOrder(t, t)).toBe(0);
  });

  it("서로 다른 거래끼리는 0 이 아니다 (tie-breaker 가 항상 결정한다)", () => {
    for (const g of groups) {
      for (let i = 0; i < g.length; i += 1) {
        for (let j = i + 1; j < g.length; j += 1) {
          expect(compareIntraDayOrder(g[i], g[j])).not.toBe(0);
        }
      }
    }
  });

  it("전이성 — a<b 이고 b<c 이면 a<c 다", () => {
    const violations: string[] = [];
    for (const g of groups) {
      for (const a of g) for (const b of g) for (const c of g) {
        if (a === b || b === c || a === c) continue;
        if (compareIntraDayOrder(a, b) < 0 && compareIntraDayOrder(b, c) < 0
            && compareIntraDayOrder(a, c) > 0) {
          if (violations.length < 5) {
            violations.push(`${a.eventDate} ${a.id}(${a.accountId}/${a.sourceRow})`
              + ` < ${b.id}(${b.accountId}/${b.sourceRow})`
              + ` < ${c.id}(${c.accountId}/${c.sourceRow}) 인데 a > c`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("계좌가 다르면 행 번호로 비교하지 않는다", () => {
    // 계좌가 다르고 행 번호만 다른 두 거래를 만들어, 번호가 아니라 계좌로 갈리는지 본다.
    const a = { ...BASE[0], accountId: "isa", sourceRow: 999, id: "vtx:zzzz" } as LedgerTransaction;
    const b = { ...BASE[0], accountId: "pension", sourceRow: 1, id: "vtx:aaaa" } as LedgerTransaction;
    // 행 번호로 비교하면 (desc 면) 999 가 앞, (asc 면) 1 이 앞이다.
    // 계좌로 갈리므로 isa < pension 이어야 한다.
    expect(compareIntraDayOrder(a, b)).toBeLessThan(0);
    expect(compareIntraDayOrder(b, a)).toBeGreaterThan(0);
  });

  it("source 가 다르면 행 번호로 비교하지 않는다", () => {
    const a = { ...BASE[0], accountId: "isa", source: "aaa_source", sourceRow: 999 } as LedgerTransaction;
    const b = { ...BASE[0], accountId: "isa", source: "zzz_source", sourceRow: 1 } as LedgerTransaction;
    expect(compareIntraDayOrder(a, b)).toBeLessThan(0);
    expect(compareIntraDayOrder(b, a)).toBeGreaterThan(0);
  });

  it("검증된 source 별 방향은 그대로다 — 같은 계좌·같은 source 안에서만 적용된다", () => {
    // miraeasset_transaction_history 는 내림차순 (행 번호가 큰 쪽이 먼저)
    const hiTx = { ...BASE[0], accountId: "isa", source: "miraeasset_transaction_history", sourceRow: 101, id: "vtx:a" } as LedgerTransaction;
    const loTx = { ...BASE[0], accountId: "isa", source: "miraeasset_transaction_history", sourceRow: 99, id: "vtx:b" } as LedgerTransaction;
    expect(compareIntraDayOrder(hiTx, loTx)).toBeLessThan(0);

    // miraeasset_retirement_web 은 오름차순 (행 번호가 작은 쪽이 먼저)
    const hiRt = { ...BASE[0], accountId: "retirement", source: "miraeasset_retirement_web", sourceRow: 101, id: "vtx:a" } as LedgerTransaction;
    const loRt = { ...BASE[0], accountId: "retirement", source: "miraeasset_retirement_web", sourceRow: 99, id: "vtx:b" } as LedgerTransaction;
    expect(compareIntraDayOrder(loRt, hiRt)).toBeLessThan(0);
  });

  it("sourceRow 가 없는 거래는 그 그룹의 마지막에 간다", () => {
    const withRow = { ...BASE[0], accountId: "isa", source: "s", sourceRow: 5, id: "vtx:zzz" } as LedgerTransaction;
    const noRow = { ...BASE[0], accountId: "isa", source: "s", sourceRow: null, id: "vtx:aaa" } as LedgerTransaction;
    expect(compareIntraDayOrder(withRow, noRow)).toBeLessThan(0);
    expect(compareIntraDayOrder(noRow, withRow)).toBeGreaterThan(0);
  });
});
