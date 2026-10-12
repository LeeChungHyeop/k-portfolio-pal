/**
 * write 직렬화 큐 — **stale overwrite 재현 시나리오를 막는다.**
 *
 * 고정하려는 사실:
 *   · 예약 순서대로 하나씩 실행한다 (앞 요청이 settle 되기 전 뒤 요청을 시작하지 않는다)
 *   · 느린 오래된 요청이 **나중에 완료되어 최신 기록을 덮는 일이 없다**
 *   · 읽기-최신(자동저장)과 예약-고정(완료 ACK write)을 섞어도 최종 상태가 최신이다
 *   · 한 요청이 실패해도 큐가 영구 정지하지 않는다
 *   · inFlight() 가 폴링 가드로 쓸 수 있는 공유 카운터다
 *
 * 지연 가능한 fake 요청으로 서버 적용 순서를 관찰한다 — 실제 fetch 는 쓰지 않는다.
 */
import { describe, it, expect } from "vitest";
import { createWriteQueue } from "./write-queue";

/** 서버 흉내: `apply` 가 불린 순서대로 문서가 덮인다 (last-writer-wins). */
function fakeServer() {
  const applied: string[] = [];
  let doc = "초기";
  return {
    applied,
    current: () => doc,
    /** 지연 후 문서를 교체한다 — 요청 1건 */
    write(body: string, delayMs: number) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          doc = body;
          applied.push(body);
          resolve();
        }, delayMs);
      });
    },
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createWriteQueue — 순서 보존", () => {
  it("예약 순서대로 하나씩 실행한다 (늦은 요청이 앞서지 않는다)", async () => {
    const q = createWriteQueue();
    const server = fakeServer();
    // 첫 요청이 가장 느리다 — 직렬화가 없으면 마지막에 적용된다
    void q.enqueue(() => server.write("A", 30));
    void q.enqueue(() => server.write("B", 10));
    void q.enqueue(() => server.write("C", 1));
    await q.idle();
    expect(server.applied).toEqual(["A", "B", "C"]);
    expect(server.current()).toBe("C");
  });

  it("stale R0 → 최신 R2 → R0 늦은 완료 시나리오에서 최신 기록이 보존된다", async () => {
    const q = createWriteQueue();
    const server = fakeServer();

    // 클라이언트의 최신 상태. 자동저장은 **실행 시점에** 이 값을 읽는다(읽기-최신).
    let latest = "S0(HistoryEntry 없음)";

    // t+0.8 디바운스 자동저장 예약 — 느린 회선(50ms)
    const r0 = q.enqueue(() => server.write(latest, 50));

    // t+0.9 리밸런싱 완료: memState 가 갱신되고, 완료 ACK write 는 **예약 시점 payload 를 고정**한다
    latest = "S1(HistoryEntry 포함)";
    const frozen = latest;
    const r2 = q.enqueue(() => server.write(frozen, 1));

    await Promise.all([r0, r2]);
    await q.idle();

    // R0 은 실행될 때 이미 S1 을 읽으므로 오래된 문서를 보내지 않는다.
    expect(server.applied).toEqual(["S1(HistoryEntry 포함)", "S1(HistoryEntry 포함)"]);
    // 최종 상태에 완료 기록이 남아 있다 — 이것이 BLOCKER 였던 지점이다
    expect(server.current()).toBe("S1(HistoryEntry 포함)");
  });

  it("완료 뒤에 예약된 자동저장은 완료 요청 다음에 실행된다", async () => {
    const q = createWriteQueue();
    const server = fakeServer();
    let latest = "S1(완료 포함)";
    const ack = q.enqueue(() => server.write("S1-frozen", 20));
    // 완료 직후 사용자가 수량을 또 고쳤다
    latest = "S2(완료 + 추가편집)";
    const auto = q.enqueue(() => server.write(latest, 1));
    await Promise.all([ack, auto]);
    expect(server.applied).toEqual(["S1-frozen", "S2(완료 + 추가편집)"]);
    expect(server.current()).toBe("S2(완료 + 추가편집)");
  });
});

describe("createWriteQueue — 실패 내성", () => {
  it("한 요청이 실패해도 다음 요청이 그대로 진행된다 (큐가 멈추지 않는다)", async () => {
    const q = createWriteQueue();
    const server = fakeServer();
    const failed = q.enqueue(() => Promise.reject(new Error("HTTP 500")));
    await expect(failed).rejects.toThrow("HTTP 500");
    await q.enqueue(() => server.write("실패 다음 요청", 1));
    expect(server.current()).toBe("실패 다음 요청");
  });

  it("실패한 요청의 반환값을 호출부가 버려도 다음 요청이 진행된다", async () => {
    const q = createWriteQueue();
    const server = fakeServer();
    // 반환 promise 를 아무도 await 하지 않는다 (void 호출) — unhandled rejection 금지
    void q.enqueue(() => Promise.reject(new Error("무시된 실패")));
    await q.enqueue(() => server.write("그래도 저장됨", 1));
    expect(server.current()).toBe("그래도 저장됨");
  });

  it("동기적으로 throw 하는 작업도 큐를 멈추지 않는다", async () => {
    const q = createWriteQueue();
    const server = fakeServer();
    void q.enqueue(() => {
      throw new Error("동기 예외");
    });
    await q.enqueue(() => server.write("정상", 1));
    expect(server.current()).toBe("정상");
  });
});

describe("createWriteQueue — inFlight (폴링 가드용 공유 카운터)", () => {
  it("예약 즉시 **동기적으로** 올라간다 (증가와 예약 사이에 틈이 없다)", () => {
    const q = createWriteQueue();
    expect(q.inFlight()).toBe(0);
    void q.enqueue(() => tick(10) as Promise<void>);
    expect(q.inFlight()).toBe(1); // await 없이 바로
  });

  it("여러 요청이 겹쳐도 **마지막이 끝날 때까지** 0 으로 내려가지 않는다", async () => {
    const q = createWriteQueue();
    const a = q.enqueue(() => tick(5) as Promise<void>);
    const b = q.enqueue(() => tick(5) as Promise<void>);
    expect(q.inFlight()).toBe(2);
    await a;
    // a 가 끝났지만 b 가 남아 있다 — boolean 플래그였다면 여기서 폴링이 끼어든다
    expect(q.inFlight()).toBe(1);
    await b;
    await q.idle();
    expect(q.inFlight()).toBe(0);
  });

  it("실패한 요청도 카운터를 내린다 (영구 누수 금지)", async () => {
    const q = createWriteQueue();
    const f = q.enqueue(() => Promise.reject(new Error("x")));
    await expect(f).rejects.toThrow();
    await q.idle();
    expect(q.inFlight()).toBe(0);
  });
});
