import { useMemo, useState } from "react";
import { AlertTriangle, ListChecks, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AccountId } from "@/lib/kaw/constants";
import { formatKRW, usePortfolioStore } from "@/lib/kaw/store";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import { connectionOf } from "@/lib/kaw/broker-connection";
import { requestKisAccount, type KisClientResult } from "@/lib/kaw/kis-account-client";
import { describeKisResult } from "@/lib/kaw/kis-account-view";
import {
  buildBuyOrderPlan,
  defaultStrategy,
  type PlanRow,
  type PriceQuote,
  type Strategy,
} from "@/lib/kaw/buy-order-plan";
import {
  BUDGET_BASIS_TEXT,
  LINE_NOTE_TEXT,
  PRICE_SOURCE_TEXT,
  SCOPE_TEXT,
  STRATEGY_TEXT,
  formatAsOf,
  orderabilityBadge,
  sortedWarnings,
  strategySwitchHint,
} from "@/lib/kaw/buy-order-plan-view";
import { kstDateString } from "@/lib/kaw/snapshot";

const LEVEL_TONE = {
  critical: "text-rose-600 dark:text-rose-400",
  caution: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
} as const;

interface Props {
  accountId: AccountId;
  rows: PlanRow[];
  /** 지금 화면의 보유수량(rowId → 수량). 계산만 제공 모드의 입력이다 */
  quantities: Record<string, number>;
  /** 예수금. 입력한 적이 없으면 null (0 이 아니다) */
  cash: number | null;
  /** 이 화면이 쓰는 가격: 실시간 / 과거 종가 / 없음 */
  priceMode: "live" | "history" | "none";
  prices: Record<string, number>;
  historyDate: string;
}

/**
 * ETF 매수 **주문안 미리보기**. 주문을 보내지 않고 기록도 남기지 않는다 — 화면에서
 * 계산해 보여줄 뿐이다. 기존 리밸런싱 입력·저장 흐름은 건드리지 않는다.
 *
 * API 모드의 실잔고는 **사용자가 누를 때만** 조회한다(자동 호출 없음).
 */
