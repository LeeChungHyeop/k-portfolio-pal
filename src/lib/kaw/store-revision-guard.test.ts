/**
 * 클라이언트 쪽 가드 규칙 회귀 잠금.
 *
 * 이 규칙들은 **모듈 전역 상태와 React 훅 안에 있어서 순수 함수로 호출할 수 없다.**
 * 그래서 store-write-path.test.ts 와 같은 방식으로, 규칙을 깨는 코드가 **구현에 없다는
 * 것**을 직접 확인한다.
 *
 * 잠그는 것:
 *   1. 409 를 받으면 **자동 재시도하지 않고** 충돌 상태로 멈춘다
 *   2. 충돌이 남아 있는 동안 **폴링이 사용자 입력을 덮지 않는다**
 *   3. 충돌 응답의 revision 을 **자동 반영하지 않는다**(반영하면 다음 저장이 조용히 덮는다)
 *   4. 단건 ACK write 도 **같은 가드**를 지난다 (완료 저장이 가드 밖으로 빠지지 않는다)
 *   5. 파괴적 저장 허용은 **사용자 행동에서만** 켜진다
 *   6. 가드는 flag + 읽은 revision 이 **둘 다** 있을 때만 켜진다
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  REVISION_GUARD_ENV_KEY, REVISION_GUARD_LS_KEY, resolveRevisionGuardFlag,
} from "./rebalance-feature-flags";

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const storeSrc = read("store.ts");
const guardSrc = read("revision-guard.ts");
const serverSrc = read("data-server.ts");
const sidebarSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "components", "kaw", "Sidebar.tsx"),
  "utf8",
);

/** 함수 본문을 이름으로 잘라낸다(다음 top-level 선언까지). */
function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  expect(start, `${header} 가 없다`).toBeGreaterThan(-1);
  const next = src.indexOf("\n}", start);
  return src.slice(start, next);
}

