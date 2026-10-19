import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApplyView } from "@/lib/kaw/kis-execution-compose";
import type { ApplyOutcome, ApplyRequest } from "@/lib/kaw/kis-ledger-apply-client";

/**
 * 한국투자 실제 체결 → 거래원장 반영 (Phase 4-C-2).
 *
 * 사용자가 아래 내용을 **직접 확인하고 승인 체크를 해야만** 반영 버튼이 눌린다.
 *   · 반영 대상은 ‘신규 체결’만이다 — 체결 0주 주문은 계획에 없다
 *   · 반영은 원장 행 + batch + 승인 감사를 DB 가 한 트랜잭션으로 처리한다(일부만 반영되지 않는다)
 *   · 누적 납입원금 · 보유수량 설정 · 예수금 설정은 바뀌지 않는다
 *   · 예수금 차이는 원인 미확정으로 보존한다(보정 거래를 만들지 않는다)
 * 서버는 승인 직전에 KIS 체결과 최신 원장을 다시 확인하고, 사용자가 본 계획과 다르면 거부한다.
 */

const won = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const signedWon = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;
const holdingsText = (m: Record<string, number> | null) =>
  m === null ? "미관측" : Object.entries(m).map(([k, v]) => `${k} ${v.toLocaleString("ko-KR")}주`).join(", ") || "없음";

const REJECT_TEXT: Record<string, string> = {
  plan_changed: "승인한 뒤 원장·체결·관측이 바뀌어 반영하지 않았습니다. 다시 조회해 새 계획을 확인하세요.",
  already_applied: "이미 같은 주문이 원장에 반영돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.",
  busy: "같은 요청이 처리 중입니다. 잠시 후 다시 조회해 확인하세요.",
  apply_disabled: "원장 반영 기능이 서버에서 켜져 있지 않습니다.",
  not_eligible: "반영 조건을 만족하지 않아 반영하지 않았습니다.",
};
const OUTCOME_TEXT: Record<string, string> = {
  query_failed: "한국투자 체결 재조회에 실패해 반영하지 않았습니다. 자동으로 다시 시도하지 않았습니다.",
  unavailable: "DB 반영 함수(migration 012)가 아직 적용되지 않아 반영할 수 없습니다.",
  not_configured: "서버에 한국투자 계좌 설정이 없어 반영할 수 없습니다.",
  forbidden: "이 프로필에는 한국투자 계좌 권한이 없습니다.",
  unauthorized: "로그인이 만료됐습니다. 다시 로그인한 뒤 조회하세요.",
  server_error: "서버 오류입니다. 반영 여부가 불확실하니 다시 조회해 원장 대조 결과를 확인하세요.",
  network_error: "네트워크 문제입니다. 반영 여부가 불확실하니 다시 조회해 원장 대조 결과를 확인하세요.",
  timeout: "응답 시간이 초과됐습니다. 반영 여부가 불확실하니 다시 조회해 원장 대조 결과를 확인하세요.",
};

export interface KisLedgerApplySectionProps {
  apply: ApplyView;
  /** 사용자가 본 체결 조회 기간 */
  range: { start: string; end: string };
  onApply?: (req: ApplyRequest) => Promise<ApplyOutcome>;
}

