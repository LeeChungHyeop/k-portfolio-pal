// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 체결 → 원장 반영 **인터페이스 설계** (Phase 4-C 예약) — 이 단계에서는 닫혀 있다
//
// 이 파일은 **설계와 타입만** 담는다. 저장 경로는 연결돼 있지 않다:
//   · 서버에 승인(approve) 라우트가 없다 (`server.ts` 에 등록하지 않는다 — 테스트로 고정)
//   · `requestApproval` 은 어떤 네트워크 호출도 하지 않고 항상 `not_enabled` 를 돌려준다
//   · 화면의 반영 버튼은 비활성이다(KisExecutionImportPanel)
//
// ## 4-C 에서 열 때의 규칙 (미리 못박아 둔다)
//
//   1. **서버가 다시 조회·재판정한다.** 클라이언트가 보낸 행 값은 신뢰하지 않는다. 요청은
//      "어떤 주문을 반영할지"(불투명 키)와 사용자가 확인한 이전 증거만 담는다
//   2. 반영할 수 있는 것은 재판정에서도 `신규 체결` 인 행뿐이다 — 중복 가능성·귀속 충돌·확인 불가는
//      사용자가 개별로 풀기 전에는 거부한다
//   3. 이전 증거(`TransferEvidence`)가 충분하지 않으면 서버가 거부한다. 클라이언트의 "확인했다"
//      표시만으로는 열리지 않는다 — 이탈 근거는 원장에 이미 있어야 한다
//   4. 한 번의 반영은 한 트랜잭션이다(전부 아니면 전무). 원장 행은 기존 적재 경로
//      (`kaw_ledger_import_batch` + `source_fingerprint` UNIQUE)로만 들어가고, 감사 로그를 남긴다
//   5. cashflow · 리밸런싱 완료 기록 · 보유수량 상태를 같이 바꾸지 않는다
//   6. 응답 원문·계좌번호·키·토큰을 저장하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

import type { TransferEvidence } from "./account-transfer-model";

/** 승인 API 를 열었는가. **false 다.** 4-C 에서 서버 라우트와 함께 바뀐다. */
export const APPROVAL_API_ENABLED = false;

export interface ApprovalRequest {
  /** 조회 기간(서버가 같은 기간을 다시 조회한다) */
  start: string;
  end: string;
  /** 반영할 주문의 불투명 키 — 미리보기 응답의 `row.key`. 금액·수량을 보내지 않는다 */
  orderKeys: readonly string[];
  /** 사용자가 확인한 이전 증거. 서버가 원장과 대조해 충분성을 다시 판정한다 */
  transferEvidence: TransferEvidence;
}

export type ApprovalDenied =
  | "not_enabled"
  | "stale_preview"
  | "not_new"
  | "transfer_evidence_insufficient"
  | "funding_evidence_missing"
  | "prior_broker_residual"
  | "query_incomplete";

export type ApprovalResult =
  | { ok: true; insertedCount: number; importBatchId: string }
  | { ok: false; reason: ApprovalDenied };

/**
 * 승인 요청. **이 단계에서는 항상 거부한다** — 네트워크를 타지 않는다.
 * 4-C 에서 이 함수의 본문만 서버 호출로 바뀐다(시그니처는 그대로다).
 */
export async function requestApproval(_req: ApprovalRequest): Promise<ApprovalResult> {
  if (!APPROVAL_API_ENABLED) return { ok: false, reason: "not_enabled" };
  return { ok: false, reason: "not_enabled" };
}
