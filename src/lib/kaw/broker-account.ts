// ─────────────────────────────────────────────────────────────────────────────
// 증권사 계좌 instance identity — 순수 모듈
//
// ## 왜 account_type 만으로는 안 되는가
//
// `account_type`(retirement / isa / pension / irp)은 **앱의 논리 계좌**이고 실제 증권사
// 계좌와 1:1 이 아니다. 실측 사례 두 개:
//
//   · pension → 미래에셋 연금저축(원장 86건) **그리고** 한국투자 연금저축 상품 22.
//               서로 다른 계좌다.
//   · irp     → 미래에셋 IRP → **2026-10-09 한국투자 IRP(29)로 실물이전**.
//               같은 account_type 안에서 instance 가 바뀌었다.
//
// `source_type` 에 증권사가 내포돼 있다는 것만으로는 "같은 계좌의 다른 조회 경로"와
// "다른 계좌"를 구분하지 못한다. 그래서 **instance identity 가 비교의 전제 조건**이다.
//
// ## 계좌번호를 저장하지 않는 3층 identity
//
//   accountInstanceId        **앱이 발급한 불투명 id.** 이것으로만 비교한다
//   broker + productCode     비정규화된 사실. 레지스트리가 없어도 행이 자기 설명을 한다
//   refFingerprint           **drift 탐지기.** identity 가 아니다.
//                            HMAC(ACCOUNT_FP_SECRET, broker|cano|product) 로 서버에서만
//                            계산한다 — CANO 원문은 저장·전송·로그하지 않는다.
//                            이 모듈에는 비교 규칙만 있고 계산은 없다(Phase 3).
//
// ## active 기간은 half-open [activeFrom, activeTo)
//
// 실물이전일에 두 instance 가 동시에 active 가 되는 중복을 구조적으로 없앤다.
//   미래에셋 IRP [2025-12-29, 2026-10-09)  /  한국투자 IRP [2026-10-09, ∞)
// → 2026-10-09 거래는 **한국투자 쪽으로만** 떨어진다.
//
// ## fail closed
//
// instance 가 다르거나, 같은데 fingerprint 가 다르거나, attribution 이 유일하지 않으면
// **비교하지 않는다.** 실물이전 연속성(lineage)은 별도 증거가 있어야만 cross-instance
// 비교를 허용하며 migration 006 이후다(§9 R15 조차 내부 transaction 을 증명하지 않았다).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { declaredBrokerOf } from "./ledger-source-registry";

/**
 * 증권사 계좌 instance 1개. `_meta.brokerAccounts` (kaw_data JSON) 에 산다.
 *
 * 테이블로 만들지 않는 이유: 이것은 **사용자 설정**(가변)이고, 증거 행(plan /
 * observation)이 broker·productCode 를 비정규화해 들고 있어 레지스트리 없이도 자기
 * 설명이 된다. `assetLibrary` 와 같은 위치·같은 성격이다.
 */
export interface BrokerAccountInstance {
  /** bai:<uuid8>. 앱이 발급한다. 계좌번호에서 파생시키지 않는다. */
  id: string;
  /** 사용자가 읽을 이름 ("미래에셋 IRP", "한국투자 IRP") */
  label: string;
  broker: string;
  /** KIS 계좌상품코드 ("22" / "29"). **비밀값이 아니다**(PoC 모듈 주석). */
  productCode?: string;
  logicalAccountType: AccountId;
  /** YYYY-MM-DD. 이 날짜부터 active (포함) */
  activeFrom: string;
  /** YYYY-MM-DD. 이 날짜부터는 **더 이상 active 가 아니다**(미포함). 없으면 현재까지 */
  activeTo?: string;
  /** HMAC 파생 drift 탐지기. 서버가 KIS 조회 성공 시 채운다. CANO 원문 아님 */
  refFingerprint?: string;
  /**
   * 이 계좌를 앱이 어떻게 다루는가. **없으면 `calc_only`** 다(기존 사용자의 기본값).
   *
   *   calc_only     계산만 제공 — 사용자가 수량·예수금을 직접 입력하고 앱은 계산만 한다.
   *                 증권사 API 를 **호출하지 않는다**
   *   api_readonly  증권사 API 로 **조회만** 한다(한국투자증권만). 주문·이체는 없다
   *
   * 이 값은 **사용자 선호**이지 조회 권한이 아니다. 서버는 이 값만 믿지 않고 자체 권한
   * 확인(kis-account-read.ts `authorizeKisAccess`)을 따로 한다.
   */
  connectionMode?: ConnectionMode;
}

export type ConnectionMode = "calc_only" | "api_readonly";

