import { useState } from "react";
import { usePortfolioStore } from "@/lib/kaw/store";
import { kstDateString } from "@/lib/kaw/snapshot";
import { requestKisExecutionPreview, type ExecRequestOutcome } from "@/lib/kaw/kis-execution-client";
import { requestBalanceObserve, requestTransferConfirm, requestTransferState } from "@/lib/kaw/kis-transfer-client";
import { requestKisLedgerApply } from "@/lib/kaw/kis-ledger-apply-client";
import { requestSyncApply, requestSyncPreview } from "@/lib/kaw/kis-sync-client";
import { asBrokerSyncs } from "@/lib/kaw/broker-sync-basis";
import { KisExecutionImportPanel } from "@/components/kaw/KisExecutionImportPanel";
import { AccountTransferPanel } from "@/components/kaw/AccountTransferPanel";
import { BrokerSyncPanel } from "@/components/kaw/BrokerSyncPanel";
import type { AccountId } from "@/lib/kaw/constants";

/**
 * 연금저축 계좌 화면의 ‘한국투자 체결내역 가져오기’(조회·미리보기 전용, Phase 4-B)와
 * ‘계좌 이전 확정 · 잔고 관측’(승인 시에만 기록, Phase 4-C-1),
 * ‘계좌 상태 동기화’(보유수량·예수금을 증권사 확인값으로 맞춤, 승인 시에만 기록, Phase 4-D).
 * 연금저축(pension)에서만 그려지고, 다른 계좌에는 아무것도 그리지 않는다.
 * 체결 조회는 패널의 [조회] 버튼에서만 일어난다. 이전 패널의 상태 조회는 DB 만 읽는다(KIS 호출 없음).
 */
export function KisExecutionImportCard({ accountId }: { accountId: AccountId }) {
  const { state, reloadFromServer } = usePortfolioStore();
  // 이전 대사에 쓰는 한국투자 체결 매수 합계 — 조회가 끝까지 완료됐을 때만 채운다. 어디에도 저장하지 않는다.
  const [kisBuyAmount, setKisBuyAmount] = useState<number | null>(null);
  if (accountId !== "pension") return null;

  const onResult = (o: ExecRequestOutcome) => {
    setKisBuyAmount(
      o.kind === "response" && o.data.state === "ok" && o.data.query.complete && o.data.totals.unreadableRows === 0
        ? o.data.totals.executed.buyAmount
        : null,
    );
  };

  return (
    <div className="space-y-3">
      <KisExecutionImportPanel
        registry={state.brokerAccounts ?? []}
        today={kstDateString()}
        request={(range) => requestKisExecutionPreview(range)}
        onResult={onResult}
        onApply={(req) => requestKisLedgerApply(req)}
      />
      <AccountTransferPanel
        loadState={() => requestTransferState()}
        observe={() => requestBalanceObserve()}
        confirm={(p) => requestTransferConfirm(p)}
        kisBuyAmount={kisBuyAmount}
      />
      <BrokerSyncPanel
        syncs={asBrokerSyncs(state.accounts.pension?.brokerSyncs)}
        preview={(req) => requestSyncPreview(req)}
        apply={(req) => requestSyncApply(req)}
        onApplied={() => reloadFromServer()}
      />
    </div>
  );
}
