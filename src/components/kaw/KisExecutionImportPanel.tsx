import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Landmark, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrokerAccountInstance } from "@/lib/kaw/broker-account";
import { kisApiQueryGate } from "@/lib/kaw/broker-connection";
import type { ExecRange, ExecRequestOutcome } from "@/lib/kaw/kis-execution-client";
import type { ExecEntryView, KisExecutionPreviewResponse } from "@/lib/kaw/kis-execution-compose";
import { PREVIEW_STATUS_LABEL, type PreviewStatus } from "@/lib/kaw/kis-execution-preview";
import type { CcldFailureKind } from "@/lib/kaw/kis-ccld-history";
import type { ApplyOutcome, ApplyRequest } from "@/lib/kaw/kis-ledger-apply-client";
import { KisLedgerApplySection } from "@/components/kaw/KisLedgerApplySection";

/**
 * 한국투자 체결내역 가져오기 — **조회·미리보기 전용** 화면 (Phase 4-B).
 *
 * 이 화면은 어떤 것도 원장·장부·리밸런싱 기록에 쓰지 않는다. 증권사에서 조회한 **실제 체결
 * 실적**을 보여주고 기존 원장과 대조한 결과만 읽기 전용으로 보여준다. 원장 반영 버튼은
 * 비활성이고 막는 사유를 그대로 나열한다.
 *
 * 조회는 사용자가 [조회]를 누를 때만 일어난다 — 마운트·타이머·포커스 복귀에서 부르지 않고,
 * 실패해도 자동으로 다시 시도하지 않는다.
 */

const GATE_TEXT: Record<string, string> = {
  mode_calc_only: "연금저축이 '계산만 제공'으로 설정돼 있어 조회하지 않습니다. 설정 → 증권사·운용방식에서 한국투자 + API 연동(읽기 전용)으로 바꾸세요.",
  broker_not_kis: "연금저축이 한국투자증권으로 설정돼 있지 않아 조회하지 않습니다.",
  account_type_unsupported: "이 계좌 종류는 조회를 지원하지 않습니다.",
  instance_unregistered: "등록된 계좌가 없어 조회하지 않습니다. 설정 → 증권사·운용방식에서 한국투자증권 연금저축을 설정하세요.",
  instance_ambiguous: "사용 중인 계좌가 둘 이상이라 조회하지 않습니다.",
  instance_not_active: "계좌 사용 시작일이 아직 되지 않았거나 이미 종료돼 조회하지 않습니다.",
  product_mismatch: "계좌 상품코드가 맞지 않아 조회하지 않습니다.",
};

const FAILURE_TEXT: Record<CcldFailureKind, string> = {
  auth: "인증 문제로 조회하지 못했습니다(토큰·앱키).",
  account: "계좌번호 또는 계좌상품코드 문제로 조회하지 못했습니다.",
  rate_limit: "호출 빈도 제한으로 조회하지 못했습니다. 잠시 후 직접 다시 조회하세요.",
  request_value: "요청 값(날짜·구분 코드) 문제로 조회하지 못했습니다.",
  possibly_unsupported: "이 계좌에서 이 조회를 지원하지 않을 가능성이 있습니다(확정 아님).",
  network: "네트워크 문제로 조회하지 못했습니다.",
  timeout: "응답 시간이 초과됐습니다. 증권사에는 이미 요청이 갔을 수 있습니다.",
  unparseable: "증권사 응답을 해석하지 못했습니다.",
  unclassified: "원인을 분류하지 못한 오류입니다.",
};

