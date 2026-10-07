# 거래 원장 — 긴급 batch 롤백 (관리자 전용)

**이 문서의 SQL 은 평상시에 쓰는 것이 아니다.** production import 직후 검증에서
중대한 문제가 발견됐을 때, **그 import batch 의 거래만** 되돌리기 위한 비상 절차다.

- 앱 / Worker / `service_role` 경로에서는 **절대 쓰지 않는다.** 애초에 불가능하다 —
  migration 004 가 `service_role` 에서 `kaw_transaction_ledger` 의 DELETE 를 회수했다.
- 실행 주체는 **Supabase SQL Editor 의 owner(`postgres`)** 다.
- `kaw_transaction_ledger` 테이블을 drop 하지 않는다. migration 004 도 되돌리지 않는다.
  (테이블째 날리는 것은 `migrations/004_transaction_ledger_rollback.sql` 이고, 그건
  이 문서와 **목적이 다르다** — 기능 자체를 철수할 때 쓴다.)

## immutable 의 정확한 범위

원장이 immutable 하다는 것은 **"Worker 가 쓰는 `service_role` 키로는 원본을 바꾸거나
지울 수 없다"** 는 뜻이다. 테이블 소유자인 `postgres` 는 언제든 지울 수 있고, 권한으로
막을 수도 없다(소유자이므로). 그래서 "들어가면 drop 외에는 되돌릴 수 없다"는 말은
틀렸다 — 아래 절차로 batch 단위 되돌리기가 가능하다.

이 비대칭이 설계 의도다. 정상 경로에서는 사고가 날 수 없고, 관리자는 의도적으로
SQL Editor 를 열어야만 되돌릴 수 있다.

---

## ⚠️ 먼저 읽을 것 — overlay 가 함께 사라진다

`kaw_transaction_ledger` 를 참조하는 FK 가 둘 있고, **둘 다 `on delete cascade`** 다.

| 테이블 | FK | 원장 행 삭제 시 |
|---|---|---|
| `kaw_transaction_correction` | `(family_code, profile, transaction_id)` → ledger, **cascade** | **같이 삭제된다** |
| `kaw_transaction_event_override` | `(family_code, profile, transaction_id)` → ledger, **cascade** | **같이 삭제된다** |
| `kaw_rebalance_event` | FK 없음 | **남는다.** 메모·태그·숨김이 거래 없는 이벤트를 가리키게 된다 |
| `kaw_ledger_audit` | FK 없음 (append-only) | **남는다.** 삭제 이력이 보존된다 — 의도된 동작이다 |

즉 **원장을 지우면 사용자가 손으로 만든 정정·병합/분리가 조용히 함께 사라진다.**
원장 자체는 `data/verified-transactions.v1.json` 에서 언제든 다시 적재할 수 있지만,
**overlay 는 되살릴 수 없다.** 그래서 2단계 백업을 건너뛰지 않는다.

import 직후 검증 단계라면 overlay 가 아직 0건이라 실질 위험이 없다. 그 경우에도
1단계에서 0건임을 **확인하고** 넘어간다.

---

## 1단계 — 대상 확인 (읽기만)

`<FAMILY>` / `<PROFILE>` / `<BATCH_ID>` 를 실제 값으로 바꾼다. `<BATCH_ID>` 는
import 스크립트가 마지막에 출력한 `batch id:` 값이고, `kaw_ledger_import_batch`
에서도 확인할 수 있다.

```sql
-- (1-a) 이 batch 가 무엇인가
select id, source_kind, source_label, source_checksum,
       inserted_count, skipped_count, actor, created_at
  from public.kaw_ledger_import_batch
 where family_code = '<FAMILY>' and profile = '<PROFILE>'
 order by created_at desc;

-- (1-b) 지워질 원장 행 수 — inserted_count 와 같아야 한다
select count(*) as ledger_rows
  from public.kaw_transaction_ledger
 where family_code = '<FAMILY>' and profile = '<PROFILE>'
   and import_batch_id = '<BATCH_ID>';

-- (1-c) **cascade 로 함께 삭제될 overlay** — import 직후라면 둘 다 0 이어야 한다.
--       0 이 아니면 멈추고, 아래 2단계 백업을 반드시 먼저 뜬다.
select
  (select count(*) from public.kaw_transaction_correction c
    where c.family_code = '<FAMILY>' and c.profile = '<PROFILE>'
      and exists (select 1 from public.kaw_transaction_ledger l
                   where l.family_code = c.family_code and l.profile = c.profile
                     and l.id = c.transaction_id
                     and l.import_batch_id = '<BATCH_ID>')) as corrections_to_lose,
  (select count(*) from public.kaw_transaction_event_override o
    where o.family_code = '<FAMILY>' and o.profile = '<PROFILE>'
      and exists (select 1 from public.kaw_transaction_ledger l
                   where l.family_code = o.family_code and l.profile = o.profile
                     and l.id = o.transaction_id
                     and l.import_batch_id = '<BATCH_ID>')) as overrides_to_lose;

-- (1-d) 이 batch 밖에 다른 원장 행이 있는가 (부분 롤백인지 전체인지 파악)
select coalesce(import_batch_id, '(null)') as batch, count(*)
  from public.kaw_transaction_ledger
 where family_code = '<FAMILY>' and profile = '<PROFILE>'
 group by 1 order by 2 desc;
```

