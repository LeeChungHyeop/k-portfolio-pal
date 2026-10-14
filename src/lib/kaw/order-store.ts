// ─────────────────────────────────────────────────────────────────────────────
// 주문 의도 저장소 — 인터페이스 + 메모리 구현(테스트·재시작 복구 모의) + Supabase 구현
//
// 의도는 **재시작 후에도 남아야 한다**(응답 유실·프로세스 종료 뒤에 "이 주문이 나갔을
// 수 있는가"를 알아야 하므로). 운영 구현은 migration 008 의 `kaw_order_intent` 를 쓴다.
// 그 테이블이 아직 적용되지 않았으면 쓰기는 **실패로 끝난다**(조용히 메모리로 대체하지
// 않는다 — 주문 의도가 휘발되면 중복 주문 방지가 무너진다).
//
// 모든 변경은 **낙관적 잠금(version)** 이다. 두 요청이 같은 의도를 동시에 앞으로 보내려
// 하면 한쪽만 성공하고 다른 쪽은 `stale` 을 받는다 — 그것이 서버측 중복 주문 차단이다.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RESOLVABLE_STATES,
  type OrderIntent, type OrderResolutionRecord, type OrderScope, type OrderState,
} from "./order-intent";

/** 변경 가능한 필드. 종목·수량·단가·방향·계좌는 **생성 후 바꿀 수 없다**. */
export type OrderIntentPatch = Partial<
  Pick<
    OrderIntent,
    | "state" | "approvalTokenHash" | "approvalExpiresAt" | "approvalConsumedAt"
    | "submitStartedAt" | "orderNo" | "orderNoSource" | "orderOrgNo" | "orderTime"
    | "evidence" | "lastInquiryAt" | "ambiguous" | "lastError"
  >
>;

export type StoreInsertResult =
  | { ok: true }
  | { ok: false; reason: "duplicate_key" | "unavailable" | "error"; message?: string };

export type StoreUpdateResult =
  | { ok: true; intent: OrderIntent }
  | { ok: false; reason: "stale" | "not_found" | "unavailable" | "error"; message?: string };

export interface OrderIntentStore {
  insert(intent: OrderIntent): Promise<StoreInsertResult>;
  getById(scope: OrderScope, id: string): Promise<OrderIntent | null>;
  /** 같은 멱등 키 계열(`…#1`, `…#2`)의 의도를 시도 번호 오름차순으로 */
  findByKeyBase(scope: OrderScope, keyBase: string): Promise<OrderIntent[]>;
  /** 종결되지 않은 의도 전부 */
  listOpen(scope: OrderScope): Promise<OrderIntent[]>;
  /** version 이 일치할 때만 갱신한다. 성공하면 version 이 +1 된 의도를 돌려준다 */
  update(scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch, now: string): Promise<StoreUpdateResult>;
  /** 같은 범위에서 이 주문번호가 붙은 의도(있으면) */
  findByOrderNo(scope: OrderScope, orderNo: string): Promise<OrderIntent | null>;
  /**
   * 수동 해소: **의도 CAS 갱신 + 감사 행 삽입을 한 트랜잭션으로.** 둘 중 하나만 반영되는
   * 일이 없다. 해소 가능한 상태(unknown/submitting)가 아니면 쓰지 않는다(stale).
   */
  resolve(
    scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch,
    record: OrderResolutionRecord, now: string,
  ): Promise<StoreUpdateResult>;
}

const NON_TERMINAL: readonly OrderState[] = [
  "proposed", "submitting", "accepted", "unknown", "open", "partially_filled",
];

