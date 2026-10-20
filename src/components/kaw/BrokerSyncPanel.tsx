import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrokerSyncRecord } from "@/lib/kaw/broker-sync-basis";
import type { SyncApplyOutcome, SyncPreviewData, SyncPreviewOutcome } from "@/lib/kaw/kis-sync-client";

/**
 * 계좌 상태 동기화 (Phase 4-D) — 앱의 현재 보유수량·예수금을 증권사 확인값으로 맞춘다.
 *
 * 리밸런싱이 아니다. 거래·입금·수익률 이벤트를 만들지 않고, 누적 납입원금·기준금액·이력·기존 일별 스냅샷은 바뀌지 않는다.
 * 날짜를 섞어 보이지 않는다:
 *   · 보유수량 효력일 = 한국투자 매수 체결일(원장 마지막 날)
 *   · 예수금 = 증권사 관측값(관측 기준일 · 관측 시각). 효력일이 없다 — 그 날의 잔고로 보이게 하지 않는다
 *   · 승인 시각 = 반영한 순간
 * 증권사 잔고를 지금 읽지 못하면 저장된 관측(기준일 표시)으로 내려가며, 그것을 쓰려면 별도 승인이 필요하다.
 */

const won = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const kst = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") + " KST" : "-");

const REJECT_TEXT: Record<string, string> = {
  plan_changed: "승인한 뒤 잔고·원장·수량이 바뀌어 반영하지 않았습니다. 다시 확인해 새 계획을 보세요.",
  already_synced: "같은 상태의 동기화가 이미 기록돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.",
  busy: "같은 요청이 처리 중입니다. 잠시 후 다시 확인하세요.",
  sync_disabled: "계좌 동기화 기능이 서버에서 켜져 있지 않습니다.",
  not_eligible: "반영 조건을 만족하지 않아 반영하지 않았습니다.",
  revision_conflict: "그 사이 계좌 데이터가 다른 기기에서 바뀌어 반영하지 않았습니다. 새로 고친 뒤 다시 확인하세요.",
};
const OUTCOME_TEXT: Record<string, string> = {
  unavailable: "DB 반영 함수(migration 013)가 아직 적용되지 않아 반영할 수 없습니다.",
  not_configured: "서버에 한국투자 계좌 설정이 없어 반영할 수 없습니다.",
  forbidden: "이 프로필에는 한국투자 계좌 권한이 없습니다.",
  unauthorized: "로그인이 만료됐습니다. 다시 로그인한 뒤 확인하세요.",
  server_error: "서버 오류입니다. 반영 여부가 불확실하니 화면을 새로 고쳐 현재 상태를 확인하세요.",
  network_error: "네트워크 문제입니다. 반영 여부가 불확실하니 화면을 새로 고쳐 현재 상태를 확인하세요.",
  timeout: "응답 시간이 초과됐습니다. 반영 여부가 불확실하니 화면을 새로 고쳐 현재 상태를 확인하세요.",
};
const FAILURE_TEXT: Record<string, string> = {
  auth_or_transport: "증권사 잔고를 지금 읽지 못했습니다(인증/통신 오류).",
  not_configured: "서버에 한국투자 계좌 설정이 없습니다.",
  gate_blocked: "계좌 상태 때문에 조회가 허용되지 않았습니다.",
  balance_incomplete: "증권사 응답에서 보유/예수금을 모두 얻지 못했습니다.",
  no_observation: "저장된 관측도 없습니다.",
};

export interface BrokerSyncPanelProps {
  /** 현재 계좌 문서에 있는 동기화 기록(읽기 전용 목록) */
  syncs: readonly BrokerSyncRecord[];
  preview: (req: { live: boolean; staleObservationApproved?: boolean }) => Promise<SyncPreviewOutcome>;
  apply: (req: { planHash: string; staleObservationApproved?: boolean }) => Promise<SyncApplyOutcome>;
  /** 반영 성공 뒤 서버 상태를 다시 불러온다(로컬이 옛 문서를 들고 있으면 안 된다) */
  onApplied?: () => Promise<unknown> | void;
}

