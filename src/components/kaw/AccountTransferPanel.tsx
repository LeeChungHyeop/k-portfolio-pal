import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TransferStateResponse } from "@/lib/kaw/kis-transfer-compose";
import type { ConfirmPayload, ObserveResult, TransferOutcome } from "@/lib/kaw/kis-transfer-client";
import type { TransferRecord } from "@/lib/kaw/account-transfer-record";
import { reconcileTransfer } from "@/lib/kaw/transfer-reconciliation";

/**
 * 계좌 이전 확정 · 잔고 관측 (Phase 4-C-1).
 *
 * 하는 일은 두 가지뿐이다 — 둘 다 **사용자가 승인 체크를 하고 버튼을 눌렀을 때만** 일어난다:
 *   1. 한국투자 잔고를 읽기 전용으로 한 번 조회해 ‘관측’ 1행을 남긴다
 *   2. ‘미래에셋 전량 매도 후 현금 이전’을 확정해 이력 1행을 남긴다
 * 거래원장 · 보유수량 · 예수금 설정 · 누적 납입원금은 바꾸지 않는다. 기록은 고치거나 지울 수 없다.
 *
 * 관측 예수금과 원장 유도 예수금의 차이는 **원인 미확정**으로만 보여 준다 — 이자·분배금·매도 차익·
 * 수수료·신규 납입 등으로 분류하지 않는다.
 */

export interface AccountTransferPanelProps {
  loadState: () => Promise<TransferOutcome<TransferStateResponse>>;
  observe: () => Promise<TransferOutcome<ObserveResult>>;
  confirm: (p: ConfirmPayload) => Promise<TransferOutcome<{ state: "confirmed"; record: TransferRecord }>>;
  /** 체결 미리보기에서 나온 한국투자 실제 체결 매수 합계(조회가 끝났을 때만). 없으면 null */
  kisBuyAmount: number | null;
}

const won = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const signedWon = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
};

const OUTCOME_TEXT: Record<string, string> = {
  not_configured: "서버에 한국투자 계좌 설정이 없습니다. 기존 기능에는 영향이 없습니다.",
  forbidden: "이 프로필에는 한국투자 계좌 권한이 없습니다.",
  unauthorized: "로그인이 만료됐습니다. 다시 로그인하세요.",
  server_error: "서버 오류가 났습니다. 아무것도 기록하지 않았을 수 있으니 상태를 다시 확인하세요.",
  network_error: "네트워크 문제입니다. 기록 여부를 상태 새로고침으로 확인하세요.",
  timeout: "응답 시간이 초과됐습니다. 기록 여부를 상태 새로고침으로 확인하세요.",
};

const NOT_RECORDABLE_TEXT: Record<string, string> = {
  not_registered_instance: "등록된 계좌가 아니라 어느 계좌의 관측인지 주장할 수 없어 기록하지 않았습니다.",
  holdings_not_observed: "보유종목을 읽지 못해 기록하지 않았습니다(0으로 채우지 않습니다).",
  cash_not_observed: "예수금을 읽지 못해 기록하지 않았습니다(0으로 채우지 않습니다).",
  wrong_product: "연금저축(22) 잔고가 아니라 기록하지 않았습니다.",
};

