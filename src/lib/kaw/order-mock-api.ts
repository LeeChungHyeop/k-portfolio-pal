// ─────────────────────────────────────────────────────────────────────────────
// 주문 UI mock 전용 가짜 API — **운영 코드가 import 하지 않는다**(테스트로 고정).
//
// 실제 네트워크·Supabase·증권사를 쓰지 않는다. 계좌·가격·주문번호는 전부 **가상값**이다
// (운영 계좌정보를 쓰지 않는다). mock 화면(mock/order-ui)과 테스트만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

import { ORDER_TARGET, type ConfirmView, type IntentView, type OrderApi } from "./order-client";

export const MOCK_INSTANCE = Object.freeze({
  id: "bai:mock-pension",
  label: "모의 연금저축(가상 계좌)",
  productCode: "22",
});

/** 가상 지정가 — 실제 시세가 아니다 */
export const MOCK_PRICE = 20_000;
/** 가상 주문번호. 수동 연결 시나리오에서 이 번호만 "증권사 조회에 있음"으로 취급한다 */
export const MOCK_LINKABLE_ORDER_NO = "0000000777";

export type MockScenario =
  | "accept_then_fill"
  | "reject"
  | "timeout_unknown"
  | "candidate_unknown"
  | "price_drift"
  | "server_off";

export const MOCK_SCENARIO_TEXT: Record<MockScenario, string> = {
  accept_then_fill: "정상: 접수 → 미체결 → 체결 (상태 조회할 때마다 진행)",
  reject: "증권사 거부",
  timeout_unknown: "응답 유실(불명) — 수동 해소 가능",
  candidate_unknown: "불명 + 주문번호 없는 후보(확인 필요)",
  price_drift: "최종 승인 시 시세 급변(전송 안 함)",
  server_off: "서버 주문 flag OFF",
};

export interface MockOptions {
  /** 응답 지연(ms). 로딩·중복 클릭 확인용 */
  delayMs?: number;
  /** 주문일 장이 끝난 것으로 본다(미접수 정리 허용 조건) */
  dayClosed?: () => boolean;
  now?: () => number;
}

export interface MockOrderApi extends OrderApi {
  /** 호출 기록 — 화면에 그대로 보여 준다(최종 승인 전 submit 이 없는지 눈으로 확인) */
  readonly calls: string[];
  /** "증권사" 쪽 주문 건수(가상) */
  readonly placedCount: () => number;
}