describe("409 는 자동으로 풀지 않는다", () => {
  it("dbSave 는 409 를 충돌 상태로 올리고 **그 자리에서 끝낸다**", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    expect(body).toContain("res.status === 409");
    expect(body).toContain("markDataConflict");
    // 재시도 루프·재귀 호출이 없다 (선언 헤더는 빼고 본다)
    const inner = body.replace("async function dbSave(", "");
    expect(inner).not.toMatch(/for\s*\(|while\s*\(/);
    expect(inner).not.toMatch(/setTimeout\(/);
    expect(inner).not.toMatch(/dbSave\(/);
    expect(inner).not.toMatch(/enqueueFullSave\(/);
  });

  it("충돌이 남아 있으면 저장을 **시도조차 하지 않는다**", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    // 보류(dbHold)도 같은 자리에서 막는다 — 둘 다 "복구 전 재시도 금지"다.
    expect(body).toMatch(/if \(dbConflict \|\| dbHold \|\| dbRefreshRequired\) return;/);
  });

  it("markDataConflict 는 revisions 를 갱신하지 않는다", () => {
    const body = fnBody(storeSrc, "function markDataConflict(");
    // `revisions = ...` 가 있으면 다음 자동저장이 CAS 를 통과해 서버를 조용히 덮는다.
    expect(body).not.toMatch(/\brevisions\s*=/);
    expect(body).toContain("serverRevisions");
  });

  it("자동 병합 경로가 없다 — 해결 함수는 UI 에서만 호출된다", () => {
    expect(storeSrc).not.toMatch(/autoResolve|autoMerge|mergeConflict/);
    // 저장·폴링 안에서 해결 함수를 부르지 않는다(부르면 그게 자동 해결이다).
    const dbSave = fnBody(storeSrc, "async function dbSave(");
    const polling = storeSrc.slice(
      storeSrc.indexOf("function startPolling"),
      storeSrc.indexOf("function stopPolling"),
    );
    for (const body of [dbSave, polling]) {
      expect(body).not.toContain("reloadFromServer(");
      expect(body).not.toContain("overwriteServerWithLocal(");
    }
  });
});

describe("충돌 중에는 사용자 입력을 덮지 않는다", () => {
  it("폴링이 충돌 상태를 보고 반영을 건너뛴다", () => {
    const body = storeSrc.slice(
      storeSrc.indexOf("function startPolling"),
      storeSrc.indexOf("function stopPolling"),
    );
    const guards = body.match(/if \(dbConflict\) return/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2); // 조회 전 + 조회 후
  });

  it("가시성 복귀도 같은 가드를 쓴다", () => {
    const start = storeSrc.indexOf("function setupVisibilityRefresh");
    const body = storeSrc.slice(start, storeSrc.indexOf("// ── Async init", start));
    expect(body).toMatch(/if \(dbConflict\) return/);
  });

  it("충돌 해결은 **두 가지 선택**으로만 노출된다", () => {
    expect(storeSrc).toContain("export async function reloadFromServer");
    expect(storeSrc).toContain("export async function overwriteServerWithLocal");
    expect(sidebarSrc).toContain("reloadFromServer");
    expect(sidebarSrc).toContain("overwriteServerWithLocal");
    // 사용자에게 무엇을 버리는지 알린다 (문구는 revision-guard.ts 의 상수다)
    expect(sidebarSrc).toContain("prompt.reloadWarning");
    expect(sidebarSrc).toContain("prompt.overwriteWarning");
    expect(guardSrc).toMatch(/사라집니다/);
  });

  it("덮어쓰기는 서버 revision 을 다시 읽고 **화면 내용을 정본으로** 쓴다", () => {
    const body = fnBody(storeSrc, "export async function overwriteServerWithLocal(");
    expect(body).toContain("const local = memState");
    expect(body).toContain("await dbLoad(");
    expect(body).toContain("memState = local");
    expect(body).toContain("forceOverwriteOnce = true");
  });
});

describe("단건 ACK write 도 가드를 지난다", () => {
  it("postAccountRow 가 guardFields 를 싣는다", () => {
    const body = storeSrc.slice(
      storeSrc.indexOf("async function postAccountRow"),
      storeSrc.indexOf("export function saveAccountRowWithAck"),
    );
    expect(body).toContain("...guardFields()");
    expect(body).toContain("res.status === 409");
    // 409 는 ACK 가 아니다 — ok:false 로 돌려줘야 호출부가 failed 로 받는다
    expect(body).toMatch(/status:\s*409/);
    expect(body).toMatch(/ok:\s*false[\s\S]{0,120}409/);
  });

  it("가드 요청 필드는 한 곳에서만 만들어진다 (경로별로 갈라지지 않는다)", () => {
    const uses = storeSrc.match(/\.\.\.guardFields\(\)/g) ?? [];
    expect(uses.length).toBe(2); // dbSave + postAccountRow
    expect(storeSrc.match(/expectedRevisions:/g) ?? []).toHaveLength(1);
  });
});

describe("파괴적 저장 허용은 사용자 행동에서만 켜진다", () => {
  it("기록 삭제가 축소 허용을 1회만 켠다", () => {
    expect(storeSrc).toMatch(/markIntentionalHistoryShrink\(\);\s*\n\s*setState/);
  });

  it("초기화·가져오기가 키 유실 허용을 1회만 켠다", () => {
    const resetAll = storeSrc.slice(storeSrc.indexOf("const resetAll"), storeSrc.indexOf("const importJson"));
    expect(resetAll).toContain("markIntentionalDocumentReplace()");
    const importJson = storeSrc.slice(storeSrc.indexOf("const importJson"), storeSrc.indexOf("const updateAssetLibrary"));
    expect(importJson).toContain("markIntentionalDocumentReplace()");
  });

  it("자동저장이 allow 플래그를 켜는 경로가 없다", () => {
    const setters = storeSrc.match(/allow(HistoryShrink|KeyLoss)Once = true/g) ?? [];
    // 켜는 곳은 마커 함수 둘뿐이다(= 사용자 행동에서만 호출된다)
    expect(setters).toHaveLength(3); // markIntentionalHistoryShrink + markIntentionalDocumentReplace 의 두 줄
    const dbSave = fnBody(storeSrc, "async function dbSave(");
    expect(dbSave).not.toMatch(/allow(HistoryShrink|KeyLoss)Once = true/);
  });

  it("허용은 **저장 성공 후에만** 내려간다", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    const okIdx = body.indexOf("revisions = applySavedRevisions");
    const clearIdx = body.indexOf("allowHistoryShrinkOnce = false");
    expect(okIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(okIdx);
  });
});

describe("가드는 flag + revision 이 둘 다 있을 때만 켜진다", () => {
  it("guardFields 가 flag 와 canGuard 를 함께 본다", () => {
    const body = fnBody(storeSrc, "function guardFields(");
    expect(body).toContain("isRevisionGuardEnabled()");
    expect(body).toContain("canGuard(revisions)");
    expect(body).toMatch(/return \{\};/); // 꺼져 있으면 기존 무가드 요청 그대로
  });

  it("flag 는 기본 OFF 이고 production 에서 localStorage 로 켜지지 않는다", () => {
    expect(resolveRevisionGuardFlag({ env: undefined, local: null, dev: false })).toBe(false);
    expect(resolveRevisionGuardFlag({ env: undefined, local: "on", dev: false })).toBe(false);
    expect(resolveRevisionGuardFlag({ env: undefined, local: "on", dev: true })).toBe(true);
    expect(resolveRevisionGuardFlag({ env: "on", local: null, dev: false })).toBe(true);
    expect(resolveRevisionGuardFlag({ env: "off", local: null, dev: true })).toBe(false);
  });

  it("flag 키가 세션 추적 flag 와 **다르다** (따로 켜고 끈다)", () => {
    expect(REVISION_GUARD_ENV_KEY).toBe("VITE_KAW_DATA_REVISION_GUARD");
    expect(REVISION_GUARD_LS_KEY).toBe("kaw-data-revision-guard");
  });

  it("외부에서 revision 을 넣는 경로는 **표에 이미 있는 키만** 갱신한다", () => {
    // 없는 키를 만들어주면 canGuard 가 false 인 상태(base 미확보)를 뚫고 저장이 나간다.
    const body = fnBody(storeSrc, "export function noteServerRevision(");
    expect(body).toContain("!(accountType in revisions)");
    expect(body).toContain("applySavedRevisions");
    expect(body).not.toContain("dbSave");
    expect(body).not.toContain("enqueueFullSave");
  });

  it("무가드 경로 목록이 코드에 남아 있다 (보호 완료라고 적지 않는다)", () => {
    expect(guardSrc).toContain("UNGUARDED_WRITE_PATHS");
    expect(guardSrc).toMatch(/saveFamilyRaw/);
  });
});

describe("revision 미확보 = fail-closed (무가드 강등 금지)", () => {
  it("가드 ON + revision 모름이면 **요청을 보내지 않고** 보류한다", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    // fetch 보다 **앞에서** 판정하고 즉시 return 한다
    const check = body.indexOf("isRevisionGuardEnabled() && !canGuard(revisions)");
    const fetchAt = body.indexOf("await fetch(");
    expect(check).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(check);
    expect(body.slice(check, check + 200)).toContain("markRevisionHold(); return;");
  });

  it("보류 중에는 자동저장을 **시도조차 하지 않는다** (복구 전 재시도 금지)", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    expect(body).toMatch(/if \(dbConflict \|\| dbHold \|\| dbRefreshRequired\) return;/);
  });

  it("보류는 **로컬 입력을 건드리지 않는다** (memState / localStorage 그대로)", () => {
    const body = fnBody(storeSrc, "function markRevisionHold(");
    expect(body).not.toMatch(/memState\s*=/);
    expect(body).not.toContain("saveLocal(");
    expect(body).not.toContain("dbLoad(");
    // 원인을 사용자에게 알린다
    expect(body).toMatch(/dbError\s*=/);
    expect(body).toContain("notify()");
    expect(body).toMatch(/남아 있습니다/);
    // "자동으로 저장한다"고 약속하지 않는다 — 복구는 사용자 선택으로 간다
    expect(body).not.toMatch(/자동으로 저장/);
  });

  it("복구는 **조회만** 하고 받아온 데이터를 반영하지 않는다", () => {
    const body = fnBody(storeSrc, "async function recoverRevisionHold(");
    expect(body).toContain("await dbLoad(");
    expect(body).not.toMatch(/memState\s*=\s*migrateState/);
    expect(body).not.toContain("saveLocal(");
  });

  it("**복구가 자동저장으로 이어지지 않는다** (오래된 로컬 JSON 을 올리지 않는다)", () => {
    const body = fnBody(storeSrc, "async function recoverRevisionHold(");
    expect(body).not.toContain("enqueueFullSave");
    expect(body).not.toContain("dbSave(");
    // 조회가 성공하면 **사용자 선택**(충돌)으로 전환된다
    expect(body).toContain("decideHoldRecovery(fetched)");
    expect(body).toContain('decision.kind === "stay_held"');
    expect(body).toMatch(/dbConflict\s*=\s*\{/);
  });

  it("**받아온 revision 을 base 로 승격하지 않는다**", () => {
    const body = fnBody(storeSrc, "async function recoverRevisionHold(");
    // 조회 전 값으로 되돌려 둔다 — 그 값이 base 가 되면 CAS 가 통과해 서버가 덮인다.
    expect(body).toContain("const beforeFetch = revisions;");
    expect(body).toContain("revisions = beforeFetch;");
    // 서버 값은 사용자 선택용으로만 들고 있는다
    expect(body).toContain("serverRevisions: fetched");
  });

  it("선택 전까지 로컬 미저장 데이터가 유지된다 (저장도 폐기도 하지 않는다)", () => {
    const body = fnBody(storeSrc, "async function recoverRevisionHold(");
    expect(body).not.toMatch(/memState\s*=/);
    // dbConflict 가 세워지면 dbSave 와 폴링 반영이 둘 다 멈춘다(위 테스트들이 고정)
    expect(body).toMatch(/dbHold = null;[\s\S]{0,200}dbConflict = \{/);
  });

  it("폴링·가시성 복귀가 보류 복구만 돌리고 반영을 건너뛴다", () => {
    const polling = storeSrc.slice(
      storeSrc.indexOf("function startPolling"),
      storeSrc.indexOf("function stopPolling"),
    );
    expect(polling).toMatch(/if \(dbHold\) \{ await recoverRevisionHold\(\)[\s\S]{0,40}return; \}/);
    expect(polling).toMatch(/if \(dbHold\) return;/); // 조회 중 보류 발생 시에도 반영 안 함
    const vis = storeSrc.slice(
      storeSrc.indexOf("function setupVisibilityRefresh"),
      storeSrc.indexOf("// ── Async init"),
    );
    expect(vis).toContain("recoverRevisionHold()");
  });

  it("서버 RPC 실패는 여전히 fail-closed 다 (무가드 upsert 로 떨어지지 않는다)", () => {
    const post = serverSrc.slice(
      serverSrc.indexOf("export async function handleDataPost"),
      serverSrc.indexOf("// ── 시세 캐시용 ticker"),
    );
    // 가드 경로에 들어온 뒤의 모든 실패 분기가 응답으로 끝난다
    const guardStart = post.indexOf("const expected = parseExpectedRevisions");
    const guardPart = post.slice(guardStart);
    expect(guardPart).toMatch(/isUndefinedFunction[\s\S]{0,400}503/);
    expect(guardPart).toMatch(/isSerializationFailure[\s\S]{0,200}409/);
    expect(guardPart).toMatch(/kind === "unexpected"[\s\S]{0,200}500/);
    // 가드 경로 안에서 프로필 행을 upsert 하는 코드가 없다(공용 행만 허용)
    const upserts = [...guardPart.matchAll(/upsert\(([A-Za-z]+)/g)].map((m) => m[1]);
    expect(upserts).toEqual(["sharedRows"]);
  });

  it("보류 상태와 다시 시도 버튼이 UI 에 노출된다", () => {
    expect(storeSrc).toContain("export function retryHeldSave");
    expect(sidebarSrc).toContain("dbHold");
    expect(sidebarSrc).toContain("retryHeldSave");
    expect(sidebarSrc).toMatch(/다시 시도/);
  });
});

describe("409 해결 UI — 보이는 경고 + 확인 단계", () => {
  it("경고를 **본문 글자로** 띄운다 (title 툴팁 의존 금지 — 터치 환경)", () => {
    expect(sidebarSrc).toContain("prompt.reloadWarning");
    expect(sidebarSrc).toContain("prompt.overwriteWarning");
    // 되돌릴 수 없는 폐기를 title 에만 적어두지 않는다
    expect(sidebarSrc).not.toMatch(/title="[^"]*사라집니다/);
  });

  it("두 동작 모두 **확인 단계**를 거친다 (한 번의 클릭으로 실행되지 않는다)", () => {
    const banner = sidebarSrc.slice(
      sidebarSrc.indexOf("{dbConflict && ("),
      sidebarSrc.indexOf("{dbHold && !dbConflict && ("),
    );
    // 1단계 버튼은 확인 단계로만 보낸다
    expect(banner).toContain('onClick={() => setConfirming("reload")}');
    expect(banner).toContain('onClick={() => setConfirming("overwrite")}');
    // 실제 실행은 확인 단계 안에서만 일어난다
    const confirmStep = banner.slice(banner.indexOf("confirming === null ?"));
    expect(confirmStep).toContain("await reloadFromServer()");
    expect(confirmStep).toContain("await overwriteServerWithLocal()");
    expect(confirmStep).toMatch(/되돌릴 수 없습니다/);
    expect(confirmStep).toMatch(/취소/);
  });

  it("실행 함수가 1단계 버튼에 직접 묶이지 않았다", () => {
    const firstStep = sidebarSrc.slice(
      sidebarSrc.indexOf('onClick={() => setConfirming("reload")}'),
      sidebarSrc.indexOf("confirming === null ?") + 1,
    );
    expect(firstStep).not.toContain("reloadFromServer(");
  });
});

describe("revision 보호 검증 상태 — 완료 기록 삭제의 근거 (1B-3B)", () => {
  const status = () => fnBody(storeSrc, "export function getRevisionProtectionStatus(");

  it("네 조건을 **모두** 요구한다 (flag · revision · 충돌/보류 없음 · 가드 저장 성공)", () => {
    const body = status();
    expect(body).toContain("!isRevisionGuardEnabled()");
    expect(body).toContain("!canGuard(revisions)");
    expect(body).toContain("dbConflict");
    expect(body).toContain("dbHold");
    expect(body).toContain("!guardedSaveVerified");
    // 마지막에만 verified: true 가 나온다
    const trues = body.match(/verified:\s*true/g) ?? [];
    expect(trues).toHaveLength(1);
    expect(body.lastIndexOf("verified: true")).toBeGreaterThan(body.indexOf("!guardedSaveVerified"));
  });

  it("**서버가 guarded: true 로 말한 저장에서만** 검증됨으로 올라간다", () => {
    const sets = [...storeSrc.matchAll(/guardedSaveVerified = true/g)];
    expect(sets).toHaveLength(2); // dbSave + 단건 ACK write
    for (const m of sets) {
      expect(storeSrc.slice(Math.max(0, m.index! - 120), m.index!)).toContain("guarded === true");
    }
  });

  it("충돌·보류가 나면 검증됨이 내려간다", () => {
    expect(fnBody(storeSrc, "function markDataConflict(")).toContain("guardedSaveVerified = false");
    expect(fnBody(storeSrc, "function markRevisionHold(")).toContain("guardedSaveVerified = false");
  });

  it("기본 상태(flag OFF)에서는 검증되지 않는다", async () => {
    const { getRevisionProtectionStatus } = await import("./store");
    const r = getRevisionProtectionStatus();
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/꺼져 있어/);
  });
});

describe("서버 무가드 차단(428) — 클라이언트는 성공으로 보지 않고 다시 보내지 않는다", () => {
  it("dbSave: 428 이면 새로고침 필요 상태로 멈추고 throw·재시도 없이 끝난다", () => {
    const body = fnBody(storeSrc, "async function dbSave(");
    const at = body.indexOf("res.status === 428");
    expect(at).toBeGreaterThan(-1);
    const branch = body.slice(at, body.indexOf("}", body.indexOf("return;", at)) + 1);
    expect(branch).toContain("markRefreshRequired()");
    expect(branch).toContain("return;");
    // 성공 처리(revisions 갱신·guardedSaveVerified)보다 앞에서 끝난다
    expect(at).toBeLessThan(body.indexOf("applySavedRevisions"));
    expect(body).toMatch(/if \(dbConflict \|\| dbHold \|\| dbRefreshRequired\) return;/);
  });

  it("단건 write: 428 은 ACK 가 아니고, 이후 요청은 fetch 없이 바로 실패한다", () => {
    const body = fnBody(storeSrc, "async function postAccountRow(");
    expect(body).toMatch(/if \(dbRefreshRequired\) return \{ ok: false, error: REFRESH_REQUIRED_MESSAGE, status: 428 \};/);
    expect(body.indexOf("if (dbRefreshRequired)")).toBeLessThan(body.indexOf("fetch("));
    const at = body.indexOf("res.status === 428");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(body.indexOf("applySavedRevisions"));
    expect(body.slice(at, at + 200)).toContain("ok: false");
  });

  it("markRefreshRequired 는 안내만 하고 로컬 입력·revision 을 건드리지 않으며 재전송을 예약하지 않는다", () => {
    const body = fnBody(storeSrc, "function markRefreshRequired(");
    expect(body).toContain("dbError = REFRESH_REQUIRED_MESSAGE");
    expect(body).toContain("notify()");
    expect(body).not.toMatch(/memState\s*=|revisions\s*=|saveLocal\(|scheduleSave\(|enqueue|setTimeout|fetch\(/);
    expect(storeSrc).toMatch(/REFRESH_REQUIRED_MESSAGE =\s*"저장되지 않았습니다:[^"]*새로고침/);
  });
});
