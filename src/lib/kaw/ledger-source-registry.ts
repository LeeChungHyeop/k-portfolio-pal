// ─────────────────────────────────────────────────────────────────────────────
// 원장 source 레지스트리 — 순수 모듈
//
// `kaw_transaction_ledger.source` 가 **어느 증권사에서 온 자료인가**를 선언한다.
// 관측 source 레지스트리(`source-registry.ts`)와 **별개 맵**이다 — 한쪽은 체결 증거의
// 출처고 다른 쪽은 계좌 상태 관측의 출처라, 같은 맵에 두면 `A-exec` 와 `P/H/B` 가
// 섞인다(§9-2 가 경계한 바로 그 혼동).
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
//
// 원장은 **immutable** 이고(service_role 에 UPDATE 없음) broker account instance
// 식별자 컬럼이 없다. 그래서 "이 체결이 어느 증권사 계좌에서 일어났는가"를 나중에
// 행에 stamp 할 수 없다. 대신 `source` + `account_type` + `event_date` 와 계좌
// 레지스트리의 active 기간을 조합해 **파생**한다 (`broker-account.ts`).
//
// 이 맵이 하는 일은 그 조합의 한 축인 **"source 가 선언한 증권사"** 뿐이다.
//
// ── 추정하지 않는다 ─────────────────────────────────────────────────────────
//
// source 이름에 증권사가 들어 있어 보여도 문자열에서 유추하지 않는다. 등록되지
// 않은 source 는 `broker: null` 이고, 그러면 attribution 은 **active 기간만으로**
// 유일하게 특정되는 경우에만 resolved 가 된다.
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerSourceInfo {
  /** 이 source 의 자료가 나온 증권사. 모르면 null — 이름에서 유추하지 않는다. */
  broker: string | null;
  /** 이 판단의 근거. */
  source: string;
  verifiedAt: string;
}

/**
 * 현재 production 원장(463건)에 실제로 존재하는 source 3종.
 *
 * 실측 분포 (data/verified-transactions.v1.json):
 *   miraeasset_retirement_web              282건  (퇴직연금 DC + IRP 매매내역)
 *   miraeasset_transaction_history         171건  (ISA + 연금저축 거래내역)
 *   user_supplied_missing_irp_2025-12-29    10건  (사용자 보완 — dataset sourceNotes)
 */
export const LEDGER_SOURCE_REGISTRY: Readonly<Record<string, LedgerSourceInfo>> = Object.freeze({
  miraeasset_retirement_web: {
    broker: "miraeasset",
    source: "미래에셋 퇴직연금(DC/IRP) 매매내역 export. 주문일을 증권사가 직접 보고한다",
    verifiedAt: "2026-10-07",
  },
  miraeasset_transaction_history: {
    broker: "miraeasset",
    source: "미래에셋 일반 거래내역 export (ISA/연금저축). 결제일이 직접 사실이고 주문일은 추정이다",
    verifiedAt: "2026-10-07",
  },
  "user_supplied_missing_irp_2025-12-29": {
    // 사용자가 증권사 화면에서 확인해 보완한 행이라 **어느 증권사인지 source 이름이
    // 보장하지 않는다.** 이름에 irp 가 들어 있다는 이유로 broker 를 채우지 않는다 —
    // 이 10건은 active 기간이 유일해서 attribution 이 풀린다(single_active_instance).
    broker: null,
    source: "IRP.xlsx 에 누락된 2025-12-29 최초 배분을 사용자가 확인해 보완한 10행 (dataset sourceNotes)",
    verifiedAt: "2026-10-07",
  },
});

/** 미지 source 의 보수값. broker 를 선언하지 않는다. */
export const UNKNOWN_LEDGER_SOURCE: LedgerSourceInfo = Object.freeze({
  broker: null,
  source: "레지스트리에 없는 원장 source — 증권사를 선언하지 않는다(fail closed)",
  verifiedAt: "",
});

/** 원장 source 정보. 모르는 source 는 보수값을 돌려준다(throw 하지 않는다). */
export function ledgerSourceInfoOf(source: string): LedgerSourceInfo {
  return LEDGER_SOURCE_REGISTRY[source] ?? UNKNOWN_LEDGER_SOURCE;
}

/** 이 source 가 선언한 증권사. 선언이 없으면 null. */
export function declaredBrokerOf(source: string): string | null {
  return ledgerSourceInfoOf(source).broker;
}