const STATUS_TONE: Record<PreviewStatus, string> = {
  new: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  matches: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  possible_duplicate: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  attribution_conflict: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  no_execution: "bg-muted text-muted-foreground",
  unverifiable: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

const won = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const qty = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${n.toLocaleString("ko-KR")}주`);
const sideText = (s: "buy" | "sell" | "unknown") => (s === "buy" ? "매수" : s === "sell" ? "매도" : "확인 불가");
const sideTone = (s: "buy" | "sell" | "unknown") => (s === "buy" ? "text-rose-600 dark:text-rose-400" : s === "sell" ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground");

type View =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; outcome: ExecRequestOutcome; range: { start: string; end: string } };

export interface KisExecutionImportPanelProps {
  registry: readonly BrokerAccountInstance[];
  /** YYYY-MM-DD (KST) */
  today: string;
  /** 조회 함수 주입 — 화면 테스트·mock 화면은 가짜를 넣는다. 기본 구현은 Card 가 연결한다 */
  request: (range: ExecRange) => Promise<ExecRequestOutcome>;
  /** 조회가 끝날 때마다 결과를 알린다(이전 대사 패널이 체결 매수 합계를 쓴다). 저장하지 않는다 */
  onResult?: (outcome: ExecRequestOutcome) => void;
  /** 체결 → 거래원장 반영 요청 (Phase 4-C-2). 사용자가 승인 체크 후 버튼을 눌렀을 때만 호출된다. 없으면 반영 섹션은 읽기 전용이다 */
  onApply?: (req: ApplyRequest) => Promise<ApplyOutcome>;
}

function Badge({ status }: { status: PreviewStatus }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${STATUS_TONE[status]}`}>
      {PREVIEW_STATUS_LABEL[status]}
    </span>
  );
}

function Notes({ e }: { e: ExecEntryView }) {
  const lines = [...e.notes];
  if (e.ledgerRef) {
    lines.push(`비교한 원장 행: ${e.ledgerRef.date} · ${e.ledgerRef.ticker} · ${e.ledgerRef.side === "buy" ? "매수" : "매도"} ${e.ledgerRef.quantity}주 · 출처 ${e.ledgerRef.source}`);
  }
  if (!lines.length) return null;
  return <div className="mt-1 space-y-0.5">{lines.map((l, i) => <p key={i} className="text-xs text-muted-foreground break-words">{l}</p>)}</div>;
}

