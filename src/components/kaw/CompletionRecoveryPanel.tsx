import { useCallback, useEffect, useState } from "react";
import { CloudOff, RefreshCw, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  defaultRecoveryDeps,
  describeCompletion,
  dismissSettled,
  isCompletionBusy,
  listCompletions,
  retryCompletion,
  subscribeOutbox,
  type CompletionView,
  type SideView,
} from "@/lib/kaw/completion-recovery";
import type { SessionContext } from "@/lib/kaw/rebalance-session";
import { getRevisionProtectionStatus, noteServerRevision } from "@/lib/kaw/store";

/**
 * 미완료 리밸런싱 저장 복구 패널.
 *
 * **사용자가 누를 때만 움직인다.** 마운트·타이머·포커스 복귀 어디서도 서버를 호출하지
 * 않는다 — 목록은 localStorage 의 outbox 를 읽어 그릴 뿐이다.
 *
 * 문구의 선: "서버가 수신함"까지만 말한다. 저장이 끝났다·확정됐다·보존됐다고 쓰지 않고,
 * 서버 확인에 실패한 것을 "저장 안 됨"이라고 쓰지 않는다.
 */

const TONE: Record<SideView["status"], string> = {
  received: "text-emerald-600 dark:text-emerald-400",
  rejected: "text-rose-600 dark:text-rose-400",
  unverified: "text-amber-600 dark:text-amber-400",
  waiting: "text-muted-foreground",
};

function Side({ title, view }: { title: string; view: SideView }) {
  return (
    <div className="text-xs leading-snug">
      <span className="text-muted-foreground">{title}</span>{" "}
      <span className={`font-medium ${TONE[view.status]}`}>{view.label}</span>
      {view.detail && <p className="mt-0.5 text-muted-foreground break-words">{view.detail}</p>}
    </div>
  );
}

interface Props {
  ctx: SessionContext;
  /** 지금 화면의 mirror 가 들고 있는 completionId. 정리 시 같은 것만 지운다 */
  mirrorCompletionId: string | null;
  onClearMirror: () => void;
}

