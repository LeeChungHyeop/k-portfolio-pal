-- ─────────────────────────────────────────────────────────────────────────────
-- 014 되돌리기 — kaw_portfolio_live_view 를 002 정의로 되돌린다
--
-- 방법: view 를 지운 뒤 002_cash_balance.sql 을 다시 실행한다(002 는 멱등하다).
--       이 파일은 view 만 지운다. **반드시 이어서 002_cash_balance.sql 전체를 실행**해 view 를 복구할 것.
--       (계좌 문서 · 감사 · 동기화 기록은 건드리지 않는다)
--
-- 주의: 되돌리면 view 가 동기화 기록을 무시해 총자산이 다시 과대 계산된다(옛 보유수량 + 새 예수금).
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists public.kaw_portfolio_live_view;

-- 이어서 002_cash_balance.sql 전체를 실행한다. 002 는 view 를 새로 만들므로 Supabase 기본 권한(service_role 의 UPDATE/DELETE 등)이
-- 다시 붙을 수 있다. 002 실행 직후 아래 두 문장을 실행해 읽기 전용 권한을 유지할 것:
--   revoke all on public.kaw_portfolio_live_view from public, anon, authenticated, service_role;
--   grant select on public.kaw_portfolio_live_view to service_role;
