-- ─────────────────────────────────────────────────────────────────────────────
-- 012 되돌리기 — 한국투자 체결 원장 반영 함수 제거
--
-- **함수만 지운다. 이미 반영된 원장·batch·audit 행은 그대로다**(원장은 immutable 이다).
-- 지운 뒤에는 서버의 반영 API 가 503 apply_unavailable 을 돌려준다. 먼저 서버 플래그
-- KIS_LEDGER_APPLY_ENABLED 를 끄는 것을 권한다.
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 실행한다. 멱등하다.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.kaw_kis_execution_apply(text, text, jsonb, jsonb, jsonb, jsonb);
