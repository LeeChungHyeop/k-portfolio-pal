import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AccountId } from "@/lib/kaw/constants";
import { formatKRW, usePortfolioStore } from "@/lib/kaw/store";
import { kstDateString } from "@/lib/kaw/snapshot";
import {
  INITIAL_FLOW,
  ORDER_TARGET,
  ORDER_UI_ENV_KEY,
  describeOrder,
  flowReducer,
  lastIntentKey,
  orderUiGate,
  requestPrepare,
  requestStatus,
  requestSubmit,
  secondsLeft,
  verifyPrepared,
  type FlowEvent,
  type FlowState,
  type Tone,
} from "@/lib/kaw/order-client";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-muted/40",
  info: "border-sky-500/40 bg-sky-500/10",
  warn: "border-amber-500/50 bg-amber-500/10",
  danger: "border-rose-500/50 bg-rose-500/10",
  success: "border-emerald-500/50 bg-emerald-500/10",
};

function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, v: string) {
  try { window.localStorage.setItem(key, v); } catch { /* 저장 못 해도 서버 의도는 남는다 */ }
}

/**
 * KIS 연금저축(22) 승인형 주문 — **TIGER 미국S&P500(360750) 1주 지정가** 하나만.
 *
 *   1 준비   서버가 현재가·매수가능금액을 확인하고 주문 의도와 1회성 승인 토큰을 만든다(주문 아님)
 *   2 확인   계좌·종목·수량·가격·금액을 사용자가 읽고 확인한다(주문 아님)
 *   3 최종 승인   이 단계의 버튼만 주문을 전송한다
 *
 * 입력 필드가 없다. 기본 OFF(빌드 flag), 연금저축·API 모드가 아니면 아무 것도 그리지 않는다.
 * 응답을 못 받으면 "불명"이며 이 컴포넌트는 어떤 경우에도 자동으로 다시 주문하지 않는다.
 */
