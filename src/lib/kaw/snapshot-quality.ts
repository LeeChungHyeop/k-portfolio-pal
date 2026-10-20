// ─────────────────────────────────────────────────────────────────────────────
// 일별 스냅샷 품질 판정 — 읽기 단계의 순수 모듈 (Phase 4-E-B)
//
// 계좌 이전(broker_sync) 전에 만들어진 스냅샷은 **옛 증권사의 수량·예수금**으로 계산돼 있다.
// 그 행들을 고치거나 지우지 않는다(원본 보존). 읽는 쪽이 이 모듈로 행마다 품질을 판정하고,
// 오염된 행은 성과 계산에서 빼며, 그 날짜를 지나는 구간은 확정 수익률로 이어붙이지 않는다.
//
// ## 판정 근거 (두 층)
//
//   1차  brokerSyncs[].affectedSnapshots.dates — 동기화를 승인할 때 감사 기록으로 남긴 날짜들
//   교차  holdingsEffectiveFrom ≤ 스냅샷 날짜  **그리고**  스냅샷 updated_at < 동기화 approvedAt
//         = "새 수량이 확정되기 전에 쓰인, 효력일 이후 날짜의 행" 이라는 독립 규칙
//
//   두 층이 모두 가리키면 확실하고, 한쪽만 가리켜도 **제외**한다(보수적). 어긋남은 crossCheck 로 남긴다.
//   updated_at 이 없으면 교차 검증은 불가(`unverifiable`)이며 1차 근거만으로 판정한다.
//
// ## 경계 (boundary)
//
//   transfer.anchorDate(계좌 이전 회계 기준일)의 스냅샷은 정상/오류를 단정하지 않는다.
//   실제 청산일이 확정되지 않았기 때문이다. 제외하지 않고 `boundary` 로 표시하며,
//   이 날짜를 포함하는 구간은 확정 수익률을 내지 않는다.
//
// ## 하지 않는 것
//   · 행을 수정·삭제·보정하지 않는다 — 입력 배열을 그대로 두고 판정 결과만 돌려준다
//   · anchorDate 이전 데이터를 "정상"이라고 보증하지 않는다 (ok 는 '이 규칙으로는 오염 근거 없음' 일 뿐이다)
//   · broker_sync 가 없는 계좌는 아무것도 바꾸지 않는다
// ─────────────────────────────────────────────────────────────────────────────

import { asBrokerSyncs } from "./broker-sync-basis";

export type SnapshotQualityKind = "excluded" | "boundary";

/** 두 근거가 서로 맞는지. unverifiable = 교차 검증에 필요한 값(updated_at)이 없다 */
export type SnapshotCrossCheck = "agree" | "primary_only" | "independent_only" | "unverifiable";

export interface SnapshotFlag {
  accountId: string;
  date: string;
  kind: SnapshotQualityKind;
  reasons: readonly string[];
  crossCheck: SnapshotCrossCheck;
  /** 이 판정을 낸 동기화 기록 id */
  syncId: string;
}

/** 판정에 필요한 스냅샷 행의 모양 (성과 계산용 행의 부분집합) */
export interface QualityRow {
  accountId: string;
  snapshotDate: string;
  /** 서버가 행을 마지막으로 쓴 시각(ISO). 없으면 교차 검증을 못 한다 */
  updatedAt?: string | null;
}

const isIsoDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

function writtenBefore(updatedAt: string | null | undefined, approvedAt: string): boolean | null {
  if (!updatedAt) return null;
  const u = Date.parse(updatedAt);
  const a = Date.parse(approvedAt);
  if (!Number.isFinite(u) || !Number.isFinite(a)) return null;
  return u < a;
}

/**
 * 계좌별 brokerSyncs 와 스냅샷 행으로 품질 flag 를 만든다.
 * `syncsByAccount[accountId]` 는 `AccountState.brokerSyncs` 그대로(모양이 틀린 항목은 무시된다).
 * 동기화 기록의 accountType 과 계좌가 다르면 그 기록은 그 계좌에 적용하지 않는다.
 */
