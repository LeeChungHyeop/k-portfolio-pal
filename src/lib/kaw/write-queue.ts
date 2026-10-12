// ─────────────────────────────────────────────────────────────────────────────
// 서버 write 직렬화 큐 — **같은 탭 안의 순서 역전을 없앤다**
//
// ## 왜 필요한가 (실측 경로)
//
// `/api/data` POST 는 `onConflict` upsert 로 **계좌 JSON 문서를 통째로 교체**한다
// (data-server.ts handleDataPost). 서버에 순서 보호가 없으므로, 먼저 보낸 오래된
// 요청이 나중에 도착하면 최신 기록이 지워진다:
//
//   t+0.8  디바운스 저장 발사 → 요청 R0 (HistoryEntry 없는 상태), 회선 지연 3초
//   t+0.9  리밸런싱 완료       → 요청 R2 (HistoryEntry 포함) → 200 수신
//   t+3.8  R0 도착            → 계좌 행이 R0 상태로 덮임 = **완료 기록 소멸**
//
// 큐는 **예약 순서(FIFO)** 로 한 번에 하나씩만 보낸다. 앞 요청이 settle 되기 전에
// 뒤 요청을 시작하지 않으므로 "늦게 완료되는 오래된 요청" 자체가 생기지 않는다.
//
// ## payload 시점은 **API 별로 다르다** — 호출부가 명시적으로 고른다
//
//   읽기-최신(read-latest)   자동저장(dbSave). 큐 **실행 시점**의 memState 를 보낸다.
//                            오래된 스냅샷을 굳혀 들고 있으면 그게 바로 위 사고다.
//   예약-고정(frozen)        완료 ACK write. **예약 시점**의 계좌 행을 보낸다 —
//                            "이 완료의 상태가 올라갔는가"를 증명해야 하기 때문이다.
//
// FIFO 라서 둘을 섞어도 안전하다: 완료 전에 예약된 자동저장은 완료보다 먼저 실행되며
// 그때의 최신 상태(= 완료 포함)를 보내고, 완료 후에 예약된 자동저장은 그 뒤에 실행된다.
//
// ## 실패가 큐를 멈추지 않는다
//
// 한 요청이 reject 돼도 다음 요청은 그대로 진행한다(`tail` 은 항상 resolve 로 잇는다).
// 실패 때문에 이후 저장이 영구 정지하면 자동저장 전체가 죽는다.
//
// ## 범위 한계
//
// **같은 탭의 ordering 만** 보장한다. 다른 기기·다른 탭이 같은 계좌 문서를 쓰면
// 여전히 last-writer-wins 이고, 그건 서버 revision guard(Phase 1B)만 막을 수 있다.
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteQueue {
  /** FIFO 로 실행한다. 반환 promise 는 그 작업의 결과다(실패는 그대로 reject). */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** 예약됐지만 아직 settle 되지 않은 작업 수. **폴링 가드의 공유 카운터**다. */
  inFlight(): number;
  /** 지금까지 예약된 작업이 전부 끝날 때까지. 테스트·플러시용. */
  idle(): Promise<void>;
}

export function createWriteQueue(): WriteQueue {
  // 항상 resolve 로만 이어지는 체인. 여기에 reject 가 전파되면 큐가 멈춘다.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    // **동기적으로** 센다 — 증가와 예약 사이에 폴링이 끼어들 틈을 만들지 않는다.
    pending += 1;
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    const result = run.finally(() => {
      pending = Math.max(0, pending - 1);
    });
    // 호출부가 반환값을 버려도 unhandled rejection 이 되지 않게 한다.
    // (result 자체는 그대로 reject 되므로 await 하는 호출부는 에러를 받는다)
    result.catch(() => {});
    return result;
  }

  return {
    enqueue,
    inFlight: () => pending,
    idle: () => tail.then(() => undefined),
  };
}