export function BrokerSyncPanel({ syncs, preview, apply, onApplied }: BrokerSyncPanelProps) {
  const [data, setData] = useState<SyncPreviewData | null>(null);
  const [staleOk, setStaleOk] = useState(false);
  const [approved, setApproved] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const busy = useRef(false);

  const plan = data?.plan ?? null;
  const stale = !!data?.needsStaleApproval;
  const canApply = !!data && data.enabled && !!plan && approved && !working && !done && (!stale || staleOk);

  async function check(live: boolean, staleApproved: boolean) {
    if (busy.current) return;
    busy.current = true; setWorking(true); setMsg(null); setApproved(false);
    try {
      const o = await preview({ live, staleObservationApproved: staleApproved });
      if (o.kind === "ok") { setData(o.data); } else { setData(null); setMsg({ tone: "error", text: OUTCOME_TEXT[o.kind] ?? "확인하지 못했습니다." }); }
    } finally { busy.current = false; setWorking(false); }
  }

  async function run() {
    if (!canApply || busy.current || !plan) return;
    busy.current = true; setWorking(true); setMsg(null);
    try {
      // 실패해도 다시 시도하지 않는다. 승인은 한 번의 요청에만 쓰인다.
      const o = await apply({ planHash: plan.planHash, staleObservationApproved: stale && staleOk });
      setApproved(false);
      if (o.kind === "applied") {
        setDone(true);
        setMsg({ tone: "ok", text: "동기화했습니다. 보유수량·예수금과 승인 감사가 한 번에 기록됐고 누적 납입원금·기준금액·이력·기존 스냅샷은 바뀌지 않았습니다. 서버 상태를 다시 불러옵니다." });
        await onApplied?.();
      } else if (o.kind === "rejected") {
        setMsg({ tone: o.code === "already_synced" ? "warn" : "error", text: `반영하지 않았습니다 — ${REJECT_TEXT[o.code] ?? o.message}` });
        if (o.plan) setData((d) => (d ? { ...d, plan: o.plan ?? d.plan, ...(o.blockers ? { blockers: o.blockers } : {}), ...(o.balance ? { balance: o.balance } : {}) } : d));
      } else {
        setMsg({ tone: "error", text: `반영하지 않았습니다 — ${OUTCOME_TEXT[o.kind] ?? "알 수 없는 오류입니다."}` });
      }
    } finally { busy.current = false; setWorking(false); }
  }

  const b = data?.balance;
  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid="sync-panel">
      <p className="text-sm font-semibold">계좌 상태 동기화</p>
      <p className="text-xs text-muted-foreground">
        앱의 현재 보유수량·예수금을 증권사 확인값으로 맞춥니다. 리밸런싱이 아니며 거래·입금·수익률을 만들지 않습니다.
        기존 일별 스냅샷과 이전 이력은 고치지 않습니다.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={working} onClick={() => check(true, false)} data-testid="sync-check-live">
          {working && !data ? "확인 중…" : "증권사 잔고 읽고 확인 (1회)"}
        </Button>
        <Button size="sm" variant="ghost" disabled={working} onClick={() => check(false, staleOk)} data-testid="sync-check-stored">
          저장된 관측으로 확인 (증권사 호출 없음)
        </Button>
      </div>

      {data && b && (
        <div className="space-y-2" data-testid="sync-result">
          <p className="text-xs" data-testid="sync-balance-source">
            잔고 출처: <b>{b.source === "kis_live_read" ? "방금 증권사에서 읽음" : b.source === "stored_observation" ? "저장된 관측" : "없음"}</b>
            {b.stateAsOf && <> · 기준일 <b className="tabular-nums">{b.stateAsOf}</b> · 관측 시각 {kst(b.observedAt)}</>}
            {b.liveAttempted && b.failure && <span className="block text-amber-700 dark:text-amber-300">{FAILURE_TEXT[b.failure] ?? "증권사 잔고를 읽지 못했습니다."} 자동으로 다시 시도하지 않았습니다.</span>}
          </p>

          {stale && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs space-y-1.5" data-testid="sync-stale">
              <p className="flex gap-1.5 text-amber-700 dark:text-amber-300"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>이 잔고는 <b>오늘({data.today})이 아닌 {b.stateAsOf} 기준</b>입니다. 현재 시점의 잔고가 아닙니다. 쓰려면 아래에서 별도로 승인하세요.</span></p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={staleOk} onChange={(e) => { setStaleOk(e.target.checked); setApproved(false); }} data-testid="sync-stale-approve" className="mt-0.5" />
                <span>{b.stateAsOf} 기준의 오래된 관측을 사용하는 것을 별도로 승인합니다(기록에 ‘오래된 관측 사용’으로 남습니다).</span>
              </label>
              {staleOk && !plan?.cash.fresh && (
                <Button size="sm" variant="outline" disabled={working} onClick={() => check(false, true)} data-testid="sync-recheck-stale">승인 반영해 다시 확인</Button>
              )}
            </div>
          )}

          {plan && (
            <div className="space-y-1.5 text-xs" data-testid="sync-plan">
              <ul className="space-y-1" data-testid="sync-rows">
                {plan.rows.map((r) => (
                  <li key={r.rowId} className="rounded-md border p-2" data-testid="sync-row">
                    <span className="font-medium">{r.etfName}</span> <span className="text-muted-foreground">{r.ticker ?? "코드 없음"}</span>
                    <span className="block tabular-nums">{r.quantityBefore.toLocaleString("ko-KR")}주 → <b>{r.quantityAfter.toLocaleString("ko-KR")}주</b></span>
                  </li>
                ))}
              </ul>
              <p data-testid="sync-dates">
                보유수량 효력일 <b className="tabular-nums">{plan.holdingsEffectiveFrom}</b> <span className="text-muted-foreground">(한국투자 매수 체결일 · 원장 마지막 날)</span>
              </p>
              <p data-testid="sync-cash">
                예수금 {won(plan.cash.before)} → <b className="tabular-nums">{won(plan.cash.after)}</b>
                <span className="block text-muted-foreground">증권사 관측값(기준일 {plan.cash.stateAsOf}, {plan.cash.fresh ? "오늘 기준" : "오래된 관측"}). {plan.holdingsEffectiveFrom} 의 잔고가 아닙니다 — 효력일 없이 ‘관측값’으로만 기록합니다.</span>
              </p>
              <p>누적 납입원금 <b className="tabular-nums" data-testid="sync-principal">{won(plan.principal.amount)}</b> <span className="text-muted-foreground">— 변동 없음 · 이전금액({won(plan.transfer.amount)})을 입금으로 만들지 않습니다</span></p>
              <p className="text-muted-foreground">변경되지 않는 것: 이력 {plan.untouched.historyCount}건 · 현금흐름 {plan.untouched.cashflowCount}건 · 기준금액 {won(plan.untouched.baseAmount)}</p>

              {plan.reconciliation && (
                <div className="space-y-0.5" data-testid="sync-recon">
                  {plan.reconciliation.lines.map((l) => (
                    <p key={l.id}>{l.label}: <b className="tabular-nums">{l.difference > 0 ? "+" : l.difference < 0 ? "−" : ""}{Math.abs(Math.round(l.difference)).toLocaleString("ko-KR")}원</b>{" "}
                      <span className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">원인 미확정</span></p>
                  ))}
                  {plan.incomeRangeUpper !== null && (
                    <p className="text-muted-foreground" data-testid="sync-income-range">모델상 가능한 범위(상한) {won(plan.incomeRangeUpper)} — 확정된 수입이 아닙니다. 보정·입금·배당·이자 거래를 만들지 않습니다.</p>
                  )}
                </div>
              )}

              {plan.affectedSnapshotDates.length > 0 && (
                <p className="flex gap-1.5 text-amber-700 dark:text-amber-300" data-testid="sync-affected">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>기존 일별 스냅샷({plan.affectedSnapshotDates.join(", ")})은 이전 증권사 수량·예수금으로 계산돼 정확하지 않을 수 있습니다. 고치지 않고 그대로 보존하며, 이 날짜들의 성과를 정확한 값으로 쓰지 마세요.</span>
                </p>
              )}
              <p className="text-[11px] text-muted-foreground break-all" data-testid="sync-hash">계획 지문 {plan.planHash}</p>
            </div>
          )}

          {data.blockers.length > 0 && (
            <ul className="space-y-0.5" data-testid="sync-blockers">
              {data.blockers.map((bl) => (
                <li key={bl.code} className="text-xs text-amber-700 dark:text-amber-300 flex gap-1.5" data-code={bl.code}>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{bl.message}</span>
                </li>
              ))}
            </ul>
          )}
          {data.alreadySynced && (
            <p className="text-xs text-sky-700 dark:text-sky-300 flex gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>같은 상태의 동기화가 이미 기록돼 있습니다. 새로 반영할 것이 없습니다.</span></p>
          )}

          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2 text-xs flex gap-2">
            <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
            <p className="text-muted-foreground">반영은 계좌 문서(보유수량·예수금·동기화 기록)와 승인 감사를 DB 가 한 트랜잭션으로 처리합니다. 승인 직전에 서버가 증권사 잔고를 한 번 더 읽고, 위 계획과 다르거나 원장 재생 보유가 증권사 보유와 다르면 전부 취소합니다.</p>
          </div>

          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={approved} disabled={!data.enabled || !plan || done} onChange={(e) => setApproved(e.target.checked)} data-testid="sync-approve" className="mt-0.5" />
            <span>
              위 계획대로 현재 보유수량과 예수금을 증권사 확인값으로 맞추는 것을 승인합니다. 리밸런싱·거래·입금이 아니며, 누적 납입원금·기준금액·이력·기존 스냅샷은 바뀌지 않는 것을 이해합니다.
              반영 뒤 서버 상태를 다시 불러오므로 <b>저장되지 않은 입력은 사라집니다.</b>
            </span>
          </label>
          <Button size="sm" disabled={!canApply} onClick={run} data-testid="sync-apply-button">
            {working ? "처리 중…" : done ? "동기화 완료" : "동기화 반영"}
          </Button>
          {!data.flagEnabled && <p className="text-xs text-muted-foreground" data-testid="sync-flag-off">서버에서 이 기능이 꺼져 있어 계획만 볼 수 있습니다.</p>}
        </div>
      )}

      {msg && (
        <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : msg.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-rose-600 dark:text-rose-400"}`} role="status" data-testid="sync-msg">{msg.text}</p>
      )}

      {syncs.length > 0 && (
        <div className="space-y-1 border-t pt-2" data-testid="sync-history">
          <p className="text-xs font-semibold text-muted-foreground">계좌 동기화 기록 (읽기 전용 · 리밸런싱 이력이 아님)</p>
          <ul className="space-y-1">
            {[...syncs].reverse().map((s) => (
              <li key={s.id} className="rounded-md border p-2 text-xs" data-testid="sync-history-item">
                <span className="font-medium">보유수량 효력일 {s.holdingsEffectiveFrom}</span>
                <span className="block text-muted-foreground tabular-nums">
                  수량 {Object.entries(s.holdingsByTicker).map(([t, q]) => `${t} ${q}주`).join(", ") || "없음"} · 예수금 {won(s.cash.amount)}(관측 기준일 {s.cash.stateAsOf}{s.cash.fresh ? "" : " · 오래된 관측"})
                </span>
                <span className="block text-muted-foreground">승인 {kst(s.approvedAt)} · {s.approvedBy} · 거래 {s.createsTrade ? "있음" : "없음"} · 현금흐름 {s.createsCashflow ? "있음" : "없음"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
