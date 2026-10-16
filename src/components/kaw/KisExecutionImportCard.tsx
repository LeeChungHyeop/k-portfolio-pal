import { usePortfolioStore } from "@/lib/kaw/store";
import { kstDateString } from "@/lib/kaw/snapshot";
import { requestKisExecutionPreview } from "@/lib/kaw/kis-execution-client";
import { KisExecutionImportPanel } from "@/components/kaw/KisExecutionImportPanel";
import type { AccountId } from "@/lib/kaw/constants";

/**
 * 연금저축 계좌 화면의 ‘한국투자 체결내역 가져오기’ (조회·미리보기 전용, Phase 4-B).
 * 연금저축(pension)에서만 그려지고, 다른 계좌에는 아무것도 그리지 않는다.
 * 실제 조회는 패널의 [조회] 버튼에서만 일어난다.
 */
export function KisExecutionImportCard({ accountId }: { accountId: AccountId }) {
  const { state } = usePortfolioStore();
  if (accountId !== "pension") return null;
  return (
    <KisExecutionImportPanel
      registry={state.brokerAccounts ?? []}
      today={kstDateString()}
      request={(range) => requestKisExecutionPreview(range)}
    />
  );
}