const keyBaseOf = (key: string) => key.replace(/#\d+$/, "");
const sameScope = (a: OrderScope, b: OrderScope) =>
  a.familyCode === b.familyCode && a.profile === b.profile;

// ── 메모리 구현 ─────────────────────────────────────────────────────────────

/**
 * 테스트용이자 "프로세스 재시작" 모의용이다. 인스턴스를 공유하면 서비스 객체를 새로 만들어도
 * 상태가 남는다(= 영속 저장소와 같은 효과). **운영에서는 쓰지 않는다.**
 */
export class InMemoryOrderStore implements OrderIntentStore {
  private rows = new Map<string, OrderIntent>();
  /** 테스트가 저장 실패를 주입한다 */
  failNextUpdate = false;

  private k(scope: OrderScope, id: string) {
    return `${scope.familyCode}|${scope.profile}|${id}`;
  }

  async insert(intent: OrderIntent): Promise<StoreInsertResult> {
    for (const r of this.rows.values()) {
      if (sameScope(r.scope, intent.scope) && r.idempotencyKey === intent.idempotencyKey) {
        return { ok: false, reason: "duplicate_key" };
      }
    }
    this.rows.set(this.k(intent.scope, intent.id), structuredClone(intent));
    return { ok: true };
  }

  async getById(scope: OrderScope, id: string): Promise<OrderIntent | null> {
    const r = this.rows.get(this.k(scope, id));
    return r ? structuredClone(r) : null;
  }

  async findByKeyBase(scope: OrderScope, keyBase: string): Promise<OrderIntent[]> {
    return [...this.rows.values()]
      .filter((r) => sameScope(r.scope, scope) && keyBaseOf(r.idempotencyKey) === keyBase)
      .sort((a, b) => a.attempt - b.attempt)
      .map((r) => structuredClone(r));
  }

  async listOpen(scope: OrderScope): Promise<OrderIntent[]> {
    return [...this.rows.values()]
      .filter((r) => sameScope(r.scope, scope) && NON_TERMINAL.includes(r.state))
      .map((r) => structuredClone(r));
  }

  async update(
    scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch, now: string,
  ): Promise<StoreUpdateResult> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return { ok: false, reason: "error", message: "주입된 저장 실패" };
    }
    const cur = this.rows.get(this.k(scope, id));
    if (!cur) return { ok: false, reason: "not_found" };
    if (cur.version !== expectedVersion) return { ok: false, reason: "stale" };
    const next: OrderIntent = { ...cur, ...structuredClone(patch), version: cur.version + 1, updatedAt: now };
    this.rows.set(this.k(scope, id), next);
    return { ok: true, intent: structuredClone(next) };
  }

  /** 감사 행(수동 해소). 테스트가 확인한다 */
  readonly resolutions: OrderResolutionRecord[] = [];

  async findByOrderNo(scope: OrderScope, orderNo: string): Promise<OrderIntent | null> {
    for (const r of this.rows.values()) {
      if (sameScope(r.scope, scope) && r.orderNo === orderNo) return structuredClone(r);
    }
    return null;
  }

  async resolve(
    scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch,
    record: OrderResolutionRecord, now: string,
  ): Promise<StoreUpdateResult> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return { ok: false, reason: "error", message: "주입된 저장 실패" };
    }
    const cur = this.rows.get(this.k(scope, id));
    if (!cur) return { ok: false, reason: "not_found" };
    if (cur.version !== expectedVersion || !RESOLVABLE_STATES.includes(cur.state)) {
      return { ok: false, reason: "stale" };
    }
    if (patch.orderNo) {
      for (const r of this.rows.values()) {
        if (r.id !== id && sameScope(r.scope, scope) && r.orderNo === patch.orderNo) {
          return { ok: false, reason: "error", message: "같은 주문번호가 다른 의도에 붙어 있습니다" };
        }
      }
    }
    // 의도 갱신과 감사 행이 함께 반영된다(한쪽만 남지 않는다).
    const next: OrderIntent = { ...cur, ...structuredClone(patch), version: cur.version + 1, updatedAt: now };
    this.rows.set(this.k(scope, id), next);
    this.resolutions.push(structuredClone(record));
    return { ok: true, intent: structuredClone(next) };
  }

  /** 테스트가 저장된 행을 직접 본다(동결 필드 확인용). */
  peek(scope: OrderScope, id: string): OrderIntent | undefined {
    const r = this.rows.get(this.k(scope, id));
    return r ? structuredClone(r) : undefined;
  }
}

// ── Supabase 구현 ───────────────────────────────────────────────────────────

interface Row {
  family_code: string; profile: string; id: string; idempotency_key: string; attempt: number;
  account_instance_id: string; broker: string; product_code: string; side: string;
  ticker: string; quantity: number; limit_price: number; ord_dvsn: string; amount: number;
  buying_power_at_proposal: { amount: number; qty: number } | null;
  state: OrderState; state_version: number;
  approval_token_hash: string; approval_expires_at: string; approval_consumed_at: string | null;
  submit_started_at: string | null; order_no: string | null; order_org_no: string | null; order_time: string | null;
  /** migration 009 컬럼. 008 만 적용된 DB 에는 없다 */
  order_no_source?: string | null;
  evidence: OrderIntent["evidence"]; last_inquiry_at: string | null; ambiguous: boolean;
  last_error: string | null; policy_version: number; created_at: string; updated_at: string;
}

