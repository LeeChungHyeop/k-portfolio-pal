// ─────────────────────────────────────────────────────────────────────────────
// 계좌별 증권사 · 운용방식 설정 — 순수 모듈
//
// 저장 위치는 새로 만들지 않는다. **기존 `_meta.brokerAccounts`**(BrokerAccountInstance)
// 가 그대로 쓰인다: 가족·프로필별 `_meta` 행 안에 있고, instance 가 논리계좌
// (`logicalAccountType`)를 들고 있으므로 "가족·프로필·논리계좌별 독립 설정"이 된다.
//
//   증권사   kis(한국투자증권) / other(기타 증권사). 미래에셋은 선택지가 아니다
//   운용방식 calc_only(계산만 제공) / api_readonly(한국투자 API 조회 전용)
//
// ── 원칙 ───────────────────────────────────────────────────────────────────
//
//   1. **기본값은 계산만 제공이다.** instance 가 없거나 `connectionMode` 가 없으면
//      calc_only 다. 기존 사용자의 저장 데이터에는 이 필드가 없다 → 동작이 바뀌지 않는다
//   2. **설정 변경은 과거를 지우지 않는다.** 증권사를 바꾸면 기존 instance 를 **닫고**
//      (activeTo) 새 instance 를 **추가**한다. 삭제·id 변경·수량/예수금/거래 변경이 없다.
//      half-open 기간이라 같은 날 두 instance 가 동시에 active 가 되지 않는다
//   3. **이 값은 조회 권한이 아니다.** 사용자 선호일 뿐이고 서버가 따로 권한을 확인한다
//   4. **계좌 이전·변경을 거래로 만들지 않는다.** 이 모듈은 레지스트리만 바꾼다 —
//      원장·cashflow·보유수량을 읽지도 쓰지도 않는다
//   5. **계좌번호가 들어갈 자리가 없다.** 입력은 증권사 선택·방식·날짜뿐이고, 상품코드는
//      논리계좌에서 결정되는 공개 코드(22/29)다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import {
  isActiveOn,
  type BrokerAccountInstance,
  type ConnectionMode,
} from "./broker-account";

export type BrokerChoice = "kis" | "other";

export const BROKER_CHOICE_LABEL: Readonly<Record<BrokerChoice, string>> = {
  kis: "한국투자증권",
  other: "기타 증권사",
};

export const CONNECTION_MODE_LABEL: Readonly<Record<ConnectionMode, string>> = {
  calc_only: "계산만 제공",
  api_readonly: "API 연동 (읽기 전용)",
};

/** 한국투자 API 조회를 지원하는 논리계좌와 상품코드. 그 외(퇴직연금 DC·ISA)는 미지원이다. */
export const KIS_API_PRODUCT_BY_ACCOUNT: Readonly<Partial<Record<AccountId, "22" | "29">>> = {
  pension: "22",
  irp: "29",
};

export function kisApiProductOf(accountType: AccountId): "22" | "29" | null {
  return KIS_API_PRODUCT_BY_ACCOUNT[accountType] ?? null;
}

/** 이 증권사에서 쓸 수 있는 운용방식. 기타 증권사는 계산만 제공으로 **고정**이다. */
export function allowedModes(broker: BrokerChoice, accountType: AccountId): ConnectionMode[] {
  if (broker === "other") return ["calc_only"];
  return kisApiProductOf(accountType) ? ["calc_only", "api_readonly"] : ["calc_only"];
}

// ── 현재 설정 읽기 ──────────────────────────────────────────────────────────

export type ActiveInstance =
  | { kind: "none" }
  | { kind: "one"; instance: BrokerAccountInstance }
  | { kind: "ambiguous"; candidates: string[] };

export function activeInstanceOf(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  date: string,
): ActiveInstance {
  const active = registry.filter(
    (i) => i.logicalAccountType === accountType && isActiveOn(i, date),
  );
  if (!active.length) return { kind: "none" };
  if (active.length > 1) return { kind: "ambiguous", candidates: active.map((i) => i.id).sort() };
  return { kind: "one", instance: active[0] };
}

export interface AccountConnection {
  /** 설정된 증권사. 아직 설정하지 않았으면 null */
  broker: BrokerChoice | null;
  mode: ConnectionMode;
  instance: BrokerAccountInstance | null;
  ambiguous: boolean;
  /** 이 논리계좌가 한국투자 API 조회를 지원하는가 */
  apiSupported: boolean;
}

