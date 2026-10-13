/**
 * revision guard 의 **순수 규칙**을 고정한다.
 *
 * 여기서 지키는 것:
 *   1. 가드 대상은 `_meta` + 네 계좌뿐이고, `_shared` 는 **분리**된다(동작 보존)
 *   2. 가드 대상 행에 expected revision 이 하나라도 없으면 **거부**한다 — 반쪽 가드 금지
 *   3. 구버전 서버(revision 없음)에서는 가드를 **켜지 않는다**
 *   4. 충돌은 **자동 해결이 아니다**(`autoResolvable: false`)
 *   5. 모르는 RPC 반환값을 성공으로 읽지 않는다
 */
import { describe, it, expect } from "vitest";
import {
  GUARDABLE_TYPES,
  UNGUARDED_WRITE_PATHS,
  applySavedRevisions,
  canGuard,
  conflictPrompt,
  decideHoldRecovery,
  isGuardableType,
  parseExpectedRevisions,
  OVERWRITE_WARNING,
  RELOAD_WARNING,
  readGuardedSaveResult,
  revisionsFromRows,
  splitGuardRows,
  type ExpectedRevisions,
} from "./revision-guard";
import { ACCOUNT_IDS } from "./constants";

const full: ExpectedRevisions = {
  _meta: 1, retirement: 2, isa: 3, pension: 4, irp: 5,
};

const row = (profile: string, account_type: string, data: unknown = {}) => ({
  family_code: "soye", profile, account_type, data,
});

describe("가드 대상", () => {
  it("_meta + 네 계좌뿐이다", () => {
    expect([...GUARDABLE_TYPES]).toEqual(["_meta", ...ACCOUNT_IDS]);
  });

  it.each(["_assetLib", "_family", "_system", "evil", ""])("%s 는 가드 대상이 아니다", (t) => {
    expect(isGuardableType(t)).toBe(false);
  });

  it("남아 있는 무가드 경로를 **목록으로 드러낸다**", () => {
    // 이 목록이 빌 때가 "가드 완료"다. 비어 있다고 거짓으로 적지 않기 위해 테스트로 묶는다.
    expect(UNGUARDED_WRITE_PATHS.length).toBeGreaterThan(0);
    expect(UNGUARDED_WRITE_PATHS.join("\n")).toMatch(/_shared\/_assetLib/);
    expect(UNGUARDED_WRITE_PATHS.join("\n")).toMatch(/saveFamilyRaw/);
  });
});

describe("parseExpectedRevisions", () => {
  it("정수와 null 을 받는다", () => {
    expect(parseExpectedRevisions({ _meta: 0, isa: null })).toEqual({ _meta: 0, isa: null });
  });

  it.each([
    ["객체가 아님", 1],
    ["가드 대상 아닌 키", { _assetLib: 1 }],
    ["소수", { isa: 1.5 }],
    ["음수", { isa: -1 }],
    ["문자열", { isa: "1" }],
  ])("%s → 오류", (_n, v) => {
    expect(parseExpectedRevisions(v)).toHaveProperty("error");
  });
});