export function createMockOrderApi(scenario: MockScenario, opts: MockOptions = {}): MockOrderApi {
  const delay = opts.delayMs ?? 400;
  const now = opts.now ?? (() => Date.now());
  const calls: string[] = [];
  let intent: IntentView | null = null;
  let placed = 0;
  let statusTicks = 0;
  let seq = 0;
  const wait = () => new Promise((r) => setTimeout(r, delay));
  const log = (s: string) => calls.push(`${new Date(now()).toLocaleTimeString("ko-KR")} ${s}`);

  const fresh = (): IntentView => ({
    id: `mock-intent-${++seq}`,
    state: "proposed",
    ticker: ORDER_TARGET.ticker,
    quantity: ORDER_TARGET.quantity,
    limitPrice: MOCK_PRICE,
    amount: MOCK_PRICE * ORDER_TARGET.quantity,
    side: "buy",
    ordDvsn: "00",
    accountInstanceId: MOCK_INSTANCE.id,
    attempt: seq,
    orderNo: null,
    orderTime: null,
    approvalExpiresAt: new Date(now() + 120_000).toISOString(),
    evidence: null,
    lastInquiryAt: null,
    ambiguous: false,
    lastError: null,
    executionConfirmed: false,
    ledgerEligible: false,
  });
  const set = (p: Partial<IntentView>) => { intent = { ...intent!, ...p }; return intent!; };
  const open = (i: IntentView | null) => !!i && ["submitting", "accepted", "unknown", "open", "partially_filled"].includes(i.state);

  return {
    calls,
    placedCount: () => placed,

    async prepare() {
      log("POST /api/kis/order/prepare (주문 아님)");
      await wait();
      if (scenario === "server_off") return { kind: "disabled" };
      if (open(intent)) return { kind: "existing", intent: intent! };
      intent = fresh();
      const confirm: ConfirmView = {
        ticker: intent.ticker, quantity: intent.quantity, limitPrice: intent.limitPrice,
        amount: intent.amount, accountInstanceId: intent.accountInstanceId,
      };
      return { kind: "prepared", intent, approvalToken: `mock-token-${seq}`, confirm };
    },

    async submit(id) {
      log("POST /api/kis/order/submit ← 주문 전송(가상)");
      await wait();
      if (!intent || intent.id !== id) return { kind: "not_sent", code: "not_found", message: "주문 의도를 찾지 못했습니다." };
      if (intent.state !== "proposed") return { kind: "already_processed", intent };
      if (scenario === "price_drift") {
        return { kind: "not_sent", code: "price_drift", message: "현재가가 승인한 가격에서 크게 벗어나 전송하지 않았습니다. 다시 준비해 주세요." };
      }
      placed += 1;
      if (scenario === "reject") {
        return { kind: "rejected", intent: set({ state: "rejected", lastError: "모의 거부: 주문가능금액 초과" }) };
      }
      if (scenario === "timeout_unknown" || scenario === "candidate_unknown") {
        set({ state: "unknown", lastError: "응답 시간 초과 — 접수 여부를 알 수 없습니다" });
        return { kind: "unknown", intent: null, transport: true };
      }
      return { kind: "accepted", intent: set({ state: "accepted", orderNo: "0000000101", orderNoSource: "broker_response", orderTime: "100501" }) };
    },

    async status(id) {
      log("GET /api/kis/order/status (주문 아님)");
      await wait();
      if (!intent || intent.id !== id) return { kind: "unavailable", message: "주문 의도를 찾지 못했습니다." };
      if (scenario === "accept_then_fill" && intent.orderNo) {
        statusTicks += 1;
        if (statusTicks === 1) set({ state: "open" });
        if (statusTicks >= 2) {
          set({
            state: "filled", executionConfirmed: true, ledgerEligible: true,
            evidence: { filledQty: 1, avgPrice: MOCK_PRICE, matchedBy: "order_no" },
          });
        }
      }
      if (scenario === "candidate_unknown" && intent.state === "unknown") {
        set({
          ambiguous: true, needsUserConfirmation: true,
          lastError: "주문번호를 확인하지 못했습니다. 조건이 같은 주문 후보 1건이 있으나 직접 매매일 수 있어 체결로 확정하지 않습니다 — 확인이 필요합니다",
        });
      }
      return { kind: "status", intent: intent!, inFlight: false, inquiryFailed: false };
    },

    async resolve(req) {
      log(`POST /api/kis/order/resolve (${req.action}, 주문 아님)`);
      await wait();
      if (!intent || intent.id !== req.intentId) return { kind: "refused", code: "not_found", message: "주문을 찾지 못했습니다.", intent: null };
      if (!["unknown", "submitting"].includes(intent.state) || intent.orderNo) {
        return { kind: "refused", code: "not_resolvable", message: "해소할 수 없는 상태입니다.", intent };
      }
      if (!opts.dayClosed?.()) {
        return { kind: "refused", code: "insufficient_evidence", message: "주문일 장이 끝난 뒤(다음 날부터)에만 수동 해소할 수 있습니다", intent };
      }
      if (req.action === "link_order_no") {
        const n = (req.orderNo ?? "").padStart(10, "0");
        if (n !== MOCK_LINKABLE_ORDER_NO) {
          return { kind: "refused", code: "insufficient_evidence", message: "증권사 조회에서 그 주문번호를 찾지 못했습니다", intent };
        }
        return {
          kind: "resolved",
          intent: set({
            state: "open", orderNo: n, orderNoSource: "user_linked", orderTime: "100502",
            ambiguous: true, needsUserConfirmation: true,
            lastError: "주문번호를 사용자가 연결했습니다 — 앱이 보낸 주문인지 증권사 기록만으로는 구별되지 않아 체결 확정·원장 근거로 쓰지 않습니다",
          }),
        };
      }
      if (scenario === "candidate_unknown") {
        return { kind: "refused", code: "insufficient_evidence", message: "조건이 같은 매수 주문이 1건 있습니다 — 미접수로 정리할 수 없습니다. 주문번호로 연결하세요", intent };
      }
      return {
        kind: "resolved",
        intent: set({
          state: "dismissed", ambiguous: false, needsUserConfirmation: false,
          lastError: "장 마감 후 체결조회에서 조건이 같은 주문이 없어 미접수로 정리했습니다(수동 해소)",
        }),
      };
    },
  };
}