/**
 * 지금 이 논리계좌의 설정. **instance 가 없으면 계산만 제공이다.**
 *
 * 미래에셋 등 선택지에 없는 증권사의 기존 instance 는 `other` 로 보인다(내부 id·이력은
 * 그대로다). 기존 데이터를 다른 값으로 바꿔 쓰지 않는다.
 */
export function connectionOf(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  date: string,
): AccountConnection {
  const apiSupported = kisApiProductOf(accountType) !== null;
  const a = activeInstanceOf(registry, accountType, date);
  if (a.kind === "none") {
    return { broker: null, mode: "calc_only", instance: null, ambiguous: false, apiSupported };
  }
  if (a.kind === "ambiguous") {
    // 둘 이상이면 어느 쪽 설정도 믿지 않는다 — 계산만 제공이다.
    return { broker: null, mode: "calc_only", instance: null, ambiguous: true, apiSupported };
  }
  const i = a.instance;
  const broker: BrokerChoice = i.broker === "kis" ? "kis" : "other";
  const mode: ConnectionMode =
    broker === "kis" && apiSupported && i.connectionMode === "api_readonly"
      ? "api_readonly"
      : "calc_only";
  return { broker, mode, instance: i, ambiguous: false, apiSupported };
}

// ── API 조회 허용 판단 (클라이언트·서버 공용) ───────────────────────────────

export type ApiQueryGate =
  | { allowed: true; productCode: "22" | "29"; instance: BrokerAccountInstance }
  | {
      allowed: false;
      reason:
        | "mode_calc_only"
        | "broker_not_kis"
        | "account_type_unsupported"
        | "instance_unregistered"
        | "instance_ambiguous"
        | "instance_not_active"
        | "product_mismatch";
    };

/**
 * 이 논리계좌에서 KIS API 를 **호출해도 되는가.** 클라이언트가 호출 전에, 서버가 조회 전에
 * 같은 함수로 판단한다.
 *
 * 허용 조건은 전부 **레지스트리에 있는 사실**이다. sentinel(미등록)은 허용하지 않는다 —
 * sentinel 은 "어느 계좌인가"에 대한 주장이 아니므로 그것으로 실제 계좌를 조회하지 않는다.
 *
 * `requestedProduct` 를 주면 레지스트리의 상품코드와 **일치해야** 한다(22 요청이 IRP
 * instance 를 통과하는 혼합을 막는다).
 */
export function kisApiQueryGate(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  date: string,
  requestedProduct?: string,
): ApiQueryGate {
  const product = kisApiProductOf(accountType);
  if (!product) return { allowed: false, reason: "account_type_unsupported" };

  const mine = registry.filter((i) => i.logicalAccountType === accountType);
  if (!mine.length) return { allowed: false, reason: "instance_unregistered" };

  const a = activeInstanceOf(registry, accountType, date);
  if (a.kind === "ambiguous") return { allowed: false, reason: "instance_ambiguous" };
  if (a.kind === "none") return { allowed: false, reason: "instance_not_active" };

  const i = a.instance;
  if (i.broker !== "kis") return { allowed: false, reason: "broker_not_kis" };
  if (i.productCode !== product) return { allowed: false, reason: "product_mismatch" };
  if (requestedProduct !== undefined && requestedProduct !== product) {
    return { allowed: false, reason: "product_mismatch" };
  }
  if (i.connectionMode !== "api_readonly") return { allowed: false, reason: "mode_calc_only" };
  return { allowed: true, productCode: product, instance: i };
}

// ── 설정 변경 ───────────────────────────────────────────────────────────────

export interface ConnectionChange {
  broker: BrokerChoice;
  mode: ConnectionMode;
}

export type ConnectionChangeResult =
  | {
      ok: true;
      registry: BrokerAccountInstance[];
      /** 레지스트리가 실제로 바뀌었는가 */
      changed: boolean;
      /** 새로 만든 instance id (있으면) */
      createdId?: string;
      /** 닫은 instance id (있으면). 삭제가 아니라 activeTo 만 채운다 */
      closedId?: string;
    }
  | {
      ok: false;
      reason:
        | "mode_not_allowed"
        | "ambiguous_active_instances"
        | "pending_instance_exists"
        | "start_before_current"
        | "invalid_date";
      message: string;
    };

