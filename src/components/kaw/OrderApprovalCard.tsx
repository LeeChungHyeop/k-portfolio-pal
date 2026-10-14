import { useMemo } from "react";
import type { AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore } from "@/lib/kaw/store";
import { kstDateString } from "@/lib/kaw/snapshot";
import { LIVE_ORDER_API, ORDER_TARGET, orderUiGate } from "@/lib/kaw/order-client";
import { BROWSER_INTENT_STORAGE, OrderApprovalPanel } from "@/components/kaw/OrderApprovalPanel";

/**
 * 운영 화면용 감싸개. **기본 OFF**(빌드 flag `VITE_KAW_KIS_ORDER_UI === "on"`), 연금저축(22)·
 * API 모드·등록된 active 계좌가 아니면 아무 것도 그리지 않는다. 본체는 OrderApprovalPanel 이다.
 */
export function OrderApprovalCard({ accountId }: { accountId: AccountId }) {
  const { state: store } = usePortfolioStore();
  const today = kstDateString();
  // 정적 접근(이름 그대로) — 객체째 읽으면 .env 의 모든 VITE_* 가 번들에 들어간다.
  const uiFlag: unknown = import.meta.env.VITE_KAW_KIS_ORDER_UI;
  const gate = useMemo(
    () => orderUiGate(accountId === "pension" ? (store.brokerAccounts ?? []) : [], today, uiFlag),
    [accountId, store.brokerAccounts, today, uiFlag],
  );
  if (!gate.visible) return null;
  // 게이트가 상품코드 22 일치를 이미 확인했다.
  const { id, label } = gate.instance;
  const productCode = gate.instance.productCode ?? ORDER_TARGET.productCode;
  return (
    <OrderApprovalPanel
      key={id}
      instance={{ id, label, productCode }}
      api={LIVE_ORDER_API}
      storage={BROWSER_INTENT_STORAGE}
    />
  );
}
