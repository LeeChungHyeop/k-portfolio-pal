/**
 * HistoryEntry 의 id 멱등성 — 완료 1회가 히스토리 1건이어야 한다.
 *
 * `finalizeRebalance` 가 쓰는 머지 규칙이다. 같은 완료가 두 번 들어오는 경로는 둘:
 *   · 완료 버튼 중복 클릭
 *   · 부분 실패 후 frozen payload 재적용 (완료 envelope 복구)
 * 둘 다 id 가 `hist:<completionId>` 로 같으므로 **replace** 여야 한다.
 */
import { describe, it, expect } from "vitest";
import { upsertHistoryEntry, type HistoryEntry } from "./store";

const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "date">): HistoryEntry => ({
  baseAmount: 1_000_000,
  totalValue: 990_000,
  deposit: 0,
  returnPct: null,
  ...over,
});

describe("upsertHistoryEntry", () => {
  it("새 id 는 추가하고 날짜순으로 정렬한다", () => {
    const history = [entry({ id: "a", date: "2026-09-25" })];
    const next = upsertHistoryEntry(history, entry({ id: "b", date: "2026-08-28" }));
    expect(next.map((h) => h.id)).toEqual(["b", "a"]);
  });

  it("같은 id 는 append 가 아니라 replace 다 (중복 클릭)", () => {
    const history = [entry({ id: "hist:c1", date: "2026-10-12", totalValue: 100 })];
    const next = upsertHistoryEntry(
      history,
      entry({ id: "hist:c1", date: "2026-10-12", totalValue: 200 }),
    );
    expect(next).toHaveLength(1);
    expect(next[0].totalValue).toBe(200);
  });

  it("여러 번 재시도해도 1건이다 (멱등)", () => {
    let history: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      history = upsertHistoryEntry(history, entry({ id: "hist:c1", date: "2026-10-12" }));
    }
    expect(history).toHaveLength(1);
  });

  it("같은 날짜의 다른 기록을 건드리지 않고 제자리에서 교체한다", () => {
    const history = [
      entry({ id: "old", date: "2026-10-12", totalValue: 1 }),
      entry({ id: "hist:c1", date: "2026-10-12", totalValue: 2 }),
      entry({ id: "newer", date: "2026-10-13", totalValue: 3 }),
    ];
    const next = upsertHistoryEntry(
      history,
      entry({ id: "hist:c1", date: "2026-10-12", totalValue: 9 }),
    );
    expect(next.map((h) => h.id)).toEqual(["old", "hist:c1", "newer"]);
    expect(next[1].totalValue).toBe(9);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const history = [entry({ id: "a", date: "2026-10-13" })];
    const frozen = [...history];
    upsertHistoryEntry(history, entry({ id: "b", date: "2026-01-01" }));
    expect(history).toEqual(frozen);
  });

  it("다른 completionId 는 별개 기록이다", () => {
    let history = upsertHistoryEntry([], entry({ id: "hist:c1", date: "2026-10-12" }));
    history = upsertHistoryEntry(history, entry({ id: "hist:c2", date: "2026-10-12" }));
    expect(history.map((h) => h.id)).toEqual(["hist:c1", "hist:c2"]);
  });
});
