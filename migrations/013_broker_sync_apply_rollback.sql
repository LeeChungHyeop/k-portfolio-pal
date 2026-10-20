-- ─────────────────────────────────────────────────────────────────────────────
-- 013 되돌리기 — 계좌 동기화 적용 함수와 감사 유니크 인덱스 제거
--
-- **함수와 인덱스만 지운다. 이미 반영된 계좌 문서(brokerSyncs · 현재 수량 · 예수금)와 감사 행은 그대로다.**
-- 지운 뒤에는 서버의 동기화 API 가 503 apply_unavailable 을 돌려준다. 먼저 서버 플래그
-- KIS_ACCOUNT_SYNC_ENABLED 를 끄는 것을 권한다.
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 실행한다. 멱등하다.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.kaw_broker_sync_apply(text, text, jsonb, jsonb, jsonb);
drop index if exists public.kaw_ledger_audit_broker_sync_uq;