const CONNECTION_MODES: readonly ConnectionMode[] = ["calc_only", "api_readonly"];
const BROKER_ACCOUNT_TYPES = ["retirement", "isa", "pension", "irp"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 저장된 `_meta.brokerAccounts` 를 읽는다. 클라이언트(hydration)와 서버(조회 권한 판단)가
 * **같은 함수**를 쓴다.
 *
 * 모양이 어긋난 항목은 **고치지 않고 버린다.** 잘못 읽은 instance 로 조회 대상을 바꾸는
 * 것보다 없는 것으로 보는 편이 안전하다. 알려진 필드만 복사한다 — 저장된 JSON 에 계좌번호
 * 같은 값이 섞여 있어도 이 함수를 지난 객체에는 남지 않는다.
 */
export function parseBrokerAccounts(raw: unknown): BrokerAccountInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: BrokerAccountInstance[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const i = r as Record<string, unknown>;
    if (typeof i.id !== "string" || !i.id || seen.has(i.id)) continue;
    if (typeof i.broker !== "string" || !i.broker) continue;
    if (!BROKER_ACCOUNT_TYPES.includes(i.logicalAccountType as AccountId)) continue;
    if (typeof i.activeFrom !== "string" || !ISO_DATE.test(i.activeFrom)) continue;
    if (i.activeTo !== undefined && (typeof i.activeTo !== "string" || !ISO_DATE.test(i.activeTo))) continue;
    seen.add(i.id);
    // 라벨에 긴 숫자열(계좌번호 패턴)이 있으면 쓰지 않는다 — id 로 대체한다.
    const label = typeof i.label === "string" && i.label.length <= 60 && !/\d{8,}/.test(i.label)
      ? i.label : i.id;
    out.push({
      id: i.id,
      label,
      broker: i.broker,
      ...(typeof i.productCode === "string" && /^\d{2}$/.test(i.productCode)
        ? { productCode: i.productCode } : {}),
      logicalAccountType: i.logicalAccountType as AccountId,
      activeFrom: i.activeFrom,
      ...(typeof i.activeTo === "string" ? { activeTo: i.activeTo } : {}),
      ...(typeof i.refFingerprint === "string" ? { refFingerprint: i.refFingerprint } : {}),
      ...(CONNECTION_MODES.includes(i.connectionMode as ConnectionMode)
        ? { connectionMode: i.connectionMode as ConnectionMode } : {}),
    });
  }
  return out;
}

/** half-open 판정: activeFrom <= date < activeTo */
export function isActiveOn(instance: BrokerAccountInstance, date: string): boolean {
  if (date < instance.activeFrom) return false;
  if (instance.activeTo !== undefined && date >= instance.activeTo) return false;
  return true;
}

// ── instance identity 비교 ──────────────────────────────────────────────────

export type InstanceMatch =
  /** 같은 계좌로 확인됐다. 비교해도 된다 */
  | { kind: "same" }
  /** instance 가 다르다. lineage 증거 없이는 비교하지 않는다 (006+) */
  | { kind: "cross_instance_unverified"; planInstanceId: string; otherInstanceId: string }
  /** instance id 는 같은데 fingerprint 가 다르다 — credential 이 다른 계좌를 가리킨다 */
  | { kind: "credential_drift_suspected"; instanceId: string };

/**
 * 두 증거(plan / observation)가 같은 계좌의 것인가.
 *
 * fingerprint 는 **양쪽에 모두 있을 때만** 비교한다. 한쪽이 없는 것은 불일치가 아니다
 * (미래에셋은 API 가 없어 fingerprint 를 만들 수 없다).
 */
export function sameInstance(
  a: { accountInstanceId: string; accountRefFingerprint?: string | null },
  b: { accountInstanceId: string; accountRefFingerprint?: string | null },
): InstanceMatch {
  if (a.accountInstanceId !== b.accountInstanceId) {
    return {
      kind: "cross_instance_unverified",
      planInstanceId: a.accountInstanceId,
      otherInstanceId: b.accountInstanceId,
    };
  }
  const fa = a.accountRefFingerprint;
  const fb = b.accountRefFingerprint;
  if (fa && fb && fa !== fb) {
    return { kind: "credential_drift_suspected", instanceId: a.accountInstanceId };
  }
  return { kind: "same" };
}

// ── 원장 attribution (immutable 원장에 컬럼을 추가하지 않고 파생한다) ───────

/** attribution 의 근거. UI 는 이것을 신뢰도로 노출해야 한다. */
export type AttributionEvidence =
  /** source 가 증권사를 선언했고 그 증권사의 instance 가 그 날짜에 1개뿐이다 */
  | "broker_and_period"
  /** source 선언이 없지만 그 날짜에 active 한 instance 가 1개뿐이다 */
  | "single_active_instance"
  /** 사용자가 명시적으로 귀속시켰다 (migration 006+ overlay) */
  | "explicit_overlay";

