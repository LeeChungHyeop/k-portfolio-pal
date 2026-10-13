/**
 * 서버 write 경로 회귀 잠금.
 *
 * 여기서 고정하는 규칙은 **React 훅/모듈 전역 상태 안에 있어서 순수 함수로 호출할 수
 * 없다.** 그래서 `contribution.test.ts` 의 "리밸런싱 저장 → cashflow 변화 없음" 과 같은
 * 방식으로, 그 규칙을 깨는 코드가 **구현에 없다는 것**을 직접 확인한다.
 *
 * 잠그는 것:
 *   · 모든 서버 write 가 공유 큐를 지난다 (순서 역전 금지)
 *   · 폴링 가드가 boolean 플래그가 아니라 공유 in-flight 카운터를 본다
 *   · 단건 write 에 타임아웃이 걸려 있다
 *   · history 를 confirmed 로 승격하는 경로가 코드에 없다
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { hasPendingLocalWrite, ACK_WRITE_TIMEOUT_MS } from "./store";

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const storeSrc = read("store.ts");
const sessionSrc = read("rebalance-session.ts");
const accountPageSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "components", "kaw", "AccountPage.tsx"),
  "utf8",
);

describe("폴링 가드 — 공유 in-flight 카운터", () => {
  it("쓰기가 없으면 false 다 (세션 없는 초기 상태)", () => {
    expect(hasPendingLocalWrite()).toBe(false);
  });

  it("boolean pendingLocalSave 플래그가 더 이상 없다", () => {
    // 여러 비동기 요청이 각자 true/false 로 뒤집으면 한 요청이 끝날 때 다른 요청이
    // 비행 중인데도 폴링이 끼어든다 — 그래서 플래그 자체를 없앴다.
    expect(storeSrc).not.toContain("pendingLocalSave");
  });

  it("폴링과 가시성 복귀가 같은 판정 함수를 쓴다", () => {
    const guards = storeSrc.match(/if \(hasPendingLocalWrite\(\)\) return/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it("판정이 큐의 in-flight 수와 대기 중 디바운스를 **둘 다** 본다", () => {
    const start = storeSrc.indexOf("export function hasPendingLocalWrite");
    const body = storeSrc.slice(start, storeSrc.indexOf("}", start));
    expect(body).toContain("writes.inFlight()");
    expect(body).toContain("saveTimer");
  });
});

describe("write 직렬화 — 모든 서버 write 가 큐를 지난다", () => {
  it("전체 상태 저장은 enqueueFullSave 한 곳에서만 dbSave 를 부른다", () => {
    const calls = storeSrc.match(/dbSave\(familyCode, currentUser, memState\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const start = storeSrc.indexOf("function enqueueFullSave");
    const end = storeSrc.indexOf("// ── 서버 응답을 돌려주는 단건 write 경로", start);
    expect(storeSrc.slice(start, end)).toContain("dbSave(familyCode, currentUser, memState)");
  });

  it("훅의 즉시 저장들도 큐를 지난다 (fire-and-forget dbSave 직접 호출이 없다)", () => {
    expect(storeSrc).not.toContain(
      "dbSave(familyCode, currentUser, memState).catch(console.error)",
    );
    const enqueued = storeSrc.match(/void enqueueFullSave\(\)/g) ?? [];
    expect(enqueued.length).toBeGreaterThanOrEqual(4); // addHistory / finalize / backtest / scheduleSave
  });

  it("단건 ACK write 도 큐를 지난다", () => {
    const start = storeSrc.indexOf("export function saveAccountRowWithAck");
    const body = storeSrc.slice(start, storeSrc.indexOf("function scheduleSave", start));
    expect(body).toMatch(/writes\s*\.enqueue/);
    expect(body).toContain("postAccountRow(row, token, timeoutMs)");
  });

  it("자동저장은 **실행 시점의 최신 상태**를, ACK write 는 **예약 시점 payload** 를 쓴다", () => {
    const full = storeSrc.slice(
      storeSrc.indexOf("function enqueueFullSave"),
      storeSrc.indexOf("async function postAccountRow"),
    );
    // enqueue 안에서 memState 를 읽는다 = 읽기-최신
    expect(full).toMatch(/enqueue\(async \(\) => \{[\s\S]*memState/);

    const ack = storeSrc.slice(
      storeSrc.indexOf("export function saveAccountRowWithAck"),
      storeSrc.indexOf("function scheduleSave"),
    );
    // row 를 enqueue **바깥**에서 만든다 = 예약-고정
    const enqueueAt = ack.search(/writes\s*\.enqueue/);
    expect(enqueueAt).toBeGreaterThan(0);
    expect(ack.indexOf("const row: DbRow")).toBeLessThan(enqueueAt);
  });

  it("디바운스 동작은 유지된다 (800ms)", () => {
    const start = storeSrc.indexOf("function scheduleSave");
    const body = storeSrc.slice(start, storeSrc.indexOf("\n}", start));
    expect(body).toContain("clearTimeout(saveTimer)");
    expect(body).toContain("}, 800)");
  });
});

describe("단건 write 타임아웃", () => {
  it("기본 타임아웃이 있다", () => {
    expect(ACK_WRITE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ACK_WRITE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("AbortController 로 fetch 를 끊는다 (fetch 자체는 타임아웃이 없다)", () => {
    const start = storeSrc.indexOf("async function postAccountRow");
    const body = storeSrc.slice(start, storeSrc.indexOf("\n}", storeSrc.indexOf("finally", start)));
    expect(body).toContain("new AbortController()");
    expect(body).toContain("controller.abort()");
    expect(body).toContain("signal: controller.signal");
    expect(body).toContain("clearTimeout(timer)"); // 타이머 누수 금지
  });

  it("중단은 timedOut 으로 표시된다 (호출부가 failed 로 매핑할 근거)", () => {
    const start = storeSrc.indexOf("async function postAccountRow");
    expect(storeSrc.slice(start, start + 2500)).toContain("timedOut: true");
  });
});

describe("legacy /api/data 경로는 history 를 confirmed 로 올리지 않는다", () => {
  it("settleHistoryWrite 안에서 confirmHistoryPersistence 를 부르지 않는다", () => {
    const start = sessionSrc.indexOf("export function settleHistoryWrite");
    const body = sessionSrc.slice(
      start,
      sessionSrc.indexOf("export function settleHistoryMergeWrite", start),
    );
    expect(body).not.toContain("confirmHistoryPersistence");
    expect(body).toContain("markHistoryUnknown");
    expect(body).toContain("markHistoryFailed");
  });

  it("**confirmHistoryPersistence 는 병합 경로에서만** 쓰인다 (1B-3A)", () => {
    // 문서 전체 교체(`/api/data`)의 수용은 ACK 가 아니다. 기록 1건 단위로 응답하는
    // 병합 RPC(`/api/data/history`, 006)만 confirmed 로 올릴 수 있다.
    const uses = [...sessionSrc.matchAll(/confirmHistoryPersistence/g)].map((m) => m.index!);
    const mergeStart = sessionSrc.indexOf("export function settleHistoryMergeWrite");
    const mergeEnd = sessionSrc.indexOf("export function settlePlanWrite", mergeStart);
    const importEnd = sessionSrc.indexOf('} from "./completion-envelope"');
    expect(uses.length).toBeGreaterThan(0);
    for (const at of uses) {
      const inImport = at < importEnd;
      const inMerge = at > mergeStart && at < mergeEnd;
      expect(inImport || inMerge).toBe(true);
    }
  });

  it("legacy history outcome 타입에 ack 변종이 없다", () => {
    const start = sessionSrc.indexOf("export type HistoryWriteOutcome");
    const body = sessionSrc.slice(start, sessionSrc.indexOf("export type PlanWriteOutcome"));
    expect(body).toContain('{ kind: "accepted" }');
    expect(body).not.toContain('"ack"');
  });

  it("병합 outcome 타입에는 ack 가 있다 (기록 1건에 대한 서버의 답이다)", () => {
    const start = sessionSrc.indexOf("export type HistoryMergeOutcome");
    expect(start).toBeGreaterThan(-1);
    const body = sessionSrc.slice(start, sessionSrc.indexOf(";", sessionSrc.indexOf("failed", start)));
    expect(body).toContain('kind: "ack"');
    expect(body).toContain('kind: "unknown"');
    expect(body).toContain('kind: "failed"');
  });

  it("plan 쪽은 ACK 로 confirmed 가 된다 (PK 단위라 blob 저장에 지워지지 않는다)", () => {
    const start = sessionSrc.indexOf("export function settlePlanWrite");
    const body = sessionSrc.slice(start, sessionSrc.indexOf("// ── 정리 / 복구", start));
    expect(body).toContain("confirmPlanPersistence");
  });

  it("AccountPage 는 계좌 문서 응답을 historyOutcomeOfAck 로만 해석한다", () => {
    expect(accountPageSrc).toContain("historyOutcomeOfAck(ack)");
    // 문서 저장 응답으로 ACK 를 만들지 않는다 — ACK 는 병합 응답에서만 온다.
    expect(accountPageSrc).not.toContain('outcome: "written"');
    expect(accountPageSrc).not.toMatch(/settleHistoryMergeWrite\([^)]*historyOutcomeOfAck/);
  });
});

describe("완료 저장의 예수금 정규화", () => {
  it("AccountPage 가 normalizeAssertedCash 를 거친 값 하나만 쓴다", () => {
    const start = accountPageSrc.indexOf("async function runCompletion");
    const end = accountPageSrc.indexOf("const colCount", start);
    const body = accountPageSrc.slice(start, end);
    expect(body).toContain("const finalCash = normalizeAssertedCash(rawFinalCash)");
    // 정규화를 또 손으로 하는 코드가 남아 있지 않다
    expect(body).not.toContain("Math.max(0, Math.round(finalCash))");
  });

  it("store 는 저장 시점에 같은 정규화를 한다", () => {
    expect(storeSrc).toContain("const finalCash = Math.max(0, Math.round(args.cashBalance))");
  });
});