export function OrderApprovalCard({ accountId }: { accountId: AccountId }) {
  const { state: store } = usePortfolioStore();
  const today = kstDateString();
  const uiFlag = (import.meta.env as Record<string, unknown>)[ORDER_UI_ENV_KEY];
  const gate = useMemo(
    () => orderUiGate(accountId === "pension" ? (store.brokerAccounts ?? []) : [], today, uiFlag),
    [accountId, store.brokerAccounts, today, uiFlag],
  );
  const instance = gate.visible ? gate.instance : null;

  const [flow, setFlow] = useState<FlowState>(INITIAL_FLOW);
  const flowRef = useRef<FlowState>(INITIAL_FLOW);
  const [now, setNow] = useState(() => Date.now());
  const [ack, setAck] = useState({ details: false, unsupported: false });
  const [storedId, setStoredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 상태기계를 거친다. 상태가 안 바뀌면(중복 클릭·재진입) false — 호출부는 아무 것도 보내지 않는다. */
  const apply = useCallback((ev: FlowEvent): boolean => {
    const next = flowReducer(flowRef.current, ev);
    if (next === flowRef.current) return false;
    flowRef.current = next;
    setFlow(next);
    return true;
  }, []);

  const instanceId = instance?.id ?? null;
  useEffect(() => {
    setStoredId(instanceId ? readStored(lastIntentKey(instanceId)) : null);
  }, [instanceId]);

  // 승인 기한 카운트다운 — 확인/최종 승인 단계에서만 돈다.
  useEffect(() => {
    if (flow.phase !== "review" && flow.phase !== "final") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [flow.phase]);
  useEffect(() => {
    if ((flow.phase === "review" || flow.phase === "final") && flow.intent
        && secondsLeft(flow.intent.approvalExpiresAt, now) <= 0) {
      apply({ type: "expired" });
      setAck({ details: false, unsupported: false });
    }
  }, [flow.phase, flow.intent, now, apply]);

  const remember = useCallback((id: string) => {
    if (!instanceId) return;
    writeStored(lastIntentKey(instanceId), id);
    setStoredId(id);
  }, [instanceId]);

  if (!gate.visible || !instance) return null;

  // ── 1단계: 준비 ──────────────────────────────────────────────────────────
  const onPrepare = async () => {
    if (!apply({ type: "start_prepare" })) return;
    setBusy(true);
    setAck({ details: false, unsupported: false });
    try {
      const r = await requestPrepare();
      if (r.kind === "prepared") {
        const v = verifyPrepared(r.intent, r.confirm, instance.id);
        if (!v.ok) { apply({ type: "failed", message: `${v.reason} 주문을 진행하지 않았습니다.` }); return; }
        remember(r.intent.id);
        apply({ type: "prepared", intent: r.intent, token: r.approvalToken, confirm: r.confirm });
      } else if (r.kind === "existing") {
        remember(r.intent.id);
        apply({ type: "existing", intent: r.intent });
      } else if (r.kind === "disabled") {
        apply({ type: "failed", message: "서버의 주문 기능이 꺼져 있습니다." });
      } else if (r.kind === "denied") {
        apply({ type: "failed", message: "이 프로필에는 주문 권한이 없습니다." });
      } else if (r.kind === "unauthenticated") {
        apply({ type: "failed", message: "로그인이 만료됐습니다. 다시 로그인해 주세요." });
      } else {
        apply({ type: "failed", message: r.message });
      }
    } finally {
      setBusy(false);
    }
  };

  // ── 3단계: 최종 승인 — 주문 POST 는 여기서만 ─────────────────────────────
  const onSubmit = async () => {
    if (!ack.details || !ack.unsupported) return;
    if (!apply({ type: "begin_submit" })) return; // 중복 클릭·단계 위반이면 여기서 끝
    const cur = flowRef.current;
    if (!cur.intent || !cur.token || !cur.confirm) return;
    setBusy(true);
    try {
      const r = await requestSubmit(cur.intent.id, cur.token, cur.confirm);
      if (r.kind === "accepted" || r.kind === "rejected") {
        apply({ type: "submitted", intent: r.intent });
      } else if (r.kind === "unknown") {
        apply({ type: "submit_lost", intent: r.intent });
      } else if (r.kind === "already_processed") {
        // 이미 처리된 의도다 — 새 주문은 나가지 않았다. 상태 조회로 이어간다.
        apply({ type: "submit_lost", intent: r.intent });
      } else if (r.kind === "expired") {
        apply({ type: "not_sent", message: "승인 기한이 지나 전송되지 않았습니다." });
      } else if (r.kind === "not_sent") {
        apply({ type: "not_sent", message: r.message });
      } else if (r.kind === "disabled") {
        apply({ type: "not_sent", message: "서버의 주문 기능이 꺼져 있어 전송되지 않았습니다." });
      } else if (r.kind === "denied") {
        apply({ type: "not_sent", message: "주문 권한이 없어 전송되지 않았습니다." });
      } else {
        apply({ type: "not_sent", message: "로그인이 만료돼 전송되지 않았습니다." });
      }
    } finally {
      setBusy(false);
      setAck({ details: false, unsupported: false });
    }
  };

  // ── 상태 조회 (주문 아님) ────────────────────────────────────────────────
  const onInquire = async () => {
    const id = flowRef.current.intent?.id ?? storedId;
    if (!id || busy) return;
    setBusy(true);
    try {
      const r = await requestStatus(id);
      if (r.kind === "status") {
        if (flowRef.current.phase === "idle") apply({ type: "resumed", intent: r.intent });
        else apply({ type: "status", intent: r.intent });
      } else if (r.kind === "unavailable") {
        apply({ type: "failed", message: r.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const view = flow.intent ? describeOrder(flow.intent) : null;
  const left = flow.intent ? secondsLeft(flow.intent.approvalExpiresAt, now) : 0;
  const i = flow.intent;
  const step = flow.phase === "review" ? 2 : flow.phase === "final" ? 3 : 1;

  return (
    <Card className="p-3 sm:p-4 space-y-3" data-testid="order-approval-card">
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold break-words">승인형 주문 · 연금저축 {ORDER_TARGET.ticker} 1주</h3>
          <p className="text-xs text-muted-foreground break-words">
            {ORDER_TARGET.tickerName} · 지정가 · 매수 1주. 최종 승인 전에는 주문이 전송되지 않습니다.
          </p>
        </div>
      </div>

      {(flow.phase === "idle" || flow.phase === "preparing" || flow.phase === "review" || flow.phase === "final") && (
        <ol className="flex gap-1 text-[11px]" aria-label="주문 단계">
          {["준비", "내용 확인", "최종 승인"].map((t, n) => (
            <li key={t}
              className={`flex-1 rounded px-2 py-1 text-center border ${step === n + 1 ? "border-primary font-semibold" : "border-border text-muted-foreground"}`}>
              {n + 1}. {t}
            </li>
          ))}
        </ol>
      )}

      {flow.message && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs flex gap-2" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="break-words">{flow.message}</span>
        </div>
      )}

      {/* 1 준비 */}
      {(flow.phase === "idle" || flow.phase === "preparing" || flow.phase === "error") && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground break-words">
            준비 단계에서는 서버가 현재가와 매수가능금액을 확인하고 주문 내용을 만듭니다. 이때 주문은 전송되지 않습니다.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="w-full sm:w-auto min-h-11" disabled={busy || flow.phase === "preparing"} onClick={onPrepare}>
              {flow.phase === "preparing" ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />준비 중…</> : "주문 준비"}
            </Button>
            {storedId && flow.phase !== "preparing" && (
              <Button variant="outline" className="w-full sm:w-auto min-h-11" disabled={busy} onClick={onInquire}>
                이전 주문 상태 조회
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 2 내용 확인 / 3 최종 승인: 같은 내용을 계속 보여준다 */}
      {(flow.phase === "review" || flow.phase === "final" || flow.phase === "sending") && i && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm" data-testid="order-details">
            <dt className="text-muted-foreground">계좌</dt>
            <dd className="break-words">{instance.label} · 상품코드 {instance.productCode}</dd>
            <dt className="text-muted-foreground">종목</dt>
            <dd className="break-words">{ORDER_TARGET.tickerName} ({i.ticker})</dd>
            <dt className="text-muted-foreground">구분</dt>
            <dd>매수 · 지정가</dd>
            <dt className="text-muted-foreground">수량</dt>
            <dd>{i.quantity}주</dd>
            <dt className="text-muted-foreground">지정가</dt>
            <dd>{formatKRW(i.limitPrice)}</dd>
            <dt className="text-muted-foreground">주문금액</dt>
            <dd className="font-semibold">{formatKRW(i.amount)}</dd>
            <dt className="text-muted-foreground">승인 기한</dt>
            <dd>{flow.phase === "sending" ? "전송 중" : `${left}초 남음`}</dd>
          </dl>

          {flow.phase === "review" && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className="w-full sm:w-auto min-h-11" onClick={() => apply({ type: "acknowledge" })}>
                내용을 확인했습니다
              </Button>
              <Button variant="outline" className="w-full sm:w-auto min-h-11"
                onClick={() => { apply({ type: "back" }); setAck({ details: false, unsupported: false }); }}>
                취소
              </Button>
            </div>
          )}

          {flow.phase === "final" && (
            <div className="space-y-2">
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs break-words">
                연금저축(22)의 주문 API 지원은 공식 문서로 확인되지 않았습니다. 이 주문이 첫 시도이며,
                응답이 없으면 접수 여부를 알 수 없습니다. 그 경우 다시 주문하지 말고 상태를 조회하세요.
              </div>
              <label className="flex items-start gap-2 text-xs min-h-11">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack.details}
                  onChange={(e) => setAck((a) => ({ ...a, details: e.target.checked }))} />
                <span className="break-words">위 계좌·종목·수량·지정가·금액이 맞습니다.</span>
              </label>
              <label className="flex items-start gap-2 text-xs min-h-11">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack.unsupported}
                  onChange={(e) => setAck((a) => ({ ...a, unsupported: e.target.checked }))} />
                <span className="break-words">지원 미확인 계좌의 첫 주문이며, 실제 매수 주문이 전송됨을 이해합니다.</span>
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="destructive" className="w-full sm:w-auto min-h-11"
                  disabled={busy || !ack.details || !ack.unsupported} onClick={onSubmit}>
                  최종 승인하고 주문 전송
                </Button>
                <Button variant="outline" className="w-full sm:w-auto min-h-11" disabled={busy}
                  onClick={() => { apply({ type: "back" }); setAck({ details: false, unsupported: false }); }}>
                  취소
                </Button>
              </div>
            </div>
          )}

          {flow.phase === "sending" && (
            <div className="flex items-center gap-2 text-sm" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>주문을 전송하고 있습니다. 화면을 닫거나 다시 누르지 마세요.</span>
            </div>
          )}
        </div>
      )}

      {/* 결과 */}
      {flow.phase === "done" && i && view && (
        <div className="space-y-2">
          <div className={`rounded-md border p-3 ${TONE_CLASS[view.tone]}`} data-testid="order-result">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {view.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              <span data-testid="order-state-label">{view.label}</span>
            </div>
            <p className="mt-1 text-sm break-words">{view.headline}</p>
            <p className="mt-1 text-xs text-muted-foreground break-words">{view.detail}</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {i.ticker} · {i.quantity}주 · {formatKRW(i.limitPrice)} · {formatKRW(i.amount)}
              {i.orderNo ? ` · 주문번호 ${i.orderNo}` : " · 주문번호 없음"}
            </p>
            {i.lastError && i.state !== "rejected" && (
              <p className="mt-1 text-xs break-words">{i.lastError}</p>
            )}
          </div>
          {flow.message && <p className="text-xs break-words">{flow.message}</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            {(view.canInquire || flow.lost) && (
              <Button variant="outline" className="w-full sm:w-auto min-h-11" disabled={busy} onClick={onInquire}>
                {busy ? "조회 중…" : "상태 조회"}
              </Button>
            )}
            {view.canPrepareAgain && !flow.lost && (
              <Button variant="outline" className="w-full sm:w-auto min-h-11" onClick={() => apply({ type: "reset" })}>
                새 주문 준비로 돌아가기
              </Button>
            )}
          </div>
          {!view.canPrepareAgain && (
            <p className="text-[11px] text-muted-foreground break-words">
              이 주문이 정리되기 전에는 새 주문을 준비할 수 없습니다. 상태 조회는 주문을 전송하지 않습니다.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
