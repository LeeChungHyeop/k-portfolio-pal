// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 서버 핸들러 공용 지원 (Phase 4-C-1/2)
//   · withLock           중복 클릭 · 재시도 · 두 기기 동시 요청에서 같은 쓰기가 겹치지 않게 하는 짧은 잠금
//   · latestObservation  새 증권사 계좌의 가장 최근 잔고 관측(무효 처리된 것 제외) — 읽기 전용
// 이 파일은 DB 에 쓰지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { json } from "./data-server";
import type { serviceClient } from "./data-server";
import type { KisAccountEnv } from "./kis-account-read";
import { kisAppFingerprint } from "./kis-server";
import { dbRowToPart, summarizeObservation, type BalanceObservationSummary } from "./kis-balance-observation";

type ServiceClient = NonNullable<ReturnType<typeof serviceClient>>;

// ── 동시 요청 잠금 ──────────────────────────────────────────────────────────
// 중복 클릭 · 재시도 · 두 기기에서 동시에 누르는 경우에 같은 기록이 두 번 쓰이지 않게 한다.
//   · 같은 isolate: 메모리 Set — 확실하다
//   · 다른 isolate: KV(`RATE_LIMIT`) 짧은 잠금 — 최선(원자적이지 않다)이라, 쓰기 뒤 중복 확인과
//     읽는 쪽 해석(parseTransferRecords: 가장 먼저 승인된 하나)이 마지막 방어선이다.
// DB 유니크 제약은 migration 이 필요해 이번 단계에서 추가하지 않는다(4-C-2 후보로 보고).
const heldLocks = new Set<string>();
const LOCK_TTL_SEC = 60;
type LockKv = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete?(k: string): Promise<void> };

export async function withLock(
  env: KisAccountEnv, scope: string, session: { code: string; profile: string }, fn: () => Promise<Response>,
): Promise<Response> {
  const busy = () => json({ state: "rejected", code: "busy", message: "같은 요청이 처리 중입니다. 잠시 후 상태를 새로고침해 확인하세요." }, 409);
  // 메모리 잠금은 **동기적으로** 잡는다(await 사이에 다른 요청이 끼어들 수 없다). 이 키는 isolate 밖으로 나가지 않는다.
  const memKey = `${scope}:${session.code}|${session.profile}`;
  if (heldLocks.has(memKey)) return busy();
  heldLocks.add(memKey);
  const kv = env.RATE_LIMIT as LockKv | undefined;
  let kvKey: string | null = null;
  try {
    if (kv) {
      // KV 키에는 가족 코드 원문을 넣지 않는다(지문만).
      kvKey = `kis:lock:${scope}:${await kisAppFingerprint(`${session.code}|${session.profile}`)}`;
      if (await kv.get(kvKey).catch(() => null)) { kvKey = null; return busy(); }
      await kv.put(kvKey, "1", { expirationTtl: LOCK_TTL_SEC }).catch(() => {});
    }
    return await fn();
  } finally {
    heldLocks.delete(memKey);
    // 내가 잡은 KV 잠금만 푼다. 못 풀어도 TTL 로 사라진다.
    if (kv && kvKey && kv.delete) await kv.delete(kvKey).catch(() => {});
  }
}

/** 새 증권사 instance 의 가장 최근 관측 part (voided 제외) */
export async function latestObservation(client: ServiceClient, code: string, profile: string, instanceId: string): Promise<BalanceObservationSummary | null> {
  const { data } = await client.from("kaw_settlement_observation").select("*")
    .eq("family_code", code).eq("profile", profile).eq("account_instance_id", instanceId)
    .order("observed_at", { ascending: false }).limit(5);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.length) return null;
  const ids = rows.map((r) => String(r.id));
  const { data: voids } = await client.from("kaw_settlement_observation_void").select("observation_id")
    .eq("family_code", code).eq("profile", profile).in("observation_id", ids);
  const voided = new Set(((voids ?? []) as Array<{ observation_id: string }>).map((v) => v.observation_id));
  const first = rows.find((r) => !voided.has(String(r.id)));
  return first ? summarizeObservation(dbRowToPart(first)) : null;
}