const toRow = (i: OrderIntent): Row => ({
  family_code: i.scope.familyCode, profile: i.scope.profile, id: i.id,
  idempotency_key: i.idempotencyKey, attempt: i.attempt,
  account_instance_id: i.accountInstanceId, broker: i.broker, product_code: i.productCode,
  side: i.side, ticker: i.ticker, quantity: i.quantity, limit_price: i.limitPrice,
  ord_dvsn: i.ordDvsn, amount: i.amount, buying_power_at_proposal: i.buyingPowerAtProposal,
  state: i.state, state_version: i.version,
  approval_token_hash: i.approvalTokenHash, approval_expires_at: i.approvalExpiresAt,
  approval_consumed_at: i.approvalConsumedAt,
  submit_started_at: i.submitStartedAt, order_no: i.orderNo, order_org_no: i.orderOrgNo,
  order_time: i.orderTime, evidence: i.evidence, last_inquiry_at: i.lastInquiryAt,
  ambiguous: i.ambiguous, last_error: i.lastError, policy_version: i.policyVersion,
  created_at: i.createdAt, updated_at: i.updatedAt,
  // 값이 있을 때만 싣는다(의도 생성 시점에는 항상 null 이다).
  ...(i.orderNoSource ? { order_no_source: i.orderNoSource } : {}),
});

const fromRow = (r: Row): OrderIntent => ({
  id: r.id, scope: { familyCode: r.family_code, profile: r.profile },
  idempotencyKey: r.idempotency_key, attempt: r.attempt,
  accountInstanceId: r.account_instance_id, broker: "kis", productCode: "22", side: "buy",
  ticker: r.ticker, quantity: r.quantity, limitPrice: r.limit_price, ordDvsn: "00", amount: r.amount,
  buyingPowerAtProposal: r.buying_power_at_proposal,
  state: r.state, version: r.state_version,
  approvalTokenHash: r.approval_token_hash, approvalExpiresAt: r.approval_expires_at,
  approvalConsumedAt: r.approval_consumed_at,
  submitStartedAt: r.submit_started_at, orderNo: r.order_no, orderOrgNo: r.order_org_no,
  orderNoSource: r.order_no_source === "user_linked" ? "user_linked"
    : r.order_no_source === "broker_response" ? "broker_response" : null,
  orderTime: r.order_time, evidence: r.evidence, lastInquiryAt: r.last_inquiry_at,
  ambiguous: r.ambiguous, lastError: r.last_error,
  createdAt: r.created_at, updatedAt: r.updated_at, policyVersion: r.policy_version,
});

const PATCH_COLUMNS: Record<keyof OrderIntentPatch, string> = {
  state: "state", approvalTokenHash: "approval_token_hash", approvalExpiresAt: "approval_expires_at",
  approvalConsumedAt: "approval_consumed_at", submitStartedAt: "submit_started_at",
  orderNo: "order_no", orderNoSource: "order_no_source", orderOrgNo: "order_org_no", orderTime: "order_time", evidence: "evidence",
  lastInquiryAt: "last_inquiry_at", ambiguous: "ambiguous", lastError: "last_error",
};

const errCode = (e: unknown) => (e as { code?: string } | null)?.code;

export class SupabaseOrderStore implements OrderIntentStore {
  constructor(private readonly client: SupabaseClient) {}
  private static readonly TABLE = "kaw_order_intent";

  async insert(intent: OrderIntent): Promise<StoreInsertResult> {
    const { error } = await this.client.from(SupabaseOrderStore.TABLE).insert(toRow(intent));
    if (!error) return { ok: true };
    const code = errCode(error);
    if (code === "23505") return { ok: false, reason: "duplicate_key" };
    // 42P01 = 테이블 없음(migration 008 미적용). 메모리로 대체하지 않는다.
    if (code === "42P01") return { ok: false, reason: "unavailable", message: "migration 008 미적용" };
    return { ok: false, reason: "error", message: error.message };
  }

  async getById(scope: OrderScope, id: string): Promise<OrderIntent | null> {
    const { data, error } = await this.client.from(SupabaseOrderStore.TABLE).select("*")
      .eq("family_code", scope.familyCode).eq("profile", scope.profile).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return fromRow(data as Row);
  }