function Results({ data, range, onApply }: { data: Extract<KisExecutionPreviewResponse, { state: "ok" }>; range: { start: string; end: string }; onApply?: (req: ApplyRequest) => Promise<ApplyOutcome> }) {
  const executed = data.entries.filter((e) => e.row.hasExecution);
  // 체결이 없다고 **확인된** 주문과, 읽지 못해 **알 수 없는** 주문은 다른 말이다 — 섞어 보이지 않는다.
  const zero = data.entries.filter((e) => !e.row.hasExecution && e.status !== "unverifiable");
  const unknown = data.entries.filter((e) => !e.row.hasExecution && e.status === "unverifiable");
  const t = data.totals;
  const q = data.query;
  const f = data.impact.funding;

  return (
    <div className="space-y-3" role="status" data-testid="exec-results">
      {!q.complete && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="exec-incomplete">
          <p className="font-semibold text-amber-700 dark:text-amber-300">조회 결과가 불완전합니다</p>
          <p className="text-muted-foreground mt-0.5">
            {q.unreadPages
              ? "다음 페이지가 더 있지만 읽지 않았습니다. 아래 목록과 합계는 읽은 범위까지만이고, 실제보다 적을 수 있습니다."
              : "일부 구간을 끝까지 읽지 못했습니다. 아래 목록과 합계는 실제보다 적을 수 있습니다."}
          </p>
        </div>
      )}

      {q.listState === "list_absent" && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="exec-list-absent">
          응답에 체결 목록이 없어 결과를 알 수 없습니다. <b>0건이라는 뜻이 아닙니다.</b>
        </p>
      )}
      {q.listState === "empty" && data.entries.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="exec-empty">
          조회한 조건({q.start} ~ {q.end})에서 체결 주문이 관측되지 않았습니다. 주문이 없었다는 증거는 아닙니다 —
          날짜·거래소 구분이 맞는지 확인하세요.
        </p>
      )}
      {q.duplicateOrderKeys > 0 && (
        <p className="text-xs text-rose-600 dark:text-rose-400">
          같은 주문번호가 응답에 {q.duplicateOrderKeys}건 겹쳐 해당 행은 확인 불가로 표시했습니다.
        </p>
      )}

      {/* 상태 요약 */}
      <div className="flex flex-wrap gap-1.5" data-testid="exec-status-counts">
        {(Object.keys(PREVIEW_STATUS_LABEL) as PreviewStatus[]).map((s) => (
          <span key={s} className="text-xs"><Badge status={s} /> <b className="tabular-nums">{t.byStatus[s]}</b></span>
        ))}
      </div>

      {/* 합계 — 체결수량 > 0 인 행만 */}
      {data.entries.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-0.5" data-testid="exec-totals">
          <p>
            체결 매수 <b className="tabular-nums">{executed.filter((e) => e.row.side === "buy").length}건</b>{" "}
            · {qty(t.executed.buyQty)} · 합계 <b className="tabular-nums" data-testid="exec-buy-amount">{won(t.executed.buyAmount)}</b>
          </p>
          {t.executed.sellAmount > 0 && (
            <p>체결 매도 · {qty(t.executed.sellQty)} · 합계 <b className="tabular-nums">{won(t.executed.sellAmount)}</b></p>
          )}
          <p className="text-xs text-muted-foreground">
            체결 0주로 확인된 주문 {t.zeroFillRows}건은 합계에서 제외했습니다.
            {t.unreadableRows > 0 && <> 읽지 못한 주문 {t.unreadableRows}건은 체결 여부를 알 수 없어 합계에 넣지 않았습니다.</>}
            {data.apiCrossCheck && (
              <> 증권사 요약 합계 {won(data.apiCrossCheck.apiTotalFilledAmount)} — {data.apiCrossCheck.matches ? "일치" : <b className="text-rose-600">불일치</b>}.</>
            )}
          </p>
        </div>
      )}

      {/* 체결된 주문 */}
      {executed.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground mb-1.5">체결된 주문 ({executed.length}건 · 주문 단위 집계)</p>

          {/* 데스크톱: 표 */}
          <div className="hidden md:block overflow-x-auto" data-testid="exec-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1.5 pr-3 font-medium">주문일</th>
                  <th className="py-1.5 pr-3 font-medium">종목</th>
                  <th className="py-1.5 pr-3 font-medium">구분</th>
                  <th className="py-1.5 pr-3 font-medium text-right">체결수량</th>
                  <th className="py-1.5 pr-3 font-medium text-right">평균 체결가</th>
                  <th className="py-1.5 pr-3 font-medium text-right">총체결금액</th>
                  <th className="py-1.5 font-medium">원장 대조</th>
                </tr>
              </thead>
              <tbody>
                {executed.map((e) => (
                  <tr key={e.row.key} className="border-b align-top" data-testid="exec-row">
                    <td className="py-2 pr-3 tabular-nums whitespace-nowrap">{e.row.orderDate}</td>
                    <td className="py-2 pr-3"><div className="font-medium">{e.row.name ?? e.row.ticker}</div><div className="text-xs text-muted-foreground">{e.row.ticker} · 주문 …{e.row.orderNoTail}</div></td>
                    <td className={`py-2 pr-3 font-medium ${sideTone(e.row.side)}`}>{sideText(e.row.side)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{qty(e.row.filledQty)}{e.row.orderQty !== e.row.filledQty && <div className="text-xs text-muted-foreground">주문 {qty(e.row.orderQty)}</div>}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{won(e.row.avgPrice)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{won(e.row.filledAmount)}</td>
                    <td className="py-2"><Badge status={e.status} /><Notes e={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 모바일: 카드 */}
          <ul className="md:hidden space-y-2" data-testid="exec-cards">
            {executed.map((e) => (
              <li key={e.row.key} className="rounded-lg border p-3 space-y-1" data-testid="exec-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{e.row.name ?? e.row.ticker}</p>
                    <p className="text-xs text-muted-foreground">{e.row.ticker} · {e.row.orderDate} · 주문 …{e.row.orderNoTail}</p>
                  </div>
                  <span className={`shrink-0 text-sm font-semibold ${sideTone(e.row.side)}`}>{sideText(e.row.side)}</span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">체결수량</dt><dd className="tabular-nums font-medium">{qty(e.row.filledQty)}</dd></div>
                  <div><dt className="text-muted-foreground">평균 체결가</dt><dd className="tabular-nums font-medium">{won(e.row.avgPrice)}</dd></div>
                  <div><dt className="text-muted-foreground">총체결금액</dt><dd className="tabular-nums font-medium break-all">{won(e.row.filledAmount)}</dd></div>
                </dl>
                {e.row.orderQty !== e.row.filledQty && <p className="text-xs text-muted-foreground">주문 {qty(e.row.orderQty)} 중 {qty(e.row.filledQty)} 체결</p>}
                <div><Badge status={e.status} /></div>
                <Notes e={e} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 체결 0주 주문 — 매수 실적이 아니다 */}
      {zero.length > 0 && (
        <div className="rounded-lg border border-dashed p-3 space-y-1.5" data-testid="exec-zero-fill">
          <p className="text-xs font-semibold text-muted-foreground">체결 없는 주문 (0주) {zero.length}건 — 매수 실적에 포함하지 않습니다</p>
          {zero.map((e) => (
            <div key={e.row.key} className="text-xs" data-testid="exec-zero-row">
              <span className="font-medium">{e.row.name ?? e.row.ticker}</span>{" "}
              <span className="text-muted-foreground">{e.row.ticker} · {e.row.orderDate} · {sideText(e.row.side)} 주문 {qty(e.row.orderQty)} · 체결 {qty(e.row.filledQty)} · 잔여 {qty(e.row.remainingQty)} · 주문 …{e.row.orderNoTail}</span>{" "}
              <Badge status={e.status} />
              <Notes e={e} />
            </div>
          ))}
        </div>
      )}

      {/* 확인 불가 — 체결이 없다는 뜻이 아니다 */}
      {unknown.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1.5" data-testid="exec-unverifiable">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            확인 불가 {unknown.length}건 — 필수 정보를 읽지 못했습니다. <b>체결이 없다는 뜻이 아닙니다</b>
          </p>
          {unknown.map((e) => (
            <div key={e.row.key} className="text-xs" data-testid="exec-unverifiable-row">
              <span className="font-medium">{e.row.name ?? e.row.ticker ?? "종목 미확인"}</span>{" "}
              <span className="text-muted-foreground">{e.row.ticker ?? "-"} · {e.row.orderDate ?? "-"} · 주문 …{e.row.orderNoTail}</span>{" "}
              <Badge status={e.status} />
              <Notes e={e} />
            </div>
          ))}
        </div>
      )}

      {/* 원장 반영 시 예상 영향 (읽기 전용) */}
      <div className="rounded-lg border p-3 space-y-1.5 text-sm" data-testid="exec-impact">
        <p className="text-xs font-semibold text-muted-foreground">원장 반영 시 예상 영향 — 읽기 전용 · 아무것도 반영되지 않았습니다</p>
        <p>
          누적 납입원금 <b className="tabular-nums" data-testid="exec-principal">{data.impact.principal === null ? "확인 불가" : won(data.impact.principal)}</b>
          <span className="text-muted-foreground"> → 변동 없음 (이전 자금을 신규 납입으로 만들지 않습니다)</span>
        </p>
        {f ? (
          <div className="text-xs space-y-0.5" data-testid="exec-funding">
            <p>
              이 체결만 원장에 더하면 유도 예수금 <span className="tabular-nums">{won(f.before.finalDerived)}</span> → <b className="tabular-nums">{won(f.after.finalDerived)}</b>
              {f.phantomIncomeLB > 0 && (
                <> · <b className="text-rose-600 dark:text-rose-400">가짜 ‘미관측 수입’ {won(f.phantomIncomeLB)} 발생 위험</b></>
              )}
            </p>
            {f.holdings && (
              <p className="text-muted-foreground">
                원장 재생 보유(반영 후): {Object.entries(f.holdings.replayAfter).map(([k, v]) => `${k} ${v}주`).join(", ") || "없음"}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">반영 후보(신규 체결)가 없어 계산하지 않았습니다.</p>
        )}
        {Object.keys(data.impact.priorBrokerResidual).length > 0 && data.impact.newBrokerRegistered && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-xs" data-testid="exec-residual">
            <p className="font-semibold text-amber-700 dark:text-amber-300">이전 증권사의 원장 보유가 이탈 처리되지 않고 남아 있습니다</p>
            <p className="text-muted-foreground mt-0.5">
              {Object.entries(data.impact.priorBrokerResidual).map(([k, v]) => `${k} ${v}주`).join(", ")} — 이 상태로 한국투자 매수만 더하면 같은 보유가 이중 계산됩니다.
              이전 증권사의 매도 체결 또는 실물 이전 증거가 필요하며, 앱은 가상의 매도 내역을 만들지 않습니다.
            </p>
          </div>
        )}
      </div>

      {/* 원장 반영 (Phase 4-C-2): 서버가 반영 판정을 보냈으면 승인 섹션, 아니면 이전처럼 닫힌 상태 */}
      {data.apply ? (
        <KisLedgerApplySection apply={data.apply} range={range} onApply={onApply} />
      ) : (
        <div className="rounded-lg border p-3 space-y-2" data-testid="exec-approval">
          <Button size="sm" disabled className="w-full sm:w-auto" data-testid="exec-approve-button">
            원장에 반영 (사용할 수 없음)
          </Button>
          <ul className="space-y-0.5">
            {data.approval.blockers.map((b) => (
              <li key={b.code} className="text-xs text-muted-foreground" data-testid="exec-blocker">• {b.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Outcome({ outcome, range, onApply }: { outcome: ExecRequestOutcome; range: { start: string; end: string }; onApply?: (req: ApplyRequest) => Promise<ApplyOutcome> }) {
  if (outcome.kind === "response") {
    const d = outcome.data;
    if (d.state === "ok") return <Results data={d} range={range} onApply={onApply} />;
    if (d.state === "gate_blocked") {
      return <p className="text-xs text-amber-700 dark:text-amber-300" role="status" data-testid="exec-gate">{GATE_TEXT[d.reason] ?? "계좌 설정 때문에 조회하지 않았습니다."}</p>;
    }
    if (d.state === "ledger_unavailable") {
      return <p className="text-xs text-amber-700 dark:text-amber-300" role="status" data-testid="exec-ledger-unavailable">원장 저장소를 읽을 수 없어 대조할 수 없습니다. 아무것도 표시하지 않았습니다.</p>;
    }
    return (
      <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs space-y-0.5" role="alert" data-testid="exec-failed">
        <p className="font-semibold text-rose-700 dark:text-rose-300">조회에 실패했습니다 — {FAILURE_TEXT[d.failure.kind]}</p>
        {d.failure.msg1 && <p className="text-muted-foreground break-words">증권사 메시지: {d.failure.msg1}</p>}
        <p className="text-muted-foreground">자동으로 다시 시도하지 않았고 아무것도 기록하지 않았습니다. 원인을 확인한 뒤 직접 다시 조회하세요. 실패는 ‘체결 0건’이 아닙니다.</p>
      </div>
    );
  }
  const msg: Record<Exclude<ExecRequestOutcome["kind"], "response">, string> = {
    not_configured: "서버에 한국투자 계좌 조회 설정이 없어 조회할 수 없습니다. 이 기능을 쓰지 않는 한 기존 기능에는 영향이 없습니다.",
    forbidden: "이 프로필에는 한국투자 계좌 조회 권한이 없습니다.",
    unauthorized: "로그인이 만료됐습니다. 다시 로그인한 뒤 조회하세요.",
    bad_request: "요청이 거부됐습니다. 날짜를 확인하세요.",
    server_error: "서버 오류로 조회하지 못했습니다. 아무것도 기록하지 않았습니다.",
    network_error: "네트워크 문제로 조회하지 못했습니다. 아무것도 기록하지 않았습니다.",
    timeout: "응답 시간이 초과됐습니다. 아무것도 기록하지 않았습니다.",
  };
  const text = outcome.kind === "bad_request" ? `${msg.bad_request} (${outcome.message})` : msg[outcome.kind];
  return <p className="text-xs text-rose-600 dark:text-rose-400" role="alert" data-testid="exec-error">{text}</p>;
}

export function KisExecutionImportPanel({ registry, today, request, onResult, onApply }: KisExecutionImportPanelProps) {
  const gate = useMemo(() => kisApiQueryGate(registry, "pension", today, "22"), [registry, today]);
  const kisStart = useMemo(
    () => registry.find((i) => i.logicalAccountType === "pension" && i.broker === "kis" && i.productCode === "22")?.activeFrom ?? "",
    [registry],
  );
  const [start, setStart] = useState(kisStart);
  const [end, setEnd] = useState(today);
  const [view, setView] = useState<View>({ phase: "idle" });
  const busy = useRef(false);

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end && end <= today;
  const span = dateOk ? (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 : 0;
  const spanOk = dateOk && span <= 93;
  const canQuery = gate.allowed && spanOk && view.phase !== "loading";

  async function run() {
    if (busy.current || !canQuery) return;
    busy.current = true;
    setView({ phase: "loading" });
    try {
      // 실패해도 다시 시도하지 않는다 — 결과 종류만 보여준다.
      const outcome = await request({ start, end });
      setView({ phase: "done", outcome, range: { start, end } });
      onResult?.(outcome);
    } finally {
      busy.current = false;
    }
  }

  return (
    <Card className="p-4 md:p-5 space-y-3" data-testid="kis-exec-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="w-4 h-4 text-muted-foreground shrink-0" />
        <h3 className="font-semibold text-sm">한국투자 체결내역 가져오기</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">연금저축(22) · 조회 전용</span>
      </div>

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs flex gap-2" data-testid="exec-disclaimer">
        <ShieldCheck className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
        <p className="text-muted-foreground">
          증권사에서 조회한 <b>실제 체결 실적</b>입니다. FolioLab의 리밸런싱 완료 기록과는 별개이며, 이 화면은
          원장·장부·리밸런싱 기록에 <b>아무것도 저장하지 않습니다.</b> 조회는 [조회]를 누를 때만 일어납니다.
        </p>
      </div>

      {!gate.allowed && (
        <p className="text-xs text-amber-700 dark:text-amber-300 flex gap-1.5" role="status" data-testid="exec-gate-local">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{GATE_TEXT[gate.reason] ?? "조회할 수 없는 설정입니다."}</span>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground space-y-1 block w-full sm:w-auto">
          <span>조회 시작일</span>
          <Input type="date" value={start} max={today} onChange={(e) => setStart(e.target.value)} className="w-full sm:w-44" data-testid="exec-start" />
        </label>
        <label className="text-xs text-muted-foreground space-y-1 block w-full sm:w-auto">
          <span>조회 종료일</span>
          <Input type="date" value={end} max={today} onChange={(e) => setEnd(e.target.value)} className="w-full sm:w-44" data-testid="exec-end" />
        </label>
        <Button size="sm" disabled={!canQuery} onClick={() => void run()} className="w-full sm:w-auto" data-testid="exec-query-button">
          {view.phase === "loading" ? "조회 중…" : "조회 (읽기 전용)"}
        </Button>
      </div>
      {gate.allowed && !spanOk && (start !== "" || end !== "") && (
        <p className="text-xs text-rose-600 dark:text-rose-400" data-testid="exec-date-error">
          {dateOk ? "조회 기간은 93일 이내여야 합니다." : "시작일·종료일을 확인하세요(시작일 ≤ 종료일 ≤ 오늘)."}
        </p>
      )}

      {view.phase === "idle" && gate.allowed && (
        <p className="text-xs text-muted-foreground" data-testid="exec-idle">기간을 고르고 조회하면 한국투자 연금저축의 체결 내역이 여기에 표시됩니다.</p>
      )}
      {view.phase === "loading" && <p className="text-xs text-muted-foreground" role="status" data-testid="exec-loading">증권사에서 조회하는 중입니다…</p>}
      {view.phase === "done" && <Outcome outcome={view.outcome} range={view.range} onApply={onApply} />}
    </Card>
  );
}
