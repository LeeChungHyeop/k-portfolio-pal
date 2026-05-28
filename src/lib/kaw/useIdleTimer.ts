import { useEffect, useRef } from "react";

const IDLE_EVENTS = [
  "mousemove", "mousedown", "keydown",
  "touchstart", "scroll", "click",
] as const;

/**
 * active 상태일 때 유휴 시간을 측정해 콜백을 호출한다.
 *
 * - 10분 무입력 → onProfileTimeout (프로필 선택 화면)
 * - 60분 무입력 → onLogoutTimeout  (액세스 코드 입력 화면)
 *
 * 두 타이머 모두 사용자 입력이 생기면 함께 초기화된다.
 */
export function useIdleTimer({
  active,
  onProfileTimeout,
  onLogoutTimeout,
  profileMs = 10 * 60 * 1000,
  logoutMs  = 60 * 60 * 1000,
}: {
  active:           boolean;
  onProfileTimeout: () => void;
  onLogoutTimeout:  () => void;
  profileMs?:       number;
  logoutMs?:        number;
}) {
  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 최신 콜백을 ref에 보관해 타이머 재등록 없이 사용
  const onProfileRef = useRef(onProfileTimeout);
  const onLogoutRef  = useRef(onLogoutTimeout);
  onProfileRef.current = onProfileTimeout;
  onLogoutRef.current  = onLogoutTimeout;

  useEffect(() => {
    if (!active) {
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (logoutTimerRef.current)  clearTimeout(logoutTimerRef.current);
      return;
    }

    function reset() {
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (logoutTimerRef.current)  clearTimeout(logoutTimerRef.current);
      profileTimerRef.current = setTimeout(() => onProfileRef.current(), profileMs);
      logoutTimerRef.current  = setTimeout(() => onLogoutRef.current(),  logoutMs);
    }

    IDLE_EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      IDLE_EVENTS.forEach(e => window.removeEventListener(e, reset));
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (logoutTimerRef.current)  clearTimeout(logoutTimerRef.current);
    };
  }, [active, profileMs, logoutMs]);
}