  async findByKeyBase(scope: OrderScope, keyBase: string): Promise<OrderIntent[]> {
    const { data, error } = await this.client.from(SupabaseOrderStore.TABLE).select("*")
      .eq("family_code", scope.familyCode).eq("profile", scope.profile)
      .like("idempotency_key", `${keyBase}#%`).order("attempt", { ascending: true });
    if (error || !data) return [];
    return (data as Row[]).map(fromRow);
  }

  async listOpen(scope: OrderScope): Promise<OrderIntent[]> {
    const { data, error } = await this.client.from(SupabaseOrderStore.TABLE).select("*")
      .eq("family_code", scope.familyCode).eq("profile", scope.profile)
      .in("state", [...NON_TERMINAL]);
    if (error || !data) return [];
    return (data as Row[]).map(fromRow);
  }

  async update(
    scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch, now: string,
  ): Promise<StoreUpdateResult> {
    const cols: Record<string, unknown> = { state_version: expectedVersion + 1, updated_at: now };
    for (const [k, v] of Object.entries(patch)) {
      const col = PATCH_COLUMNS[k as keyof OrderIntentPatch];
      if (col) cols[col] = v;
    }
    const { data, error } = await this.client.from(SupabaseOrderStore.TABLE).update(cols)
      .eq("family_code", scope.familyCode).eq("profile", scope.profile).eq("id", id)
      // **compare-and-swap**: 읽은 version 과 같을 때만 쓴다.
      .eq("state_version", expectedVersion)
      .select("*");
    if (error) {
      if (errCode(error) === "42P01") return { ok: false, reason: "unavailable", message: "migration 008 미적용" };
      return { ok: false, reason: "error", message: error.message };
    }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) {
      // 행이 없는지, version 이 달라졌는지 구분한다.
      const cur = await this.getById(scope, id);
      return cur ? { ok: false, reason: "stale" } : { ok: false, reason: "not_found" };
    }
    return { ok: true, intent: fromRow(rows[0]) };
  }

  async findByOrderNo(scope: OrderScope, orderNo: string): Promise<OrderIntent | null> {
    const { data, error } = await this.client.from(SupabaseOrderStore.TABLE).select("*")
      .eq("family_code", scope.familyCode).eq("profile", scope.profile).eq("order_no", orderNo)
      .maybeSingle();
    if (error || !data) return null;
    return fromRow(data as Row);
  }

  /**
   * migration 009 의 `kaw_order_resolve` 한 번 호출 = 한 트랜잭션(의도 CAS + 감사 행).
   * 함수가 없으면(009 미적용) **쓰지 않고** unavailable 이다 — 두 번의 호출로 나눠
   * 흉내내지 않는다(한쪽만 반영될 수 있으므로).
   */
  async resolve(
    scope: OrderScope, id: string, expectedVersion: number, patch: OrderIntentPatch,
    record: OrderResolutionRecord, _now: string,
  ): Promise<StoreUpdateResult> {
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const col = PATCH_COLUMNS[k as keyof OrderIntentPatch];
      if (col) p[col] = v;
    }
    const { data, error } = await this.client.rpc("kaw_order_resolve", {
      p_family_code: scope.familyCode,
      p_profile: scope.profile,
      p_intent_id: id,
      p_expected_version: expectedVersion,
      p_patch: p,
      p_resolution: {
        id: record.id, action: record.action, actor: record.actor, note: record.note,
        prev_state: record.prevState, new_state: record.newState, prev_version: record.prevVersion,
        evidence: record.evidence, decided_at: record.decidedAt,
      },
    });
    if (error) {
      const code = errCode(error);
      if (code === "42883" || code === "PGRST202") {
        return { ok: false, reason: "unavailable", message: "migration 009 미적용" };
      }
      if (code === "23505") return { ok: false, reason: "error", message: "같은 주문번호가 다른 의도에 붙어 있습니다" };
      return { ok: false, reason: "error", message: error.message };
    }
    const r = (data ?? {}) as { status?: string; row?: Row };
    if (r.status === "ok" && r.row) return { ok: true, intent: fromRow(r.row) };
    if (r.status === "not_found") return { ok: false, reason: "not_found" };
    if (r.status === "stale") return { ok: false, reason: "stale" };
    return { ok: false, reason: "error", message: "해소 결과를 해석할 수 없습니다" };
  }
}