describe("splitGuardRows", () => {
  it("_shared 행을 가드 밖으로 분리한다", () => {
    const r = splitGuardRows(
      [row("hyeobi", "_meta"), row("_shared", "_assetLib"), row("hyeobi", "isa")],
      full,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.guarded.map((g) => g.account_type)).toEqual(["_meta", "isa"]);
    expect(r.shared).toHaveLength(1);
  });

  it("account_type 오름차순으로 보낸다 (교착 방지 순서와 같게)", () => {
    const r = splitGuardRows(
      [row("hyeobi", "pension"), row("hyeobi", "_meta"), row("hyeobi", "irp")],
      full,
    );
    expect(r.ok && r.guarded.map((g) => g.account_type)).toEqual(["_meta", "irp", "pension"]);
  });

  it("expected revision 이 없는 행은 **거부**한다 (조용히 무가드로 보내지 않는다)", () => {
    const r = splitGuardRows([row("hyeobi", "isa")], { _meta: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("isa");
  });

  it("중복 account_type 을 거부한다", () => {
    expect(splitGuardRows([row("hyeobi", "isa"), row("hyeobi", "isa")], full).ok).toBe(false);
  });

  it("가드 대상이 아닌 account_type 을 거부한다", () => {
    expect(splitGuardRows([row("hyeobi", "_family")], full).ok).toBe(false);
  });

  it("expected revision 값을 그대로 싣는다 (null 포함)", () => {
    const r = splitGuardRows([row("hyeobi", "isa")], { ...full, isa: null });
    expect(r.ok && r.guarded[0].expected_revision).toBeNull();
  });
});

describe("revisionsFromRows / canGuard", () => {
  it("행별 revision 을 읽고, 없는 행은 null 이다", () => {
    const r = revisionsFromRows(
      [{ profile: "hyeobi", account_type: "isa", revision: 7 }],
      "hyeobi",
    );
    expect(r.isa).toBe(7);
    expect(r._meta).toBeNull();
    expect(canGuard(r)).toBe(true);
  });

  it("다른 프로필 행은 무시한다", () => {
    const r = revisionsFromRows(
      [{ profile: "dayoung", account_type: "isa", revision: 7 }],
      "hyeobi",
    );
    expect(r.isa).toBeNull();
  });

  it("**구버전 서버**(revision 미보고)에서는 가드를 켜지 않는다", () => {
    // 구버전 서버 응답: data 는 오지만 revision 이 없다
    const legacyRow = { profile: "hyeobi", account_type: "isa", data: { cashBalance: 1 } };
    const r = revisionsFromRows([legacyRow], "hyeobi");
    expect("isa" in r).toBe(false);
    expect(canGuard(r)).toBe(false);
  });

  it("revision 이 없을 때 0 으로 가정하지 않는다", () => {
    const r = revisionsFromRows([{ profile: "hyeobi", account_type: "isa" }], "hyeobi");
    expect(r.isa).toBeUndefined();
  });

  it("null 표는 가드할 수 없다", () => {
    expect(canGuard(null)).toBe(false);
  });

  it("저장 성공 응답으로 표를 갱신한다", () => {
    expect(applySavedRevisions(full, { isa: 99 })!.isa).toBe(99);
    // 응답에 없는 키는 그대로
    expect(applySavedRevisions(full, { isa: 99 })!._meta).toBe(1);
    // 응답이 비면 표를 그대로 둔다
    expect(applySavedRevisions(full, {})).toEqual(full);
    expect(applySavedRevisions(full, undefined)).toEqual(full);
  });
});

describe("readGuardedSaveResult", () => {
  it("saved", () => {
    const r = readGuardedSaveResult({ outcome: "saved", revisions: { isa: 8 }, accepted: 1 });
    expect(r).toEqual({ kind: "saved", revisions: { isa: 8 }, accepted: 1 });
  });

  it("conflict — 이유와 현재 revision 을 읽는다", () => {
    const r = readGuardedSaveResult({
      outcome: "conflict",
      conflicts: [
        { account_type: "isa", reason: "revision_mismatch", expected_revision: 3, current_revision: 5 },
        { account_type: "irp", reason: "history_shrink", expected_revision: 1, current_revision: 1, missing_history_ids: ["h1"] },
      ],
      revisions: { isa: 5, _meta: null },
    });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    expect(r.conflicts[0]).toMatchObject({ accountType: "isa", reason: "revision_mismatch", currentRevision: 5 });
    expect(r.conflicts[1].missingHistoryIds).toEqual(["h1"]);
    expect(r.revisions).toEqual({ isa: 5, _meta: null });
  });

  it("key_loss 는 빠진 키를 들고 온다", () => {
    const r = readGuardedSaveResult({
      outcome: "conflict",
      conflicts: [{ account_type: "isa", reason: "key_loss", lost_keys: ["cashflows", "cashBalance"] }],
    });
    expect(r.kind === "conflict" && r.conflicts[0].lostKeys).toEqual(["cashflows", "cashBalance"]);
  });

  it.each([
    null, undefined, 1, "saved", {}, { outcome: "ok" },
    { outcome: "conflict" },
    { outcome: "conflict", conflicts: [] },
    { outcome: "conflict", conflicts: [{ account_type: "isa", reason: "뭔가" }] },
  ])("%s 는 unexpected 다 (성공으로 읽지 않는다)", (raw) => {
    expect(readGuardedSaveResult(raw).kind).toBe("unexpected");
  });
});

describe("decideHoldRecovery — 보류는 저장으로 풀리지 않는다", () => {
  it("서버가 revision 을 못 주면 **계속 보류**다", () => {
    expect(decideHoldRecovery(null).kind).toBe("stay_held");
    expect(decideHoldRecovery({ _meta: 1 }).kind).toBe("stay_held"); // 일부만 알아도 보류
  });

  it("revision 을 받아도 **사용자 선택**으로 간다 (자동 저장 분기가 없다)", () => {
    const d = decideHoldRecovery(full);
    expect(d.kind).toBe("needs_user_choice");
    if (d.kind !== "needs_user_choice") return;
    expect(d.conflicts.every((c) => c.reason === "base_unknown")).toBe(true);
    expect(d.conflicts.map((c) => c.accountType).sort()).toEqual([...GUARDABLE_TYPES].sort());
  });

  it("**받아온 revision 을 expected(base)로 쓰지 않는다**", () => {
    const d = decideHoldRecovery(full);
    if (d.kind !== "needs_user_choice") throw new Error("선택이어야 한다");
    // base 를 모른다는 사실을 그대로 남긴다 — 서버 값은 current 로만 들고 온다.
    expect(d.conflicts.every((c) => c.expectedRevision === null)).toBe(true);
    expect(d.conflicts.find((c) => c.accountType === "isa")!.currentRevision).toBe(full.isa);
  });

  it("base_unknown 도 자동 해결이 아니다", () => {
    const d = decideHoldRecovery(full);
    if (d.kind !== "needs_user_choice") throw new Error("선택이어야 한다");
    const p = conflictPrompt(d.conflicts);
    expect(p.autoResolvable).toBe(false);
    expect(p.message).toMatch(/어느 버전에서 시작됐는지/);
    expect(p.message).toMatch(/사라집니다/);
  });

  it("서버 응답으로 base_unknown 이 들어와도 **읽지 않는다** (서버 사유가 아니다)", () => {
    const r = readGuardedSaveResult({
      outcome: "conflict",
      conflicts: [{ account_type: "isa", reason: "base_unknown" }],
    });
    expect(r.kind).toBe("unexpected");
  });
});

describe("conflictPrompt — 자동 해결이 없다", () => {
  it("autoResolvable 은 항상 false 다", () => {
    const p = conflictPrompt([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 1, currentRevision: 2 },
    ]);
    expect(p.autoResolvable).toBe(false);
    expect(p.message).toContain("선택");
  });

  it("**본문에 데이터 유실 가능성을 적는다**", () => {
    const p = conflictPrompt([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 1, currentRevision: 2 },
    ]);
    expect(p.message).toMatch(/사라집니다/);
  });

  it("두 선택의 경고가 **무엇이 사라지는지** 각각 말한다", () => {
    const p = conflictPrompt([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 1, currentRevision: 2 },
    ]);
    // 서버 내용 불러오기 → 미저장 로컬 수정이 사라진다
    expect(p.reloadWarning).toBe(RELOAD_WARNING);
    expect(p.reloadWarning).toMatch(/저장되지 않은/);
    expect(p.reloadWarning).toMatch(/지금 화면의 수정은 모두 사라집니다/);
    // 덮어쓰기 → 서버의 더 새로운 수정이 사라진다
    expect(p.overwriteWarning).toBe(OVERWRITE_WARNING);
    expect(p.overwriteWarning).toMatch(/다른 기기/);
    expect(p.overwriteWarning).toMatch(/더 새로운 수정은 모두 사라집니다/);
    expect(p.reloadWarning).not.toBe(p.overwriteWarning);
  });

  it("이유를 중복 없이 모은다", () => {
    const p = conflictPrompt([
      { accountType: "isa", reason: "revision_mismatch", expectedRevision: 1, currentRevision: 2 },
      { accountType: "irp", reason: "revision_mismatch", expectedRevision: 1, currentRevision: 2 },
      { accountType: "irp", reason: "key_loss", expectedRevision: 1, currentRevision: 1 },
    ]);
    expect(p.reasons).toEqual(["revision_mismatch", "key_loss"]);
    expect(p.accountTypes).toEqual(["irp", "isa"]);
  });

  it("history 축소·키 유실은 '빠져 있다'고 말한다 (덮어쓰기 전에 보이게)", () => {
    expect(conflictPrompt([
      { accountType: "isa", reason: "history_shrink", expectedRevision: 1, currentRevision: 1 },
    ]).message).toContain("기록이 빠져");
  });
});
