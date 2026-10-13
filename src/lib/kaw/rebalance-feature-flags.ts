// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 세션 추적 feature flag
//
// Phase 1A 는 **서버가 없다.** migration 005(`kaw_rebalance_plan`)도
// `POST /api/rebalance/plan` 도 아직 없어서, 완료 envelope 의 `planPersistence` 를
// confirmed 로 올릴 수단이 없다. 그 상태로 새 흐름을 켜면
//
//   · plan 이 영원히 pending → envelope 이 영원히 삭제되지 않고 쌓인다
//   · journal 이 completing 에서 멈춘 채 남는다
//
// 그래서 **기본값은 OFF** 다. 끄면 리밸런싱은 Phase 0 이전과 **완전히 같은 경로**로
// 동작한다(journal / outbox / mirror 에 아무것도 쓰지 않는다).
//
// ## production 에서는 localStorage 만으로 켜지지 않는다
//
// 처음 설계는 `env === "on" || local === "on"` 이었는데, 이건 **production 빌드에서
// devtools 한 줄로 미완성 기능이 켜지는** 구조다(빌드 산출물에서 확인: 번들의
// `isSessionTrackingEnabled` 가 런타임 `import.meta.env` 와 localStorage 를 그대로
// 읽는다. `.env` 에 변수가 없으니 env 경로는 undefined 고 localStorage 만 살아 있었다).
// 한 번 켜두고 잊으면 그 기기에서 영구히 켜진 채 outbox 가 누적된다.
//
// 그래서 **빌드 타임 허용을 반드시 요구한다:**
//
//   env === "on"                      어느 빌드에서든 켠다 (명시적 opt-in 빌드)
//   DEV 빌드 + local === "on"         개발 서버에서만 런타임 스위치를 인정한다
//   그 외 (= 지금의 production)        **어떤 localStorage 값으로도 켜지지 않는다**
//
// 판정은 `resolveSessionTrackingFlag()` 가 순수 함수로 한다 — 세 소스를 읽는 얇은
// 래퍼만 환경에 닿는다. "on" 이라는 **명시적 문자열 하나만** 참으로 본다. truthy
// 판정을 쓰면 `VITE_...=false` / `"off"` 같은 값이 기능을 켜버린다.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_TRACKING_LS_KEY = "kaw-rebalance-session-tracking";
export const SESSION_TRACKING_ENV_KEY = "VITE_KAW_REBALANCE_SESSION";

/** 세 소스. 테스트가 production 조합을 그대로 재현할 수 있게 타입으로 고정한다. */
export interface SessionTrackingSources {
  /** 빌드 타임 `VITE_KAW_REBALANCE_SESSION` */
  env: string | undefined;
  /** 런타임 localStorage 스위치 */
  local: string | null;
  /** vite `import.meta.env.DEV` — production 빌드에서는 false */
  dev: boolean;
}

/**
 * **빌드 타임 허용이 없으면 런타임 스위치를 무시한다.**
 * production(`env` 미설정 + `dev === false`)에서는 어떤 `local` 값도 켜지 못한다.
 */
export function resolveSessionTrackingFlag(sources: SessionTrackingSources): boolean {
  if (sources.env === "on") return true;
  return sources.dev === true && sources.local === "on";
}

// ── kaw_data 쓰기 revision 가드 (Phase 1B-2B) ───────────────────────────────
//
// 서버는 요청에 `expectedRevisions` 가 실려 있을 때만 가드 경로를 쓴다
// (data-server.ts handleDataPost). 그래서 **클라이언트 쪽 스위치가 곧 배포 단계**다:
// 서버 + migration 006/007 을 먼저 올려두고, 이 flag 로 나중에 켠다.
//
// 기본값 OFF 인 이유는 세션 추적 flag 와 같다 — 켜면 저장이 409 로 거부될 수 있고,
// 그때는 **사용자 확인**이 필요하다(자동 병합·자동 재시도를 하지 않는다). 확인 UI 가
// 붙지 않은 빌드에서 켜지면 저장이 멈춘 채로 보일 수 있다. production 빌드에서
// devtools 한 줄로 켜지지 않게 **같은 판정 규칙**을 쓴다.
export const REVISION_GUARD_LS_KEY = "kaw-data-revision-guard";
export const REVISION_GUARD_ENV_KEY = "VITE_KAW_DATA_REVISION_GUARD";

/** 세션 추적 flag 와 **같은 규칙**이다(빌드 타임 허용 없이는 런타임 스위치 무시). */
export function resolveRevisionGuardFlag(sources: SessionTrackingSources): boolean {
  if (sources.env === "on") return true;
  return sources.dev === true && sources.local === "on";
}

/** 지금 쓰기 가드를 쓸 수 있는가. **매번 읽는다**(캐시하지 않는다). */
export function isRevisionGuardEnabled(): boolean {
  return resolveRevisionGuardFlag(readSources(REVISION_GUARD_ENV_KEY, REVISION_GUARD_LS_KEY));
}

/** 진단용 — 지금 어떤 소스 때문에 켜졌/꺼졌는지 그대로 보여준다. */
export function revisionGuardSources(): SessionTrackingSources {
  return readSources(REVISION_GUARD_ENV_KEY, REVISION_GUARD_LS_KEY);
}

function readSources(
  envKey: string = SESSION_TRACKING_ENV_KEY,
  lsKey: string = SESSION_TRACKING_LS_KEY,
): SessionTrackingSources {
  let env: string | undefined;
  let dev = false;
  try {
    const meta = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    env = typeof meta?.[envKey] === "string" ? (meta[envKey] as string) : undefined;
    dev = meta?.DEV === true;
  } catch {
    env = undefined;
    dev = false;
  }
  let local: string | null = null;
  try {
    if (typeof localStorage !== "undefined") local = localStorage.getItem(lsKey);
  } catch {
    local = null;
  }
  return { env, local, dev };
}

/**
 * 지금 세션 추적을 쓸 수 있는가. **매번 읽는다** — 캐시하면 스위치를 켠 뒤 새로고침
 * 없이 꺼진 채로 남고, 반대로 끈 뒤에도 켜진 채로 남는다.
 */
export function isSessionTrackingEnabled(): boolean {
  return resolveSessionTrackingFlag(readSources());
}

/** 진단용 — 지금 어떤 소스 때문에 켜졌/꺼졌는지 그대로 보여준다. */
export function sessionTrackingSources(): SessionTrackingSources {
  return readSources();
}