export function BuyOrderPreviewCard({
  accountId, rows, quantities, cash, priceMode, prices, historyDate,
}: Props) {
  const { state } = usePortfolioStore();
  const { meta } = useKisPriceContext();
  const today = kstDateString();
  const connection = useMemo(
    () => connectionOf(state.brokerAccounts ?? [], accountId, today),
    [state.brokerAccounts, accountId, today],
  );
  const apiMode = connection.mode === "api_readonly";

  // null = 자동. 자동이면 계산 모듈이 계좌 상태(보유 확인 여부)로 전략을 정한다 —
  // 이미 ETF 를 가진 연금저축에는 보유 반영, 보유 0 으로 확인된 연금저축에는 신규 매수.
  const [strategyChoice, setStrategyChoice] = useState<Strategy | null>(null);
  const [fetched, setFetched] = useState<KisClientResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (loading) return;
    setLoading(true);
    try {
      // 매수 대상 종목의 매수가능조회를 같이 요청한다(서버가 종목별 지정가로 GET 조회).
      const tickers = rows.filter((r) => r.ticker && r.allocPct > 0 && !r.orphaned).map((r) => r.ticker as string);
      setFetched(await requestKisAccount(state.brokerAccounts ?? [], accountId, today, fetch, tickers));
    } finally {
      setLoading(false);
    }
  }

  const quotes = useMemo(() => {
    const out: Record<string, PriceQuote> = {};
    for (const r of rows) {
      if (!r.ticker) continue;
      const price = prices[r.ticker];
      const ok = typeof price === "number" && price > 0;
      if (priceMode === "history") {
        out[r.ticker] = ok
          ? { price, source: "history", asOf: historyDate || null }
          : { price: null, source: "unavailable", asOf: null };
      } else if (priceMode === "live") {
        const m = meta[r.ticker];
        out[r.ticker] = ok
          ? { price, source: m?.source === "naver" ? "naver" : "kis", asOf: m?.timestamp ?? null }
          : { price: null, source: "unavailable", asOf: m?.timestamp ?? null };
      } else {
        out[r.ticker] = { price: null, source: "unavailable", asOf: null };
      }
    }
    return out;
  }, [rows, prices, priceMode, historyDate, meta]);

  const apiResult = fetched?.kind === "result" ? fetched : null;

  // 증권사가 매수가능금액을 계산한 단가(지정가)를 계획 단가로 쓴다. 그래야 "이 가격에 이
  // 수량을 살 수 있다"가 그 가격의 근거를 갖는다. 검증된 항목이 없는 종목은 화면 시세 그대로다.
  const effectiveQuotes = useMemo(() => {
    const bp = apiResult?.buyingPower;
    if (!bp || bp.entries.length === 0) return quotes;
    const out = { ...quotes };
    for (const e of bp.entries) {
      out[e.ticker] = { price: e.price, source: "kis", asOf: bp.asOf };
    }
    return out;
  }, [apiResult, quotes]);

  const plan = useMemo(() => {
    if (apiMode) {
      if (!apiResult) return null; // 아직 조회하지 않았다 — 계산하지 않는다
      const bp = apiResult.buyingPower;
      return buildBuyOrderPlan(
        rows, effectiveQuotes,
        {
          kind: "kis_api", plan: apiResult.plan, observedAt: apiResult.observation.observedAt,
          // 검증된 항목만 넘긴다. 계획의 단가와 대조하는 것은 계산 모듈의 일이다.
          buyingPower: bp && bp.entries.length ? { asOf: bp.asOf ?? apiResult.observation.observedAt, entries: bp.entries } : null,
        },
        { accountType: accountId, ...(strategyChoice ? { strategy: strategyChoice } : {}) },
      );
    }
    return buildBuyOrderPlan(
      rows, quotes, { kind: "manual", quantities, cash },
      { accountType: accountId, ...(strategyChoice ? { strategy: strategyChoice } : {}) },
    );
  }, [apiMode, apiResult, rows, quotes, effectiveQuotes, quantities, cash, accountId, strategyChoice]);

  const badge = plan ? orderabilityBadge(plan) : null;
  // 이 계좌 상태에 맞지 않는 전략이면 전환을 안내한다. 자동으로 바꾸지 않는다.
  const switchHint = plan ? strategySwitchHint(plan) : null;

  return (
    <Card className="p-4 md:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">ETF 매수 주문안 미리보기</h3>
        </div>
        {badge && (
          <span className={[
            "text-xs px-2 py-0.5 rounded-full border",
            badge.tone === "ok" ? "text-emerald-600 border-emerald-500/40"
              : badge.tone === "warn" ? "text-amber-600 border-amber-500/40"
              : "text-rose-600 border-rose-500/40",
          ].join(" ")}>
            {badge.text}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        계산·미리보기만 합니다. 실제 주문은 전송되지 않고 거래 기록도 만들어지지 않습니다.
        {apiMode ? " 한국투자 API 모드: 아래 버튼을 눌렀을 때만 실잔고를 조회합니다." : " 계산만 제공 모드: 화면에 입력한 수량·예수금을 사용합니다."}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        {accountId === "pension" && (
          <select
            className="text-xs border rounded-md px-2 py-1 bg-background"
            value={plan?.strategy ?? strategyChoice ?? defaultStrategy(accountId)}
            onChange={(e) => setStrategyChoice(e.target.value as Strategy)}
            aria-label="계산 방식"
          >
            {(Object.keys(STRATEGY_TEXT) as Strategy[]).map((s) => (
              <option key={s} value={s}>{STRATEGY_TEXT[s]}</option>
            ))}
          </select>
        )}
        {apiMode && (
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "조회 중…" : "실잔고 불러오기 (읽기 전용)"}
          </Button>
        )}
      </div>

      {apiMode && fetched && fetched.kind !== "result" && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {describeKisResult(fetched).title}: {describeKisResult(fetched).lines.join(" ")}
        </p>
      )}
      {apiMode && !fetched && (
        <p className="text-xs text-muted-foreground">실잔고를 아직 조회하지 않았습니다. 조회 전에는 계산하지 않습니다.</p>
      )}

      {plan && (
        <>
          {plan.blockers.map((b, i) => (
            <p key={`b${i}`} className="text-xs text-rose-600 dark:text-rose-400 flex gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{b.message}
            </p>
          ))}
          {sortedWarnings(plan).map((w, i) => (
            <p key={`w${i}`} className={`text-xs flex gap-1.5 ${LEVEL_TONE[w.level]}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w.message}
            </p>
          ))}

          {plan.status === "ready" && (
            <>
              {/* 이 안이 무엇인지 — 현금 기반 신규 매수는 전체 리밸런싱이 아니다. */}
              <p className="text-xs">
                <span className="text-muted-foreground">종류 </span>
                <span className="font-medium">{SCOPE_TEXT[plan.scope]}</span>
              </p>

              {switchHint && (
                <div className="flex items-start gap-2 flex-wrap text-xs border rounded-md p-2 bg-muted/40">
                  <span className="flex-1 min-w-[12rem]">{switchHint.text}</span>
                  <Button size="sm" variant="outline" onClick={() => setStrategyChoice(switchHint.to)}>
                    {STRATEGY_TEXT[switchHint.to]}(으)로 전환
                  </Button>
                </div>
              )}

              {plan.reliability === "reference_only" && (
                <div
                  role="alert"
                  className="text-xs border border-rose-500/40 rounded-md p-2 bg-rose-500/5 text-rose-700 dark:text-rose-300 space-y-0.5"
                >
                  <p className="font-semibold">참고용 주문안 — 계좌 전체 목표 비중을 정확히 계산하지 못했습니다</p>
                  <p>
                    평가에서 빠진 보유가 있어 실제 비중이 의도와 다를 수 있습니다. 덜 사는 방향이라
                    안전하다고 볼 수 없습니다. 아래 사유를 해소한 뒤 다시 확인하세요.
                  </p>
                  <ul className="list-disc pl-4">
                    {plan.incompleteReasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left py-1.5 pr-2 font-medium">ETF</th>
                      <th className="text-right px-2 font-medium">현재가</th>
                      <th className="text-right px-2 font-medium">보유</th>
                      <th className="text-right px-2 font-medium">목표</th>
                      <th className="text-right px-2 font-medium">매수</th>
                      <th className="text-right pl-2 font-medium">예상금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.lines.map((l) => (
                      <tr key={l.rowId} className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-2">
                          <p className="font-medium">{l.etfName}</p>
                          <p className="text-muted-foreground">{l.targetWeightPct.toFixed(1)}%{l.note ? ` · ${LINE_NOTE_TEXT[l.note]}` : ""}</p>
                        </td>
                        <td className="px-2 text-right tabular-nums">
                          {l.price.price !== null ? formatKRW(l.price.price) : "—"}
                          <p className="text-[10px] text-muted-foreground">
                            {PRICE_SOURCE_TEXT[l.price.source]} · {formatAsOf(l.price.asOf)}
                          </p>
                        </td>
                        <td className="px-2 text-right tabular-nums">{l.currentQty ?? "—"}</td>
                        <td className="px-2 text-right tabular-nums">{l.targetQty ?? "—"}</td>
                        <td className="px-2 text-right tabular-nums font-semibold">{l.buyQty}주</td>
                        <td className="pl-2 text-right tabular-nums">{formatKRW(l.estimatedAmount)}원</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {plan.budget && plan.totals && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">예산 기준</span>
                  <span className="text-right">{BUDGET_BASIS_TEXT[plan.budget.basis]}</span>
                  <span className="text-muted-foreground">예산 금액</span>
                  <span className="text-right tabular-nums">{formatKRW(plan.budget.amount)}원</span>
                  <span className="text-muted-foreground">현금 여유분</span>
                  <span className="text-right tabular-nums">{formatKRW(plan.budget.reserve)}원</span>
                  <span className="text-muted-foreground">매수 합계(예상)</span>
                  <span className="text-right tabular-nums font-semibold">{formatKRW(plan.totals.totalBuyAmount)}원</span>
                  <span className="text-muted-foreground">잔여 예수금(예상)</span>
                  <span className="text-right tabular-nums">{formatKRW(plan.totals.remainingCash)}원</span>
                </div>
              )}

              <div className="text-[11px] text-muted-foreground space-y-0.5 border-t pt-2">
                <p>예수금: {plan.sources.cash.source === "kis_api" ? "한국투자 API" : "직접 입력"} · {formatAsOf(plan.sources.cash.asOf)}</p>
                <p>보유수량: {plan.sources.holdings.source === "kis_api" ? "한국투자 API" : "직접 입력"} · {formatAsOf(plan.sources.holdings.asOf)}</p>
                <p>매수가능금액: {plan.sources.buyingPower.verified ? `한국투자 API · ${formatAsOf(plan.sources.buyingPower.asOf)}` : "확인되지 않음 (예상 주문안)"}</p>
                <p>계산 방식: {STRATEGY_TEXT[plan.strategy]}</p>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}