export function KisLedgerApplySection({ apply, range, onApply }: KisLedgerApplySectionProps) {
  const [approved, setApproved] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const busy = useRef(false);
  const plan = apply.plan;

  const canApply = apply.enabled && approved && !working && !done && !!onApply && !!plan;

  async function run() {
    if (!canApply || busy.current || !plan || !onApply) return;
    busy.current = true; setWorking(true); setMsg(null);
    try {
      // 실패해도 다시 시도하지 않는다. 승인은 한 번의 요청에만 쓰인다.
      const o = await onApply({ start: range.start, end: range.end, planHash: plan.planHash });
      setApproved(false);
      if (o.kind === "applied") {
        setDone(true);
        setMsg({ tone: "ok", text: `원장에 ${o.inserted}건을 반영했습니다(batch ${o.batchId}). 거래원장·승인 감사가 한 번에 기록됐고 보유수량·예수금 설정과 누적 납입원금은 바꾸지 않았습니다. [조회]를 다시 눌러 원장 대조 결과를 확인하세요.` });
      } else if (o.kind === "rejected") {
        setMsg({ tone: o.code === "already_applied" ? "warn" : "error", text: `반영하지 않았습니다 — ${REJECT_TEXT[o.code] ?? o.message}` });
      } else {
        setMsg({ tone: "error", text: `반영하지 않았습니다 — ${OUTCOME_TEXT[o.kind] ?? "알 수 없는 오류입니다."}` });
      }
    } finally {
      busy.current = false; setWorking(false);
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid="apply-section">
      <p className="text-xs font-semibold text-muted-foreground">원장 반영 — 사용자가 확인하고 승인해야만 기록됩니다</p>

      {apply.alreadyApplied && (
        <p className="text-xs text-sky-700 dark:text-sky-300 flex gap-1.5" data-testid="apply-already">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>이미 같은 주문이 원장에 반영돼 있습니다. 새로 반영할 것이 없습니다.</span>
        </p>
      )}

      {plan && (
        <div className="space-y-2" data-testid="apply-plan">
          <ul className="space-y-1" data-testid="apply-rows">
            {plan.rows.map((r) => (
              <li key={`${r.ticker}-${r.orderNoTail}`} className="rounded-md border p-2 text-xs" data-testid="apply-row">
                <span className="font-medium">{r.etfName}</span>{" "}
                <span className="text-muted-foreground">{r.ticker} · 체결일 {r.tradeDate} · 주문 …{r.orderNoTail}</span>
                <span className="block tabular-nums">
                  매수 {r.quantity.toLocaleString("ko-KR")}주 · 평균 체결가 {won(r.price)} · 체결금액 {won(r.amount)}
                  <span className="ml-2 inline-block rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">원장 중복 없음(신규)</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs" data-testid="apply-totals">
            합계 <b className="tabular-nums">{plan.totalQuantity.toLocaleString("ko-KR")}주</b> · <b className="tabular-nums">{won(plan.totalAmount)}</b>
            <span className="text-muted-foreground"> · 체결 0주 주문은 계획에 없습니다. 수수료·세금은 증권사가 주지 않아 비워 둡니다(추정하지 않음).</span>
          </p>
          <div className="text-xs space-y-0.5" data-testid="apply-holdings">
            <p>원장 재생 보유: <span className="tabular-nums">{holdingsText(plan.holdings.before)}</span> → 반영 후 <b className="tabular-nums">{holdingsText(plan.holdings.after)}</b></p>
            <p>
              한국투자 관측 보유: <span className="tabular-nums">{holdingsText(plan.holdings.observed)}</span>{" "}
              <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${plan.holdings.matches ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300"}`} data-testid="apply-holdings-match">
                {plan.holdings.matches ? "일치" : "불일치"}
              </span>
              {plan.observation && <span className="text-muted-foreground"> (관측 기준일 {plan.observation.stateAsOf})</span>}
            </p>
            <p>누적 납입원금 <b className="tabular-nums" data-testid="apply-principal">{won(plan.principal.after)}</b> <span className="text-muted-foreground">— 변동 없음 (이전금액을 신규 납입으로 만들지 않습니다)</span></p>
          </div>
          {plan.reconciliation && (
            <div className="text-xs space-y-0.5" data-testid="apply-recon">
              {plan.reconciliation.lines.map((l) => (
                <p key={l.id}>
                  {l.label}: <b className="tabular-nums">{signedWon(l.difference)}</b>{" "}
                  <span className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{l.status === "matches" ? "일치" : "원인 미확정"}</span>
                </p>
              ))}
              <p className="text-muted-foreground">이 차이는 이번 반영으로 메우지 않습니다. 보정 거래·가상 입금·배당·이자를 만들지 않습니다.</p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground break-all" data-testid="apply-hash">계획 지문 {plan.planHash}</p>
        </div>
      )}

      {apply.blockers.length > 0 && (
        <ul className="space-y-0.5" data-testid="apply-blockers">
          {apply.blockers.map((b) => (
            <li key={b.code} className="text-xs text-amber-700 dark:text-amber-300 flex gap-1.5" data-code={b.code}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{b.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2 text-xs flex gap-2">
        <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
        <p className="text-muted-foreground">반영은 원장 행 + 적재 이력 + 승인 감사를 DB 가 한 트랜잭션으로 처리합니다(일부만 반영되지 않음). 승인 직전에 서버가 한국투자 체결과 최신 원장을 다시 확인하고, 위 계획과 다르면 거부합니다.</p>
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={approved} disabled={!apply.enabled || done} onChange={(e) => setApproved(e.target.checked)} data-testid="apply-approve" className="mt-0.5" />
        <span>
          위 한국투자 <b>실제 체결 {plan?.rows.length ?? 0}건</b>({plan ? `${plan.totalQuantity.toLocaleString("ko-KR")}주 · ${won(plan.totalAmount)}` : "-"})을 거래원장에 반영하는 것을 승인합니다.
          누적 납입원금·보유수량 설정·예수금 설정은 바뀌지 않으며, 예수금 차이({plan?.reconciliation ? plan.reconciliation.lines.map((l) => signedWon(l.difference)).join(" · ") : "-"})는 원인 미확정으로 남는 것을 이해합니다.
        </span>
      </label>
      <Button size="sm" disabled={!canApply} onClick={run} data-testid="apply-button">
        {working ? "반영 중…" : done ? "반영 완료" : "원장에 반영"}
      </Button>

      {msg && (
        <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : msg.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-rose-600 dark:text-rose-400"}`} role="status" data-testid="apply-msg">{msg.text}</p>
      )}
    </div>
  );
}