export type LedgerAttribution =
  | { kind: "resolved"; accountInstanceId: string; evidence: AttributionEvidence }
  | { kind: "unknown"; reason: "no_active_instance_at_date" | "no_registry" }
  | { kind: "ambiguous"; candidates: string[] }
  /** source 가 선언한 증권사의 instance 가 그 날짜에 없다 — 데이터가 서로 모순 */
  | { kind: "conflict"; detail: string };

/** attribution 판정에 필요한 최소 정보. 원장 거래든 이벤트든 이 모양으로 줄인다. */
export interface AttributableRecord {
  accountType: AccountId;
  /** 실효 거래일 (grouping 에 쓰는 날짜) */
  eventDate: string;
  /** kaw_transaction_ledger.source */
  source: string;
}

/**
 * 원장 거래 1건이 어느 broker account instance 의 것인가.
 *
 * **account_type 만으로 붙이지 않는다.** 유일하게 특정되는 경우에만 resolved 이고,
 * 나머지는 unknown / ambiguous / conflict 로 fail closed 한다.
 *
 * @param overlay migration 006+ 의 명시적 귀속. 있으면 최우선이다.
 */
export function resolveLedgerAccountAttribution(
  record: AttributableRecord,
  brokerAccounts: readonly BrokerAccountInstance[],
  overlay?: { accountInstanceId: string } | null,
): LedgerAttribution {
  if (overlay) {
    return {
      kind: "resolved",
      accountInstanceId: overlay.accountInstanceId,
      evidence: "explicit_overlay",
    };
  }
  if (!brokerAccounts.length) return { kind: "unknown", reason: "no_registry" };

  const active = brokerAccounts.filter(
    (i) => i.logicalAccountType === record.accountType && isActiveOn(i, record.eventDate),
  );
  if (!active.length) return { kind: "unknown", reason: "no_active_instance_at_date" };

  const declared = declaredBrokerOf(record.source);
  if (declared !== null) {
    const byBroker = active.filter((i) => i.broker === declared);
    if (!byBroker.length) {
      return {
        kind: "conflict",
        detail:
          `source 가 선언한 증권사(${declared})의 ${record.accountType} instance 가 ` +
          `${record.eventDate} 에 active 하지 않다`,
      };
    }
    if (byBroker.length > 1) return { kind: "ambiguous", candidates: byBroker.map((i) => i.id) };
    return { kind: "resolved", accountInstanceId: byBroker[0].id, evidence: "broker_and_period" };
  }

  if (active.length > 1) return { kind: "ambiguous", candidates: active.map((i) => i.id) };
  return { kind: "resolved", accountInstanceId: active[0].id, evidence: "single_active_instance" };
}

/**
 * 이벤트(= 같은 계좌·같은 실효 거래일 묶음) 1개의 attribution.
 *
 * 소속 거래를 전부 resolve 해서 **전원 일치할 때만** resolved 다. 하나라도 다르면
 * conflict — 다수결로 추측하지 않는다.
 */
export function resolveEventAttribution(
  transactions: readonly AttributableRecord[],
  brokerAccounts: readonly BrokerAccountInstance[],
  overlay?: { accountInstanceId: string } | null,
): LedgerAttribution {
  if (overlay) {
    return {
      kind: "resolved",
      accountInstanceId: overlay.accountInstanceId,
      evidence: "explicit_overlay",
    };
  }
  if (!transactions.length) return { kind: "unknown", reason: "no_active_instance_at_date" };

  const results = transactions.map((t) => resolveLedgerAccountAttribution(t, brokerAccounts));

  const conflict = results.find((r) => r.kind === "conflict");
  if (conflict) return conflict;
  const ambiguous = results.find((r) => r.kind === "ambiguous");
  if (ambiguous) return ambiguous;
  const unknown = results.find((r) => r.kind === "unknown");
  if (unknown) return unknown;

  const resolved = results.filter(
    (r): r is Extract<LedgerAttribution, { kind: "resolved" }> => r.kind === "resolved",
  );
  const ids = [...new Set(resolved.map((r) => r.accountInstanceId))];
  if (ids.length > 1) {
    return {
      kind: "conflict",
      detail: `한 이벤트의 거래가 서로 다른 instance 로 귀속된다: ${ids.join(", ")}`,
    };
  }
  // 근거가 섞이면 약한 쪽을 택한다 — 가장 강한 근거로 올려 말하지 않는다.
  const evidence: AttributionEvidence = resolved.every((r) => r.evidence === "broker_and_period")
    ? "broker_and_period"
    : "single_active_instance";
  return { kind: "resolved", accountInstanceId: ids[0], evidence };
}

/** 레지스트리에서 instance 1개 찾기. 없으면 undefined. */
export function findInstance(
  brokerAccounts: readonly BrokerAccountInstance[],
  id: string,
): BrokerAccountInstance | undefined {
  return brokerAccounts.find((i) => i.id === id);
}
