// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 실잔고 조회 — 브라우저 쪽 호출 (사용자가 누를 때만)
//
//   · **자동 호출이 없다.** 마운트·폴링·타이머에서 부르지 않는다 — 설정 화면의
//     "연결 확인" 버튼 같은 사용자 동작에서만 호출한다
//   · **계산만 제공이면 요청 자체를 보내지 않는다.** 서버가 한 번 더 거부하지만, 호출을
//     만드는 쪽에서 먼저 막는다(`kisApiQueryGate` 는 서버와 같은 함수다)
//   · 응답을 "잔고 0"으로 바꾸지 않는다. 조회하지 않았거나 실패한 축은 값이 없다
//   · API 키·계좌번호를 다루지 않는다 — 이 모듈은 둘 다 모른다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import type { BrokerAccountInstance } from "./broker-account";
import { kisApiQueryGate, type ApiQueryGate } from "./broker-connection";
import { getSessionToken } from "./auth";
import type { BuyPlanInputs, KisAccountObservation } from "./kis-account-observe";

export type KisClientResult =
  /** 서버가 조회를 시도했거나(observation) 조회하지 않은 이유를 알려줬다 */
  | { kind: "result"; observation: KisAccountObservation; plan: BuyPlanInputs }
  /** 호출 전에 막았다 — 요청을 보내지 않았다 */
  | { kind: "blocked"; gate: Extract<ApiQueryGate, { allowed: false }> }
  /** 이 프로필에는 조회 권한이 없다(서버 403) */
  | { kind: "denied" }
  | { kind: "unauthenticated" }
  /** 서버 설정이 없다(503) 또는 응답을 해석하지 못했다 */
  | { kind: "unavailable"; message: string };

/** 사람이 읽는 차단 사유. 잔고 0 이라고 말하지 않는다. */
export const GATE_REASON_TEXT: Readonly<Record<Extract<ApiQueryGate, { allowed: false }>["reason"], string>> = {
  mode_calc_only: "이 계좌는 '계산만 제공'이라 증권사를 조회하지 않습니다.",
  broker_not_kis: "한국투자증권 계좌가 아니라 조회하지 않습니다.",
  account_type_unsupported: "이 계좌 종류는 아직 API 조회를 지원하지 않습니다.",
  instance_unregistered: "등록된 계좌가 없어 조회하지 않습니다.",
  instance_ambiguous: "사용 중인 계좌가 둘 이상이라 조회하지 않습니다.",
  instance_not_active: "계좌 사용 시작일이 아직 되지 않았거나 이미 종료돼 조회하지 않습니다.",
  product_mismatch: "계좌 상품코드가 맞지 않아 조회하지 않습니다.",
};

/**
 * 조회를 요청한다. 레지스트리가 허용하지 않으면 **네트워크를 타지 않는다.**
 * `fetchImpl` 은 테스트가 요청 유무를 확인하려고 주입한다.
 */
export async function requestKisAccount(
  registry: readonly BrokerAccountInstance[],
  accountType: AccountId,
  today: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KisClientResult> {
  const gate = kisApiQueryGate(registry, accountType, today);
  if (!gate.allowed) return { kind: "blocked", gate };

  const token = getSessionToken();
  if (!token) return { kind: "unauthenticated" };

  let res: Response;
  try {
    res = await fetchImpl(`/api/kis/account?product=${gate.productCode}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { kind: "unavailable", message: "서버에 연결하지 못했습니다." };
  }

  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403) return { kind: "denied" };
  if (!res.ok) return { kind: "unavailable", message: `서버가 응답하지 못했습니다 (HTTP ${res.status}).` };

  const body = (await res.json().catch(() => null)) as
    | { observation?: KisAccountObservation; plan?: BuyPlanInputs }
    | null;
  if (!body?.observation || !body.plan) {
    return { kind: "unavailable", message: "응답을 해석하지 못했습니다." };
  }
  return { kind: "result", observation: body.observation, plan: body.plan };
}