## 2단계 — 백업 (overlay 가 0건이 아니면 **필수**)

```sql
select json_agg(t) from public.kaw_transaction_correction t
 where family_code = '<FAMILY>' and profile = '<PROFILE>';
select json_agg(t) from public.kaw_transaction_event_override t
 where family_code = '<FAMILY>' and profile = '<PROFILE>';
select json_agg(t) from public.kaw_rebalance_event t
 where family_code = '<FAMILY>' and profile = '<PROFILE>';
```

결과를 내려받아 보관한 뒤에 3단계로 간다.

## 3단계 — 삭제 (transaction 안에서)

**블록 전체를 한 번에** 붙여넣는다. 마지막이 `rollback;` 이므로 **그대로 실행하면
아무것도 지워지지 않는다.** 출력된 NOTICE 를 읽고 기대와 맞을 때만, 마지막 줄을
`commit;` 으로 바꿔 다시 실행한다.

`v_expected_rows` 에 **1-b 에서 눈으로 확인한 행 수**를 적는다. 실제 삭제 대상이
그 수와 다르면 블록이 예외를 던지고 아무것도 지우지 않는다.

```sql
begin;

do $$
declare
  -- ── 여기 네 값을 넣는다 ───────────────────────────────────────────────
  v_family   text := '<FAMILY>';
  v_profile  text := '<PROFILE>';
  v_batch    text := '<BATCH_ID>';
  v_expected integer := <1-b 에서 확인한 행 수>;   -- 예: 463
  -- ─────────────────────────────────────────────────────────────────────
  v_ledger   integer;
  v_batches  integer;
  v_corr     integer;
  v_ovr      integer;
  v_deleted  integer;
begin
  -- 방어 1: 자리표시자를 안 바꿨거나 빈 값이면 멈춘다.
  if coalesce(v_family, '') = '' or coalesce(v_profile, '') = ''
     or coalesce(v_batch, '') = '' then
    raise exception '식별자가 비어 있다 (family=%, profile=%, batch=%)',
      v_family, v_profile, v_batch;
  end if;
  if v_family like '%<%' or v_profile like '%<%' or v_batch like '%<%' then
    raise exception '자리표시자를 실제 값으로 바꾸지 않았다 (family=%, profile=%, batch=%)',
      v_family, v_profile, v_batch;
  end if;

  -- 방어 2: batch id 모양 확인. import 스크립트는 'imp:<source_kind>:<ISO>' 로 만든다.
  if v_batch not like 'imp:%' then
    raise exception 'batch id 모양이 아니다: % (imp: 로 시작해야 한다)', v_batch;
  end if;

  -- 방어 3: 그 batch 가 이 family/profile 에 실제로 존재하는가.
  select count(*) into v_batches
    from public.kaw_ledger_import_batch
   where family_code = v_family and profile = v_profile and id = v_batch;
  if v_batches <> 1 then
    raise exception 'batch 행이 정확히 1건이 아니다 (%건) — family/profile/batch 조합을 확인하라',
      v_batches;
  end if;

  -- 방어 4: 삭제 대상 수가 예상과 일치하는가. 다르면 아무것도 지우지 않는다.
  select count(*) into v_ledger
    from public.kaw_transaction_ledger
   where family_code = v_family and profile = v_profile and import_batch_id = v_batch;
  if v_ledger <> v_expected then
    raise exception '삭제 대상 % 건이 예상 % 건과 다르다 — 중단한다', v_ledger, v_expected;
  end if;
  if v_ledger = 0 then
    raise exception '삭제 대상이 0건이다 — batch id 를 확인하라';
  end if;

  -- 경고: cascade 로 함께 사라질 overlay 를 집계해 NOTICE 로 남긴다.
  select count(*) into v_corr
    from public.kaw_transaction_correction c
   where c.family_code = v_family and c.profile = v_profile
     and exists (select 1 from public.kaw_transaction_ledger l
                  where l.family_code = c.family_code and l.profile = c.profile
                    and l.id = c.transaction_id and l.import_batch_id = v_batch);
  select count(*) into v_ovr
    from public.kaw_transaction_event_override o
   where o.family_code = v_family and o.profile = v_profile
     and exists (select 1 from public.kaw_transaction_ledger l
                  where l.family_code = o.family_code and l.profile = o.profile
                    and l.id = o.transaction_id and l.import_batch_id = v_batch);
  raise notice 'cascade 로 함께 삭제됨 — correction % 건 / event_override % 건', v_corr, v_ovr;
  raise notice 'kaw_rebalance_event 와 kaw_ledger_audit 은 삭제되지 않는다(FK 없음).';

  -- ── 삭제 ──────────────────────────────────────────────────────────────
  -- 세 조건을 모두 건다. import_batch_id 만으로 지우지 않는다.
  delete from public.kaw_transaction_ledger
   where family_code = v_family and profile = v_profile and import_batch_id = v_batch;
  get diagnostics v_deleted = row_count;
  if v_deleted <> v_expected then
    raise exception '실제 삭제 % 건이 예상 % 건과 다르다 — 롤백한다', v_deleted, v_expected;
  end if;
  raise notice '원장 % 건 삭제', v_deleted;

  delete from public.kaw_ledger_import_batch
   where family_code = v_family and profile = v_profile and id = v_batch;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'batch 행 삭제가 % 건이다 (1 이어야 한다) — 롤백한다', v_deleted;
  end if;
  raise notice 'batch 행 1 건 삭제';
end $$;

-- 확인용: 0 이어야 한다.
select count(*) as remaining_ledger
  from public.kaw_transaction_ledger
 where family_code = '<FAMILY>' and profile = '<PROFILE>'
   and import_batch_id = '<BATCH_ID>';

rollback;   -- ← NOTICE 와 remaining_ledger 를 확인한 뒤에만 commit 으로 바꾼다
```