export function AccountTransferPanel({ loadState, observe, confirm, kisBuyAmount }: AccountTransferPanelProps) {
  const [load, setLoad] = useState<{ phase: "loading" } | { phase: "done"; outcome: TransferOutcome<TransferStateResponse> }>({ phase: "loading" });
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);

  // 관측 승인
  const [obsApproved, setObsApproved] = useState(false);
  // 이전 확정 입력
  const [fromChoice, setFromChoice] = useState<string>("__manual__");
  const [fromBroker, setFromBroker] = useState("miraeasset");
  const [fromLabel, setFromLabel] = useState("미래에셋 연금저축");
  const [anchorDate, setAnchorDate] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [cashDate, setCashDate] = useState("");
  const [exitSel, setExitSel] = useState<Record<string, boolean> | null>(null);
  const [note, setNote] = useState("");
  const [trfApproved, setTrfApproved] = useState(false);

  async function refresh() {
    setLoad({ phase: "done", outcome: await loadState() });
  }
  useEffect(() => {
    // DB 만 읽는 상태 조회 — KIS 를 호출하지 않는다.
    let alive = true;
    loadState().then((outcome) => { if (alive) setLoad({ phase: "done", outcome }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = load.phase === "done" && load.outcome.kind === "ok" ? load.outcome.data : null;
  const ok = data && data.state === "ok" ? data : null;

  // 기본 선택: 추정 매도, 기준일: 선택된 행의 가장 늦은 날짜
  useEffect(() => {
    if (!ok || exitSel !== null) return;
    const sel: Record<string, boolean> = {};
    for (const e of ok.exitCandidates) sel[e.txId] = e.defaultSelected;
    setExitSel(sel);
    const dates = ok.exitCandidates.filter((e) => e.defaultSelected).map((e) => e.eventDate).sort();
    if (dates.length) setAnchorDate(dates[dates.length - 1]);
  }, [ok, exitSel]);

  const selectedIds = useMemo(() => Object.entries(exitSel ?? {}).filter(([, v]) => v).map(([k]) => k), [exitSel]);
  const amountNum = Number(cashAmount.replaceAll(",", ""));
  const amountOk = cashAmount.trim() !== "" && Number.isInteger(amountNum) && amountNum > 0;
  const manualFromOk = fromChoice !== "__manual__" || (fromBroker.trim() !== "" && fromLabel.trim() !== "");
  const canSubmit = !!ok && ok.canConfirm && trfApproved && amountOk && selectedIds.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(anchorDate) && manualFromOk && !working;

  async function guarded(fn: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true; setWorking(true); setMsg(null);
    try { await fn(); } finally { busy.current = false; setWorking(false); }
  }

  const doObserve = () => guarded(async () => {
    if (!obsApproved) return;
    const o = await observe();
    if (o.kind !== "ok") {
      setMsg({ tone: "error", text: o.kind === "rejected" ? o.message : OUTCOME_TEXT[o.kind] ?? "기록하지 못했습니다." });
      return;
    }
    const r = o.data;
    if (r.state === "recorded") setMsg({ tone: "ok", text: "잔고 관측 1건을 기록했습니다(원장·보유수량·예수금 설정은 바꾸지 않았습니다)." });
    else if (r.state === "already_recorded") setMsg({ tone: "warn", text: "같은 내용의 관측이 이미 기록돼 있어 새로 쌓지 않았습니다." });
    else if (r.state === "not_recordable") setMsg({ tone: "warn", text: NOT_RECORDABLE_TEXT[r.reason] ?? "기록할 수 없는 조회 결과입니다." });
    else if (r.state === "gate_blocked") setMsg({ tone: "warn", text: "계좌 설정(운용방식·사용기간) 때문에 조회하지 않았습니다." });
    else setMsg({ tone: "error", text: "한국투자 조회에 실패해 아무것도 기록하지 않았습니다. 자동으로 다시 시도하지 않습니다." });
    setObsApproved(false);
    await refresh();
  });

  const doConfirm = () => guarded(async () => {
    if (!ok || !canSubmit) return;
    const from = fromChoice !== "__manual__" ? ok.fromCandidates.find((c) => c.id === fromChoice) : undefined;
    const payload: ConfirmPayload = {
      toInstanceId: ok.target.instanceId,
      fromInstanceId: from ? from.id : null,
      fromBroker: from ? from.broker : fromBroker.trim(),
      fromLabel: from ? from.label : fromLabel.trim(),
      anchorDate,
      cashReceived: { amount: amountNum, date: cashDate.trim() === "" ? null : cashDate.trim() },
      exitTxIds: selectedIds,
      note: note.trim(),
      approved: true,
    };
    const o = await confirm(payload);
    if (o.kind === "ok") setMsg({ tone: "ok", text: "계좌 이전을 확정해 이력에 기록했습니다. 거래원장·원금·보유수량·예수금 설정은 바꾸지 않았습니다." });
    else if (o.kind === "rejected" && o.code === "already_confirmed") {
      // 다른 요청(다른 기기·재시도)이 먼저 기록했다. 이번 요청은 아무것도 쓰지 않았다 — 성공으로 안내하지 않는다.
      setMsg({ tone: "warn", text: "이미 확정되어 있습니다 — 다른 요청이 먼저 기록했습니다. 이번 요청은 아무것도 기록하지 않았습니다. 아래 확정 기록을 확인하세요." });
    }
    else if (o.kind === "rejected") setMsg({ tone: "error", text: `기록하지 않았습니다 — ${o.message}` });
    else setMsg({ tone: "error", text: OUTCOME_TEXT[o.kind] ?? "기록하지 못했습니다." });
    setTrfApproved(false);
    await refresh();
  });

  const record = ok?.records[0] ?? null;
  const recon = ok && record && ok.observation && ok.observation.cash !== null && kisBuyAmount !== null
    ? reconcileTransfer({
        transferAmount: record.cashReceived.amount,
        kisBuyAmount,
        kisBuyAmountAlreadyInLedger: ok.ledger.kisBuyAmountInLedger,
        ledgerDerivedCash: ok.ledger.derivedCash,
        observedCash: ok.observation.cash,
        principalBefore: ok.ledger.principal,
        principalAfter: ok.ledger.principal,
      })
    : null;

  return (
    <Card className="p-4 md:p-5 space-y-3" data-testid="transfer-panel">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowRightLeft className="w-4 h-4 text-muted-foreground shrink-0" />
        <h3 className="font-semibold text-sm">계좌 이전 확정 · 잔고 관측</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">연금저축 · 미래에셋 → 한국투자</span>
      </div>

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs flex gap-2" data-testid="transfer-disclaimer">
        <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
        <p className="text-muted-foreground">
          이 화면은 <b>거래원장 · 보유수량 · 예수금 설정 · 누적 납입원금을 바꾸지 않습니다.</b> 승인 후 남는 기록은
          ‘읽기 전용 잔고 관측’과 ‘이전 확정 이력’ 각 1건이며, 기록은 <b>고치거나 지울 수 없습니다.</b>
          계좌 내부 이전은 신규 납입이 아닙니다.
        </p>
      </div>

      {load.phase === "loading" && <p className="text-xs text-muted-foreground" data-testid="transfer-loading">상태를 불러오는 중…</p>}
      {load.phase === "done" && load.outcome.kind !== "ok" && (
        <p className={`text-xs ${["forbidden", "not_configured"].includes(load.outcome.kind) ? "text-muted-foreground" : "text-rose-600 dark:text-rose-400"}`} role="alert" data-testid="transfer-error">
          {load.outcome.kind === "rejected" ? load.outcome.message : OUTCOME_TEXT[load.outcome.kind] ?? "상태를 불러오지 못했습니다."}
        </p>
      )}
      {data && data.state === "no_target" && (
        <p className="text-xs text-amber-700 dark:text-amber-300 flex gap-1.5" role="status" data-testid="transfer-no-target">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>등록된 한국투자 연금저축 계좌가 없습니다. 설정 → 증권사·운용방식에서 먼저 등록하세요.</span>
        </p>
      )}

      {msg && (
        <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : msg.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-rose-600 dark:text-rose-400"}`}
           role="status" data-testid="transfer-msg">{msg.text}</p>
      )}

      {ok && (
        <>
          {/* 체크리스트 */}
          <ul className="space-y-1" data-testid="transfer-checklist">
            {ok.checklist.map((c) => (
              <li key={c.id} className="text-xs flex gap-1.5" data-testid={`check-${c.id}`} data-ok={c.ok ? "1" : "0"}>
                {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <Circle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />}
                <span><span className={c.ok ? "" : "text-muted-foreground"}>{c.label}</span>{c.detail && <span className="text-muted-foreground"> — {c.detail}</span>}</span>
              </li>
            ))}
          </ul>

          {/* 1. 잔고 관측 */}
          <div className="rounded-lg border p-3 space-y-2" data-testid="transfer-observation">
            <p className="text-xs font-semibold text-muted-foreground">① 한국투자 잔고 관측 (읽기 전용)</p>
            {ok.observation ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs" data-testid="obs-summary">
                <dt className="text-muted-foreground">출처</dt><dd>한국투자증권 · {ok.observation.sourceType}</dd>
                <dt className="text-muted-foreground">조회 시각</dt><dd className="tabular-nums">{when(ok.observation.observedAt)}</dd>
                <dt className="text-muted-foreground">증권사 기준일</dt>
                <dd className="tabular-nums">{ok.observation.stateAsOf} <span className="text-muted-foreground">({ok.observation.stateAsOfBasis === "observation_date" ? "현재 잔고 = 조회일" : "증권사 보고일"})</span></dd>
                <dt className="text-muted-foreground">보유</dt>
                <dd>{ok.observation.holdings === null ? "미관측" : Object.entries(ok.observation.holdings).map(([k, v]) => `${k} ${v.toLocaleString("ko-KR")}주`).join(", ") || "없음"}</dd>
                <dt className="text-muted-foreground">예수금</dt><dd className="tabular-nums" data-testid="obs-cash">{won(ok.observation.cash)}</dd>
                <dt className="text-muted-foreground">기록자</dt><dd>{ok.observation.actor}</dd>
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="obs-none">기록된 관측이 없습니다.</p>
            )}
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={obsApproved} onChange={(e) => setObsApproved(e.target.checked)} data-testid="obs-approve" className="mt-0.5" />
              <span>한국투자 연금저축 잔고를 <b>읽기 전용으로 1회 조회</b>하고, 결과를 관측 1건으로 기록하는 것을 승인합니다. 주문·이체는 일어나지 않습니다.</span>
            </label>
            <Button size="sm" variant="outline" disabled={!obsApproved || working} onClick={doObserve} data-testid="obs-button">
              {working ? "처리 중…" : "잔고 조회하고 관측 기록"}
            </Button>
          </div>

          {/* 2. 이전 확정 */}
          <div className="rounded-lg border p-3 space-y-2" data-testid="transfer-confirm-section">
            <p className="text-xs font-semibold text-muted-foreground">② 계좌 이전 확정 — 매도 후 현금 이전</p>
            {record ? (
              <RecordView record={record} />
            ) : (
              <div className="space-y-2">
                {!ok.canConfirm && (
                  <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="confirm-blocked">
                    확정하려면 위 체크리스트가 모두 충족돼야 합니다(이탈 근거 · 잔고 관측).
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground space-y-1 block">
                    <span>이전 증권사 계좌</span>
                    <select className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" value={fromChoice} onChange={(e) => setFromChoice(e.target.value)} data-testid="from-choice">
                      <option value="__manual__">등록되지 않은 이전 증권사 계좌 (직접 입력)</option>
                      {ok.fromCandidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </label>
                  {fromChoice === "__manual__" && (
                    <>
                      <label className="text-xs text-muted-foreground space-y-1 block">
                        <span>증권사 (계좌번호는 입력하지 마세요)</span>
                        <Input value={fromBroker} onChange={(e) => setFromBroker(e.target.value)} data-testid="from-broker" />
                      </label>
                      <label className="text-xs text-muted-foreground space-y-1 block">
                        <span>표시 이름</span>
                        <Input value={fromLabel} onChange={(e) => setFromLabel(e.target.value)} data-testid="from-label" />
                      </label>
                    </>
                  )}
                  <label className="text-xs text-muted-foreground space-y-1 block">
                    <span>이전 회계 기준일</span>
                    <Input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} data-testid="anchor-date" />
                  </label>
                  <label className="text-xs text-muted-foreground space-y-1 block">
                    <span>확인한 이전(입고) 금액 (원)</span>
                    <Input inputMode="numeric" placeholder="직접 입력" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} data-testid="cash-amount" />
                  </label>
                  <label className="text-xs text-muted-foreground space-y-1 block">
                    <span>입고 일자 (모르면 비워 두세요 — 지어내지 않습니다)</span>
                    <Input type="date" value={cashDate} onChange={(e) => setCashDate(e.target.value)} data-testid="cash-date" />
                  </label>
                </div>

                <div className="space-y-1" data-testid="exit-candidates">
                  <p className="text-xs text-muted-foreground">이전 증권사 이탈 근거 (매도 거래)</p>
                  {ok.exitCandidates.length === 0 && <p className="text-xs text-muted-foreground">선택할 매도 거래가 없습니다.</p>}
                  {ok.exitCandidates.map((e) => (
                    <label key={e.txId} className="flex items-start gap-2 text-xs rounded-md border p-2" data-testid="exit-row">
                      <input type="checkbox" checked={!!exitSel?.[e.txId]} onChange={(ev) => setExitSel((s) => ({ ...(s ?? {}), [e.txId]: ev.target.checked }))} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="font-medium">{e.etfName}</span> <span className="text-muted-foreground">{e.ticker} · {e.eventDate} · 매도 {e.quantity.toLocaleString("ko-KR")}주 · {won(e.amount)}</span>{" "}
                        {e.basis === "user_attested_estimate"
                          ? <span className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300" data-testid="exit-estimate-badge">추정 매도 — 실제 체결 아님</span>
                          : <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">증권사 체결</span>}
                      </span>
                    </label>
                  ))}
                </div>

                <label className="text-xs text-muted-foreground space-y-1 block">
                  <span>메모 (선택, 200자)</span>
                  <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="confirm-note" />
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={trfApproved} onChange={(e) => setTrfApproved(e.target.checked)} data-testid="confirm-approve" className="mt-0.5" />
                  <span>
                    미래에셋 ETF를 <b>전량 매도한 뒤 현금으로 이전</b>했음을 확인합니다. 선택한 추정 매도는 <b>실제 체결이 아니라 사용자가 승인한 추정</b>임을 이해하며,
                    이 확정은 신규 납입이 아니고 원장·보유수량·예수금을 바꾸지 않음을 확인합니다.
                  </span>
                </label>
                <Button size="sm" disabled={!canSubmit} onClick={doConfirm} data-testid="confirm-button">
                  {working ? "처리 중…" : "이전 확정 기록"}
                </Button>
              </div>
            )}
          </div>

          {/* 3. 대사 */}
          <div className="rounded-lg border p-3 space-y-1.5" data-testid="transfer-recon">
            <p className="text-xs font-semibold text-muted-foreground">③ 자금 대사 — 차이의 크기만 보여 줍니다</p>
            {recon ? (
              <div className="space-y-1.5 text-xs">
                <p>누적 납입원금 <b className="tabular-nums" data-testid="recon-principal">{won(recon.principal.after)}</b>{" "}
                  <span className="text-muted-foreground">→ {recon.principal.unchanged ? "변동 없음 (이전은 신규 납입이 아닙니다)" : "변동 발생 — 확인 필요"}</span></p>
                <p className="text-muted-foreground">이전 확인금액 {won(record!.cashReceived.amount)} − 체결 매수 {won(kisBuyAmount)} = 기대 예수금 <span className="tabular-nums">{won(recon.expectedCashAfterBuys)}</span> · 관측 예수금 <span className="tabular-nums">{won(ok.observation!.cash)}</span></p>
                {recon.lines.map((l) => (
                  <div key={l.id} className="rounded-md border p-2" data-testid={`recon-${l.id}`} data-status={l.status}>
                    <p>{l.label}</p>
                    <p>
                      기준 <span className="tabular-nums">{won(l.baseline)}</span> → 관측 <span className="tabular-nums">{won(l.observed)}</span> ·
                      차이 <b className="tabular-nums" data-testid={`recon-${l.id}-diff`}>{signedWon(l.difference)}</b>{" "}
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${l.status === "matches" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}>
                        {l.status === "matches" ? "일치" : "원인 미확정"}
                      </span>
                    </p>
                    <p className="text-muted-foreground">{l.note}</p>
                  </div>
                ))}
                <p className="text-muted-foreground" data-testid="recon-not-classified">
                  자동으로 분류하지 않는 항목: {recon.notClassifiedAs.join(" · ")}. 차이를 메우는 보정 거래는 만들지 않습니다.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="recon-pending">
                이전 확정 · 잔고 관측 · 체결내역 조회(위 ‘한국투자 체결내역 가져오기’)가 모두 끝나면 대사 결과가 표시됩니다.
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function RecordView({ record }: { record: TransferRecord }) {
  return (
    <div className="space-y-1.5 text-xs" data-testid="transfer-record">
      <p className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> 이전이 확정되어 있습니다 (수정할 수 없음)</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">방식</dt><dd>매도 후 현금 이전</dd>
        <dt className="text-muted-foreground">이전 증권사</dt><dd>{record.fromLabel}{record.fromInstanceId ? "" : " (레지스트리 미등록)"}</dd>
        <dt className="text-muted-foreground">새 증권사</dt><dd>한국투자증권 연금저축({record.toProductCode ?? "-"})</dd>
        <dt className="text-muted-foreground">이전 기준일</dt><dd className="tabular-nums">{record.anchorDate}</dd>
        <dt className="text-muted-foreground">확인한 이전 금액</dt><dd className="tabular-nums" data-testid="record-amount">{won(record.cashReceived.amount)}</dd>
        <dt className="text-muted-foreground">입고 일자</dt><dd>{record.cashReceived.date ?? "미확인"}</dd>
        <dt className="text-muted-foreground">승인</dt><dd>{record.approval.actor} · {when(record.approval.at)}</dd>
      </dl>
      <div className="space-y-1" data-testid="record-exits">
        <p className="text-muted-foreground">이탈 근거 {record.exitEvidence.length}건{record.containsEstimates && " — 추정 포함(실제 체결 아님)"}</p>
        {record.exitEvidence.map((e) => (
          <p key={e.txId} className="rounded-md border p-1.5">
            {e.etfName} {e.ticker} · {e.eventDate} · 매도 {e.quantity.toLocaleString("ko-KR")}주 {won(e.amount)}{" "}
            {e.basis === "user_attested_estimate"
              ? <span className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">추정 매도 — 실제 체결 아님</span>
              : <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">증권사 체결</span>}
            <span className="block text-muted-foreground break-all">출처 {e.source}{e.importBatchId ? ` · 배치 ${e.importBatchId}` : ""}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