export function CompletionRecoveryPanel({ ctx, mirrorCompletionId, onClearMirror }: Props) {
  const read = useCallback(() => listCompletions(ctx), [ctx]);
  const [lists, setLists] = useState(read);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 쓰는 쪽이 끝났을 때만 다시 읽는다. 타이머 폴링을 두지 않는다.
  useEffect(() => {
    setLists(read());
    return subscribeOutbox(() => setLists(read()));
  }, [read]);

  if (lists.pending.length === 0 && lists.settled.length === 0) return null;

  // 정리 허용 여부. **서버 revision 보호가 검증되지 않았으면 ACK 가 있어도 막는다** —
  // 그 기록은 무가드 문서 교체에 덮일 수 있고 envelope 이 유일한 재전송 수단이다.
  const protection = getRevisionProtectionStatus();

  async function retry(v: CompletionView) {
    // 모듈 잠금이 진짜 차단이다. state 는 표시용이다.
    if (retrying || isCompletionBusy(ctx, v.completionId)) return;
    setRetrying(v.completionId);
    setMessage(null);
    try {
      const r = await retryCompletion(ctx, v.completionId, {
        ...defaultRecoveryDeps,
        // 병합이 올린 revision 을 가드 표에 반영한다(자기 자신 때문에 409 가 되지 않게).
        onHistoryRevision: noteServerRevision,
      });
      if (r.kind === "busy") setMessage("이미 전송 중입니다.");
      else if (r.kind === "nothing_to_do") setMessage("보낼 항목이 없습니다 (이미 서버가 수신함).");
      else if (r.kind === "not_found") setMessage("이 기기에서 해당 완료 기록을 찾지 못했습니다.");
      else if (r.kind === "disabled") setMessage("세션 추적이 꺼져 있어 보내지 않았습니다.");
      else if (r.view.settled) setMessage("계획과 기록을 서버가 수신했습니다 (최종 보존 보장은 아님).");
      else setMessage("아직 확인되지 않은 항목이 남아 있습니다. 사유를 확인해 주세요.");
    } finally {
      setRetrying(null);
      setLists(read());
    }
  }

  function dismiss(v: CompletionView) {
    // 게이트를 **누르는 순간 다시 판정**한다 — 화면이 그려진 뒤 상태가 바뀌었을 수 있다.
    const protection = getRevisionProtectionStatus();
    const r = dismissSettled(ctx, v.completionId, {
      allowed: protection.verified,
      reason: protection.reason,
    });
    setConfirming(null);
    if (r.kind === "blocked") {
      setMessage(`정리하지 않았습니다. ${r.reason}`);
    } else if (r.kind === "cleaned") {
      // journal 은 그 completionId 일 때만 지워졌다(새 세션의 PRE 는 그대로). mirror 도
      // **같은 completionId 일 때만** 걷는다.
      if (mirrorCompletionId === v.completionId) onClearMirror();
      setMessage("정리했습니다. 이 완료의 재전송 수단은 이 기기에서 사라졌습니다.");
    } else if (r.kind === "busy") {
      setMessage("전송 중에는 정리할 수 없습니다.");
    } else {
      setMessage("정리하지 않았습니다 (서버 수신이 양쪽 확인되지 않았거나 저장에 실패했습니다).");
    }
    setLists(read());
  }

  return (
    <Card className="p-4 space-y-3 border-amber-500/40 bg-amber-500/5">
      {lists.pending.length > 0 && (
        <div className="flex items-start gap-2">
          <CloudOff className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">서버 저장이 확인되지 않은 리밸런싱 {lists.pending.length}건</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              이 기기에는 기록이 남아 있습니다. 서버 확인에 실패한 것은 저장되지 않았다는 뜻이
              아닙니다 — 이 기기에 보관된 내용 그대로 다시 보내면 중복 없이 처리됩니다.
            </p>
          </div>
        </div>
      )}

      {lists.pending.map((v) => {
        const busy = retrying === v.completionId || isCompletionBusy(ctx, v.completionId);
        return (
          <div key={v.completionId} className="rounded-lg border bg-background/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{v.createdAt.slice(0, 16).replace("T", " ")}</span>
              <span>시도 {v.attempts}회</span>
            </div>
            <Side title="기록(History)" view={v.history} />
            <Side title="계획(Plan)" view={v.plan} />
            <p className="text-xs text-muted-foreground">{v.note}</p>
            <Button
              size="sm"
              variant={v.manualRetryRequired ? "default" : "outline"}
              disabled={busy || v.retrySides.length === 0}
              onClick={() => void retry(v)}
              className="w-full"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${busy ? "animate-spin" : ""}`} />
              {busy
                ? "보내는 중…"
                : v.manualRetryRequired
                  ? "사유를 확인했습니다 — 다시 보내기"
                  : "저장된 내용 그대로 다시 보내기"}
            </Button>
          </div>
        );
      })}

      {lists.settled.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              서버가 계획과 기록을 수신한 완료 {lists.settled.length}건. 수신 확인이며 최종 보존을
              보장하지는 않으므로 자동으로 지우지 않습니다. 정리하면 이 기기의 재전송 수단이
              사라집니다.
            </p>
          </div>
          {lists.settled.map((v) => (
            <div key={v.completionId} className="rounded-lg border bg-background/60 p-3 space-y-2">
              <div className="text-xs text-muted-foreground tabular-nums">
                {v.createdAt.slice(0, 16).replace("T", " ")}
              </div>
              {!protection.verified ? (
                <div className="space-y-1.5">
                  <Button size="sm" variant="outline" className="w-full" disabled>
                    정리 불가 — 서버 보존 미확인
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {protection.reason} 서버 수신은 확인됐지만 최종 보존이 확인될 때까지
                    이 기기의 재전송용 기록을 지우지 않습니다.
                  </p>
                </div>
              ) : confirming === v.completionId ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-rose-600 dark:text-rose-400">
                    이 기기에 보관된 재전송용 기록이 삭제됩니다. 계속할까요?
                  </p>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirming(null)}>
                      취소
                    </Button>
                    <Button size="sm" className="flex-1" onClick={() => dismiss(v)}>
                      정리
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="w-full" onClick={() => setConfirming(v.completionId)}>
                  이 완료 기록 정리
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
    </Card>
  );
}

// 표시 모델을 재노출한다 — 화면 테스트가 같은 판정을 쓰도록.
export { describeCompletion };