## 4단계 — 사후 확인

```sql
-- (4-a) 그 batch 가 사라졌는가 (0행)
select * from public.kaw_ledger_import_batch
 where family_code = '<FAMILY>' and profile = '<PROFILE>' and id = '<BATCH_ID>';

-- (4-b) 끊긴 참조가 생기지 않았는가 (0행)
--       다른 batch 의 원장 행이 사라진 batch 를 가리키면 안 된다.
select l.import_batch_id, count(*)
  from public.kaw_transaction_ledger l
 where l.family_code = '<FAMILY>' and l.profile = '<PROFILE>'
   and l.import_batch_id is not null
   and not exists (select 1 from public.kaw_ledger_import_batch b
                    where b.family_code = l.family_code and b.profile = l.profile
                      and b.id = l.import_batch_id)
 group by 1;

-- (4-c) 거래 없는 이벤트가 남았는가 (메모·태그만 남은 행. 삭제는 선택이다)
select e.id, e.memo, e.tags
  from public.kaw_rebalance_event e
 where e.family_code = '<FAMILY>' and e.profile = '<PROFILE>'
   and not exists (select 1 from public.kaw_transaction_ledger l
                    where l.family_code = e.family_code and l.profile = e.profile
                      and 'rev:' || l.account_type || ':' || l.event_date = e.id);
```

`kaw_ledger_audit` 은 지우지 않는다 — append-only 이고, 무엇이 들어왔다가 나갔는지
남아 있어야 한다.

## 재적재

롤백 뒤 같은 데이터셋을 다시 넣으려면 평소 경로 그대로다. fingerprint 가 내용 기반이라
**삭제된 거래는 같은 신원으로 다시 들어간다**(새 `import_batch_id` 를 달고).

```bash
npm run ledger:dry-run -- --family=<FAMILY> --profile=<PROFILE>   # 0건인지 먼저 확인
npm run ledger:import -- --apply --family=<FAMILY> --profile=<PROFILE>
```