export interface ChangeOptions {
  /** 오늘(KST). 기본 시작일이다 */
  today: string;
  /** 새 instance 의 시작일. 없으면 today. 미래 날짜면 "이전·개설 진행 중"이 된다 */
  activeFrom?: string;
  newId: () => string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function autoLabel(broker: BrokerChoice, accountType: AccountId): string {
  const acct: Record<AccountId, string> = {
    retirement: "퇴직연금", isa: "ISA", pension: "연금저축", irp: "IRP",
  };
  return `${BROKER_CHOICE_LABEL[broker]} ${acct[accountType]}`;
}

/**
 * 설정을 적용한 **새 레지스트리**를 돌려준다. 입력을 변형하지 않는다.
 *
 * 규칙:
 *   · 같은 증권사로 방식만 바꾸면 **같은 instance 의 `connectionMode` 만** 바꾼다
 *   · 증권사가 바뀌면 현재 instance 를 닫고(`activeTo = 새 시작일`) 새 instance 를 추가한다.
 *     닫힌 instance 의 id·기간·productCode 는 그대로다
 *   · 현재 instance 의 시작일보다 이른 시작일은 거부한다(기간이 뒤집힌다)
 *   · 같은 날 active 인 instance 가 둘 이상이면 **아무것도 바꾸지 않는다**
 */
export function applyConnectionChange(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  change: ConnectionChange,
  opts: ChangeOptions,
): ConnectionChangeResult {
  if (!allowedModes(change.broker, accountType).includes(change.mode)) {
    return {
      ok: false,
      reason: "mode_not_allowed",
      message:
        change.broker === "other"
          ? "기타 증권사는 계산만 제공됩니다."
          : "이 계좌 종류는 아직 API 조회를 지원하지 않습니다.",
    };
  }
  const activeFrom = opts.activeFrom ?? opts.today;
  if (!ISO.test(activeFrom)) {
    return { ok: false, reason: "invalid_date", message: "시작일 형식이 올바르지 않습니다." };
  }

  const cur = activeInstanceOf(registry, accountType, opts.today);
  if (cur.kind === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous_active_instances",
      message: "같은 날짜에 사용 중인 계좌가 둘 이상이라 설정을 바꿀 수 없습니다.",
    };
  }

  const product = change.broker === "kis" ? kisApiProductOf(accountType) : null;

  // 같은 증권사 → 같은 instance 의 방식만 갱신한다.
  if (cur.kind === "one") {
    const i = cur.instance;
    const sameBroker = (i.broker === "kis") === (change.broker === "kis");
    if (sameBroker) {
      const nextMode: ConnectionMode = change.mode;
      const nextProduct = change.broker === "kis" ? (product ?? i.productCode) : i.productCode;
      if ((i.connectionMode ?? "calc_only") === nextMode && i.productCode === nextProduct) {
        return { ok: true, registry: [...registry], changed: false };
      }
      const next = registry.map((r) =>
        r.id === i.id
          ? {
              ...r,
              connectionMode: nextMode,
              ...(nextProduct !== undefined ? { productCode: nextProduct } : {}),
            }
          : r,
      );
      return { ok: true, registry: next, changed: true };
    }
  }

  // 증권사가 바뀌었거나 instance 가 없다 → 새 instance 를 추가한다.
  // 이미 **시작 예정**인 instance 가 있으면 또 만들지 않는다 — 시작일이 오면 두 계좌가
  // 같은 날 active 가 되어 어느 쪽도 믿을 수 없게 된다.
  const pending = registry.filter(
    (r) => r.logicalAccountType === accountType && r.activeFrom > opts.today,
  );
  if (pending.length) {
    return {
      ok: false,
      reason: "pending_instance_exists",
      message: "이미 시작 예정인 계좌가 있어 새로 추가할 수 없습니다.",
    };
  }
  let base = [...registry];
  let closedId: string | undefined;
  if (cur.kind === "one") {
    const i = cur.instance;
    if (activeFrom <= i.activeFrom) {
      return {
        ok: false,
        reason: "start_before_current",
        message: "시작일이 현재 계좌의 시작일보다 늦어야 합니다.",
      };
    }
    // 이미 끝나는 날짜가 정해져 있고 그것이 더 이르면 그대로 둔다(기간을 늘리지 않는다).
    if (i.activeTo === undefined || i.activeTo > activeFrom) {
      base = base.map((r) => (r.id === i.id ? { ...r, activeTo: activeFrom } : r));
      closedId = i.id;
    }
  }

  const createdId = `bai:${opts.newId()}`;
  const created: BrokerAccountInstance = {
    id: createdId,
    label: autoLabel(change.broker, accountType),
    broker: change.broker === "kis" ? "kis" : "other",
    ...(product ? { productCode: product } : {}),
    logicalAccountType: accountType,
    activeFrom,
    connectionMode: change.mode,
  };
  return {
    ok: true,
    registry: [...base, created],
    changed: true,
    createdId,
    ...(closedId ? { closedId } : {}),
  };
}