export function classifySnapshotQuality(
  rows: readonly QualityRow[],
  syncsByAccount: Readonly<Record<string, unknown>>,
): SnapshotFlag[] {
  const flags = new Map<string, SnapshotFlag>();

  for (const [accountId, rawSyncs] of Object.entries(syncsByAccount)) {
    const syncs = asBrokerSyncs(rawSyncs).filter((s) => s.accountType === accountId);
    if (!syncs.length) continue;
    const accountRows = rows.filter((r) => r.accountId === accountId);

    for (const sync of syncs) {
      const primary = new Set((sync.affectedSnapshots?.dates ?? []).filter(isIsoDate));
      const effectiveFrom = sync.holdingsEffectiveFrom;

      // ── excluded: 1차(감사 기록) ∪ 독립 규칙(효력일 이후 + 승인 전에 쓰인 행) ──
      const independent = new Map<string, boolean | null>(); // date → 독립 규칙 결과 (null = 판정 불가)
      for (const r of accountRows) {
        if (!isIsoDate(effectiveFrom) || r.snapshotDate < effectiveFrom) continue;
        independent.set(r.snapshotDate, writtenBefore(r.updatedAt, sync.approvedAt));
      }

      const candidates = new Set<string>([...primary, ...[...independent].filter(([, v]) => v === true).map(([d]) => d)]);
      for (const date of candidates) {
        const inPrimary = primary.has(date);
        const ind = independent.get(date); // true | false | null | undefined(행 없음)
        const crossCheck: SnapshotCrossCheck =
          inPrimary && ind === true ? "agree"
          : inPrimary && (ind === null || ind === undefined) ? "unverifiable"
          : inPrimary ? "primary_only"
          : "independent_only";
        const reasons = [
          ...(inPrimary ? ["동기화 감사 기록(affectedSnapshots)에 오염 후보로 기록됨"] : []),
          ...(ind === true ? ["보유수량 효력일 이후 날짜인데 동기화 승인 전에 쓰인 행(옛 증권사 수량·예수금)"] : []),
        ];
        put(flags, { accountId, date, kind: "excluded", reasons, crossCheck, syncId: sync.id });
      }

      // ── boundary: 계좌 이전 회계 기준일 ────────────────────────────────────
      const anchorDate = sync.transfer?.anchorDate;
      if (isIsoDate(anchorDate) && !flags.has(key(accountId, anchorDate))) {
        put(flags, {
          accountId, date: anchorDate, kind: "boundary",
          reasons: ["계좌 이전 회계 기준일 — 실제 청산일이 확정되지 않아 정상/오류를 단정하지 않음"],
          crossCheck: "unverifiable", syncId: sync.id,
        });
      }
    }
  }

  return [...flags.values()].sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId));
}

const key = (accountId: string, date: string) => `${accountId}|${date}`;

function put(map: Map<string, SnapshotFlag>, f: SnapshotFlag): void {
  const k = key(f.accountId, f.date);
  const prev = map.get(k);
  // excluded 가 boundary 보다 우선한다. 같은 종류면 먼저 만든 것을 유지한다.
  if (!prev || (prev.kind === "boundary" && f.kind === "excluded")) map.set(k, f);
}

/** 성과 계산에 넣을 수 있는 행(제외 flag 가 없는 행)과 제외된 행. 원본 배열은 건드리지 않는다. */
export function splitByQuality<T extends QualityRow>(
  rows: readonly T[],
  flags: readonly SnapshotFlag[],
): { usable: T[]; excluded: T[] } {
  const bad = new Set(flags.filter((f) => f.kind === "excluded").map((f) => key(f.accountId, f.date)));
  const usable: T[] = [];
  const excluded: T[] = [];
  for (const r of rows) (bad.has(key(r.accountId, r.snapshotDate)) ? excluded : usable).push(r);
  return { usable, excluded };
}
