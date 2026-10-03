import { useMemo, useState, useEffect, useCallback } from "react";
import { ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS, ACCOUNT_LABELS, ACCOUNT_LABELS_SHORT, MIN_SAFE_ASSET_PCT, type AccountId, type AssetKey } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct, getOrDefaultLibrary, type HistoryEntry } from "@/lib/kaw/store";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { Plus, Trash2, ChevronDown, ChevronRight, Save, Pencil, RefreshCw, Wifi, WifiOff, Zap, History, CalendarIcon, ShieldAlert, Banknote, Check } from "lucide-react";
import { toast } from "sonner";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import { syncGrowthBacktest } from "@/lib/kaw/backtest";
import { checkSafeAssetMinimum, checkSafeAssetValueLimit, MAX_RISK_ASSET_PCT } from "@/lib/kaw/safeAsset";
import {
  pendingContributions,
  type PendingContribution,
} from "@/lib/kaw/contribution";

// YYYY-MM-DD 문자열 ↔ Date 변환 (로컬 자정 기준 — UTC 파싱으로 하루 밀리는 것 방지)
function ymdToDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function dateToYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

// ── 정기납입 입금 확인 ────────────────────────────────────────────────────
// 스케줄은 "예정"이고 cashflow 는 "실제 발생"이다. 날짜가 됐다고 자동 확정하지 않는 이유:
// cashBalance 는 증권사에서 자동으로 가져오는 값이 아니라 사용자가 관리하는 값이라서,
// 자동이체 실패나 금액 변경 같은 예외에서 장부가 조용히 틀어진다. 그래서 버튼 1회로 둔다.
function ContributionConfirmDialog({ pending, label, timing, onConfirm, onClose }: {
  pending: PendingContribution | null;
  label: string;
  timing: "same_day" | "after_close";
  onConfirm: (args: { period: string; amount: number; applyGoingForward: boolean }) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(0);
  const [applyGoingForward, setApplyGoingForward] = useState(false);

  useEffect(() => {
    if (pending) { setAmount(pending.expectedAmount); setApplyGoingForward(false); }
  }, [pending]);

  if (!pending) return null;
  const changed = amount !== pending.expectedAmount;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">
            {pending.period.replace("-", ".")} {label} 정기납입 확인
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">실제 입금액 (원)</label>
            <NumberInput value={amount} onChange={setAmount} className="mt-1 font-semibold" />
            <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
              예정 {formatKRW(pending.expectedAmount)}원 · 예정일 {pending.scheduledOn}
            </p>
          </div>

          {timing === "after_close" && (
            <p className="text-[11px] text-muted-foreground rounded-lg bg-muted/50 px-2.5 py-2">
              입금일은 <span className="font-medium tabular-nums">{pending.scheduledOn}</span> 그대로 기록합니다.
              다만 그 날 장마감 후에 들어온 돈이라 기간 성과에서는
              {" "}{pending.scheduledOn.slice(5).replace("-", "/")}까지의 구간이 아니라
              그 다음 구간부터 반영됩니다(다음 거래일부터 매수 가능).
            </p>
          )}

          {changed && amount > 0 && (
            <label className="flex items-start gap-2 text-xs cursor-pointer rounded-lg border px-2.5 py-2">
              <input
                type="checkbox"
                checked={applyGoingForward}
                onChange={(e) => setApplyGoingForward(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                앞으로도 이 금액을 사용
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  {pending.period.replace("-", ".")}부터 적용되는 새 금액 버전을 추가합니다.
                  과거 금액은 그대로 보존됩니다.
                </span>
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button
            disabled={!(amount > 0)}
            onClick={() => onConfirm({ period: pending.period, amount, applyGoingForward })}
          >
            <Check className="w-4 h-4 mr-1" /> 입금 확인
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 콤마 포맷 숫자 입력 — null=비포커스(콤마표시), string=포커스(raw 숫자)
function NumberInput({ value, onChange, className, placeholder }: {
  value: number; onChange: (v: number) => void; className?: string; placeholder?: string;
}) {
  const [rawText, setRawText] = useState<string | null>(null);
  const display = rawText !== null ? rawText : (value > 0 ? formatKRW(value) : "");
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={display}
      placeholder={placeholder}
      className={className}
      onFocus={() => setRawText(value > 0 ? String(value) : "")}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, "");
        setRawText(digits);
        onChange(parseInt(digits, 10) || 0);
      }}
      onBlur={() => setRawText(null)}
    />
  );
}

// 보유수량 입력 — type="number"에 값을 숫자로 직접 바인딩하면 키 입력마다 커서가 맨 끝으로 튀어
// "0이 먼저 입력되는" 것처럼 보이는 문제가 있었고, 게다가 매 키 입력마다 기준금액(전체 합계)이 즉시
// 재계산되면서 아직 손대지 않은 다른 종목들의 추가매수 숫자까지 같이 흔들렸음. 이제 타이핑 중엔 로컬
// 문자열만 갱신하고, 입력을 마치고 포커스를 벗어날 때 한 번에 커밋해서 다른 행에 영향을 안 주게 한다.
function QuantityInput({ value, onChange, className }: {
  value: number; onChange: (v: number) => void; className?: string;
}) {
  const [rawText, setRawText] = useState<string | null>(null);
  const display = rawText !== null ? rawText : (value > 0 ? String(value) : "");
  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      placeholder="0"
      className={className}
      onFocus={() => setRawText(value > 0 ? String(value) : "")}
      onChange={(e) => setRawText(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={() => {
        onChange(Math.max(0, parseInt(rawText ?? "", 10) || 0));
        setRawText(null);
      }}
    />
  );
}

type Tab = "rebalance" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "rebalance", label: "리밸런싱" },
  { id: "history",   label: "히스토리" },
];

export function AccountPage({ accountId }: { accountId: AccountId }) {
  const [tab, setTab] = useState<Tab>("rebalance");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 헤더 + 엑셀 시트탭 */}
      <div className="shrink-0 px-4 md:px-6 pt-4 md:pt-6">
        <h2 className="text-xl md:text-2xl font-bold mb-4 md:mb-5">{ACCOUNT_LABELS[accountId]}</h2>

        <div className="flex items-end">
          <div className="flex-1 border-b border-border" />
          <div className="flex items-end">
            {TABS.map(({ id, label }) => {
              const isActive = tab === id;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={[
                    "px-8 py-2.5 text-sm font-semibold rounded-t-lg border-x border-t transition-all select-none",
                    isActive
                      ? "bg-background text-foreground border-border relative -mb-px pb-3.5 shadow-sm z-10"
                      : "bg-muted/50 text-muted-foreground border-border/50 hover:bg-muted hover:text-foreground ml-0.5",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex-1 border-b border-border" />
        </div>
      </div>

      {/* 탭 콘텐츠 */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6 border-t-0">
        <div className="max-w-5xl mx-auto">
          {tab === "rebalance"
            ? <RebalanceTab key={accountId} accountId={accountId} />
            : <HistoryTab   key={accountId} accountId={accountId} />
          }
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   리밸런싱 탭
───────────────────────────────────────────── */
function RebalanceTab({ accountId }: { accountId: AccountId }) {
  const { state, updateAccount, updateRowHolding, finalizeRebalance, saveAccountQuantities, setHistoryBacktest,
    confirmContributionDeposit } = usePortfolioStore();
  const account = state.accounts[accountId];
  const library = getOrDefaultLibrary(state);

  const profile = account.profile ?? "growth";
  const profileRows = account.profileRows?.[profile] ?? [];
  const profileAlloc = account.profileAllocations?.[profile] ?? {};

  const lastHistory: HistoryEntry | null =
    account.history?.length ? account.history[account.history.length - 1] : null;

  // ── 날짜 모드 (SSR hydration mismatch 방지: 마운트 후에만 과거/미래 판별) ──
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // 리밸런싱 탭에 처음 들어올 때는 항상 오늘 날짜를 기본값으로 — 예전 세션에서 과거/미래로
  // 남겨둔 날짜에 계속 머물러 있지 않도록 마운트 시 한 번만 초기화한다.
  useEffect(() => {
    if (account.rebalanceDate !== today) updateAccount(accountId, { rebalanceDate: today });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 주말이면 직전 금요일로 롤백 (토=6→-1일, 일=0→-2일)
  const lastTradingDay = useMemo(() => {
    const d = new Date();
    const day = d.getDay();
    if (day === 6) d.setDate(d.getDate() - 1);
    if (day === 0) d.setDate(d.getDate() - 2);
    return d.toISOString().slice(0, 10);
  }, []);
  const todayIsNonTrading = today !== lastTradingDay;

  const dateMode = useMemo((): "today" | "past" | "future" => {
    if (!mounted) return "today";
    const rd = account.rebalanceDate;
    if (!rd || rd === today) {
      // 오늘이 주말/비거래일이면 직전 금요일 종가 모드
      return todayIsNonTrading ? "past" : "today";
    }
    return rd < today ? "past" : "future";
  }, [mounted, account.rebalanceDate, today, todayIsNonTrading]);

  // 과거 종가 조회에 사용할 실제 날짜
  // - 오늘이 주말이고 rebalanceDate=오늘(또는 미설정): 직전 금요일
  // - 그 외 과거일: 선택한 날짜 그대로 (서버에서 비거래일 fallback)
  const historyFetchDate = useMemo(() => {
    if (dateMode !== "past") return "";
    const rd = account.rebalanceDate || today;
    if (todayIsNonTrading && (rd === today || !account.rebalanceDate)) return lastTradingDay;
    return rd;
  }, [dateMode, account.rebalanceDate, today, todayIsNonTrading, lastTradingDay]);

  // ── 실시간 모드 상태 ───────────────────────────────────────────────────
  const [liveMode, setLiveMode] = useState(true);
  const [dateOpen, setDateOpen] = useState(false);

  // 보유수량 — store에서 초기화, 변경 시 자동 영속화
  const [quantities, setQuantities] = useState<Record<string, number>>(
    () => account.liveQuantities ?? {},
  );

  // 수량 변경 시 1초 debounce 후 스토어에 저장
  useEffect(() => {
    const timer = setTimeout(() => {
      saveAccountQuantities(accountId, quantities);
    }, 1000);
    return () => clearTimeout(timer);
  }, [quantities, accountId, saveAccountQuantities]);

  // ── 과거 종가 상태 ────────────────────────────────────────────────────
  const [historyPrices, setHistoryPrices] = useState<Record<string, number>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyFetchKey, setHistoryFetchKey] = useState(0);
  const refetchHistoryPrices = useCallback(() => setHistoryFetchKey(k => k + 1), []);

  // ── 기본 rows (rowHoldings 기반) ──────────────────────────────────────
  const rows = useMemo(() => {
    const activeRows = profileRows.map((row) => {
      const def = library.find((d) => d.id === row.assetId);
      const etfName = row.etfName ?? def?.defaultEtf ?? row.assetId;
      const group = def?.group ?? "";
      const label = def?.label ?? row.assetId;
      const alloc = profileAlloc[row.id] ?? 0;
      const legacyValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? ((account.holdings ?? []).find((h) => h.assetKey === row.assetId)?.value ?? 0) : 0;
      const value = account.rowHoldings?.[row.id] ?? legacyValue;
      const prevValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? (lastHistory?.holdings?.[row.assetId as AssetKey] ?? null) : null;
      // ETF명으로 먼저 찾고, 없으면 assetId로 fallback
      const tickerByEtf = library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker;
      const ticker = tickerByEtf ?? def?.ticker ?? "";
      return { rowId: row.id, assetId: row.assetId, etfName, group, label, alloc, value, prevValue, ticker, orphaned: false };
    });

    // 미배정 보유: 투자성향에서 종목 행을 지웠지만 마지막 리밸런싱 시점엔 실제로 보유하고 있던 수량이
    // 남아있는 경우 — 실제로 팔기 전까지는 계속 자산으로 잡아줘야 기준금액에서 조용히 증발하지 않는다.
    // 비중 0으로 잡아서 "전량 매도" 신호(추가매수 칸에 마이너스)가 자연스럽게 뜨게 한다.
    const activeRowIds = new Set(profileRows.map((r) => r.id));
    const orphanedRows = Object.entries(lastHistory?.rowQuantitiesSnap ?? {})
      .filter(([rowId, qty]) => qty > 0 && !activeRowIds.has(rowId))
      .map(([rowId]) => {
        const etfName = lastHistory?.rowEtfSnap?.[rowId] ?? rowId;
        const label = lastHistory?.rowLabelSnap?.[rowId] ?? etfName;
        // rowAssetSnap이 없는(이 필드가 생기기 전에 저장된) 과거 기록은 행 id 규칙(assetId_타임스탬프)에서 유추
        const assetId = lastHistory?.rowAssetSnap?.[rowId] ?? rowId.replace(/_\d+$/, "");
        const def = library.find((d) => d.defaultEtf === etfName) ?? library.find((d) => d.id === assetId);
        const ticker = def?.ticker ?? "";
        return { rowId, assetId, etfName, group: "미배정", label, alloc: 0, value: 0, prevValue: null, ticker, orphaned: true };
      });

    return [...activeRows, ...orphanedRows];
  }, [account, profileRows, profileAlloc, library, lastHistory]);

  const manualTotal = rows.reduce((s, r) => s + r.value, 0);

  // ── 실시간 주가: 전역 KisPriceContext에서 읽기 (로그인 시 선제 로딩)
  const { prices: livePrices, configured, isLoading: priceLoading, refetch: refetchPrices } = useKisPriceContext();

  const tickers = useMemo(() => rows.map(r => r.ticker).filter(Boolean) as string[], [rows]);
  // 배열 대신 문자열 키로 useEffect 의존성 안정화 (배열은 매 렌더마다 새 참조)
  const tickerKey = tickers.join(",");

  // ── 과거 종가 조회 (날짜가 과거일 때만) ──────────────────────────────
  useEffect(() => {
    if (dateMode !== "past" || !liveMode || !tickerKey || !historyFetchDate) {
      if (dateMode !== "past") { setHistoryPrices({}); setHistoryError(false); }
      return;
    }
    const dateStr = historyFetchDate.replace(/-/g, "");
    const tickerArr = tickerKey.split(",");
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(false);
    fetch("/api/naver/history-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers: tickerArr, date: dateStr }),
    })
      .then(r => r.json())
      .then((data: { results?: Record<string, { price: number }> }) => {
        if (cancelled) return;
        if (data.results) {
          const prices: Record<string, number> = {};
          for (const [ticker, result] of Object.entries(data.results)) {
            prices[ticker] = (result as { price: number }).price;
          }
          setHistoryPrices(prices);
          const anyFailed = Object.values(data.results).some(r => (r as { price: number }).price === 0);
          setHistoryError(anyFailed);
        }
      })
      .catch(() => { if (!cancelled) { setHistoryError(true); toast.error("과거 종가 조회에 실패했습니다"); } })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateMode, liveMode, historyFetchDate, tickerKey, historyFetchKey]);

  // KIS API 미설정 시 안내 toast (오늘 날짜 + liveMode 켤 때만)
  useEffect(() => {
    if (dateMode === "today" && liveMode && !configured) {
      toast.error("KIS API 인증 정보가 설정되지 않았습니다. 수동 입력 모드로 유지됩니다.");
    }
  }, [dateMode, liveMode, configured]);

  // 날짜 모드별 유효 가격
  const effectivePrices = dateMode === "past" ? historyPrices : livePrices;
  const isLiveActive = dateMode !== "future" && liveMode
    && (dateMode === "past" ? Object.keys(historyPrices).length > 0 : configured && Object.keys(livePrices).length > 0);

  // ── 실시간/과거 계산 ────────────────────────────────────────────────────
  const liveValueByRow = useMemo((): Record<string, number> => {
    if (!isLiveActive) return {};
    return Object.fromEntries(
      rows.map((r) => {
        const price = r.ticker && effectivePrices[r.ticker] ? effectivePrices[r.ticker] : 0;
        return [r.rowId, (quantities[r.rowId] ?? 0) * price];
      }),
    );
  }, [isLiveActive, effectivePrices, quantities, rows]);

  const liveTotal = isLiveActive
    ? Object.values(liveValueByRow).reduce((s, v) => s + v, 0)
    : manualTotal;

  // 리밸런싱에 "진입한 시점"의 보유금액을 고정해둔다. 이걸 안 하면 종목 하나를 팔거나 사서 수량을
  // 바꿀 때마다 보유금액 합계(liveTotal)가 바뀌고, 그때마다 기준금액도 같이 흔들려서 아직 손도
  // 안 댄 다른 종목들의 목표금액(추가매수/매도)까지 전부 재계산되는 문제가 있었다.
  const [frozenInvested, setFrozenInvested] = useState<number | null>(null);
  useEffect(() => {
    if (isLiveActive) {
      if (frozenInvested === null) setFrozenInvested(liveTotal);
    } else if (frozenInvested !== null) {
      setFrozenInvested(null); // 실시간 모드를 끄면 해제 — 다음에 켤 때 그 시점 값으로 새로 고정
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLiveActive, frozenInvested, liveTotal]);

  // ETF 평가액: 리밸런싱 진입 시점에 고정된 값(아직 고정 전이면 임시로 현재값)
  const investedAtEntry = frozenInvested ?? liveTotal;
  // 실제 예수금 — 증권사 앱에서 보고 직접 입력하는 현금잔액. 영속 저장되며 ETF 가격과 무관하다.
  // (ETF 평가액에서 역산하지 않는다. 역산하면 주가가 움직일 때마다 "현금"이 같이 움직였다.)
  // undefined = 아직 한 번도 입력하지 않음, 0 = 사용자가 입력한 실제 0원. 둘을 구분해서 안내한다.
  // 미입력 상태를 기존 데이터로부터 추정하지 않는다 — 계산에서만 0으로 취급한다.
  const cashEntered = account.cashBalance !== undefined;
  const cashBalance = account.cashBalance ?? 0;
  // 기준금액 = 총자산. 수량 모드: 진입 시점 ETF 평가액 + 실제 예수금 → 수량을 고쳐도 흔들리지 않는다.
  //                  수동 모드: 기존과 동일하게 직접 입력한 baseAmount.
  // 예수금을 고치면 기준금액이 따라 움직이는 건 의도한 동작이다(입력값 정정이므로).
  const effectiveBase = isLiveActive ? investedAtEntry + cashBalance : account.baseAmount;
  // 지금 총자산 = 실시간 ETF 평가액 + 실제 예수금
  const totalAssetValue = liveTotal + cashBalance;

  // ── 정기납입 입금 확인 대기 ────────────────────────────────────────────
  // 예정일이 지났는데 아직 장부에 없는 달만 뜬다. 그 달에 이미 반영된 자동 입금이 있으면
  // (예: 복원된 history 기록) 뜨지 않는다 — 두 번 더하지 않기 위해서다.
  const pendingList = useMemo(
    () => pendingContributions(account.contributionSchedule, account.cashflows, { today }),
    [account.contributionSchedule, account.cashflows, today],
  );
  const [confirmTarget, setConfirmTarget] = useState<PendingContribution | null>(null);

  // 퇴직연금·IRP 비위험자산 최소 30% 검증 (목표비중 기준).
  // rows 를 쓰는 이유: 행에 지정된 ETF명이 들어 있어야 종목코드 분류표로 정확히 찾는다
  // (행 id 가 `kr` 인데 실제 종목은 다른 상품일 수 있다).
  const safeAssetCheck = useMemo(
    () => checkSafeAssetMinimum(
      accountId,
      rows.map((r) => ({ id: r.rowId, assetId: r.assetId, etfName: r.etfName })),
      profileAlloc,
      library,
    ),
    [accountId, rows, profileAlloc, library],
  );

  // 최종 effective rows (target/diff 재계산 포함)
  const effectiveRows = rows.map((r) => {
    const value = isLiveActive ? (liveValueByRow[r.rowId] ?? 0) : r.value;
    const target = (effectiveBase * r.alloc) / 100;
    const diff = target - value;
    const livePrice = isLiveActive && r.ticker ? (effectivePrices[r.ticker] ?? 0) : 0;
    return { ...r, value, target, diff, livePrice };
  });
  const effectiveTotal = effectiveRows.reduce((s, r) => s + r.value, 0);

  // 현재가 기준으로 계산한 "예상" 잔여현금. 실제 체결가/수수료/호가 차이 때문에
  // 증권사 원화예수금과 다를 수 있으므로 완료 단계에서 실제 값을 다시 확인받는다.
  const estimatedRemainingCash = Math.max(0, Math.round(effectiveBase - effectiveTotal));
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalCashBalance, setFinalCashBalance] = useState(0);

  function openFinalizeDialog() {
    setFinalCashBalance(estimatedRemainingCash);
    setFinalizeOpen(true);
  }

  // 퇴직연금·IRP 위험자산 한도(70%) — 목표비중이 아니라 "지금 입력된 수량 x 가격 + 실제 예수금"
  // 기준으로 다시 본다. 정수 주 단위 매매 때문에 목표가 30%여도 실제 결과가 미달할 수 있고,
  // 매수 이후 시장가격 변동만으로도 70%를 넘을 수 있다. 예수금은 위험자산이 아니지만
  // 총자산에는 포함된다.
  //
  // 초과해도 저장을 막지 않는다. 가격 변동으로 한도를 넘긴 경우 즉시 매도 의무가 있는 게
  // 아니라 기존 보유는 유지할 수 있고(추가 매수만 제한), 리밸런싱 화면은 "실제 상태를 기록"
  // 하는 화면이기 때문이다. 경고만 띄운다.
  const riskLimitCheck = useMemo(
    () => checkSafeAssetValueLimit(
      accountId,
      effectiveRows.map((r) => ({ assetId: r.assetId, etfName: r.etfName, value: r.value })),
      // 미입력(undefined)을 그대로 넘긴다 — 0으로 계산하되 결과를 "추정"으로 표시하기 위해
      account.cashBalance,
      library,
    ),
    [accountId, effectiveRows, account.cashBalance, library],
  );

  // ── 리밸런싱 완료 ────────────────────────────────────────────────────────
  function completeRebalance(finalCash: number) {
    // 비중 규칙 위반 여부와 무관하게 실제 완료 상태는 저장한다. 이 화면은 주문 계획이 아니라
    // "실제 체결 후 계좌 상태"를 확정하는 마지막 단계다.
    const holdingsSnap: Partial<Record<AssetKey, number>> = {};
    effectiveRows.forEach((r) => {
      if (r.value > 0 && ASSET_ORDER.includes(r.assetId as AssetKey)) {
        const k = r.assetId as AssetKey;
        holdingsSnap[k] = (holdingsSnap[k] ?? 0) + r.value;
      }
    });

    const rowHoldingsSnap = Object.fromEntries(effectiveRows.map((r) => [r.rowId, r.value]));
    const entryBase = {
      id: crypto.randomUUID(),
      date: account.rebalanceDate,
      baseAmount: effectiveBase,
      totalValue: effectiveTotal,
      deposit: account.deposit,
      holdings: holdingsSnap,
      rowEtfSnap: Object.fromEntries(effectiveRows.map((r) => [r.rowId, r.etfName])),
      rowLabelSnap: Object.fromEntries(effectiveRows.map((r) => [r.rowId, r.label])),
      rowAssetSnap: Object.fromEntries(effectiveRows.map((r) => [r.rowId, r.assetId])),
    };

    finalizeRebalance(accountId, {
      cashBalance: finalCash,
      quantities: { ...quantities },
      rowHoldings: rowHoldingsSnap,
      entry: entryBase,
    });

    setFinalizeOpen(false);
    toast.success(`리밸런싱 완료 · 예수금 ${formatKRW(finalCash)}원 반영`);
    setFrozenInvested(null);

    // 성장형 백테스트도 "완료된 실제 상태"와 같은 히스토리 시점에 저장한다.
    const backtestEntry: HistoryEntry = {
      ...entryBase,
      cashBalance: finalCash,
      rowHoldingsSnap,
      rowQuantitiesSnap: { ...quantities },
      returnPct: null,
    };
    syncGrowthBacktest([...account.history, backtestEntry])
      .then((result) => setHistoryBacktest(accountId, result))
      .catch(() => { /* 실패해도 무시 — 지수비교 메뉴에서 다시 시도됨 */ });
  }

  const colCount = 7 + (isLiveActive ? 1 : 0);

  return (
    <div className="space-y-5">
      {/* 이전 리밸런싱 요약 */}
      {lastHistory && (
        <Card className="p-4 bg-muted/30 border-dashed">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">이전 리밸런싱</p>
          <div className="grid grid-cols-3 gap-4">
            <div><p className="text-xs text-muted-foreground">일자</p><p className="font-semibold text-sm">{lastHistory.date}</p></div>
            <div><p className="text-xs text-muted-foreground">기준금액</p><p className="font-semibold text-sm tabular-nums">{formatKRW(lastHistory.baseAmount)}원</p></div>
            <div><p className="text-xs text-muted-foreground">평가금액</p><p className="font-semibold text-sm tabular-nums">{formatKRW(lastHistory.totalValue)}원</p></div>
          </div>
          {lastHistory.returnPct !== null && (
            <div className="mt-2 pt-2 border-t flex items-center gap-2">
              <span className="text-xs text-muted-foreground">전월 대비</span>
              <span className={`text-sm font-bold ${lastHistory.returnPct >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                {formatPct(lastHistory.returnPct)}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* 이번 리밸런싱 */}
      <Card className="p-5 space-y-4">
        {/* 헤더: 타이틀 + 모드 토글 */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">이번 리밸런싱</p>
          <div className="flex items-center gap-2">
            {/* 오늘 날짜만: 실시간 새로고침 버튼 */}
            {liveMode && dateMode === "today" && (
              <button
                onClick={() => refetchPrices()}
                disabled={priceLoading}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-violet-500 transition-colors"
                title="주가 수동 갱신"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${priceLoading ? "animate-spin" : ""}`} />
              </button>
            )}
            {/* 연결 상태 표시 */}
            {liveMode && dateMode === "today" && (
              <span className={`flex items-center gap-1 text-[10px] font-medium ${isLiveActive ? "text-emerald-500" : "text-amber-500"}`}>
                {isLiveActive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {isLiveActive ? "실시간 연결" : "연결 안 됨"}
              </span>
            )}
            {/* 과거 날짜: 종가 조회 상태 플래그 */}
            {liveMode && dateMode === "past" && (
              <span className={`flex items-center gap-1 text-[10px] font-medium ${
                historyLoading ? "text-muted-foreground" :
                historyError ? "text-amber-500" :
                isLiveActive ? "text-emerald-500" : "text-muted-foreground"
              }`}>
                {historyLoading
                  ? <><RefreshCw className="w-3 h-3 animate-spin" /> 조회 중</>
                  : historyError
                    ? <><WifiOff className="w-3 h-3" /> 일부 실패</>
                    : isLiveActive
                      ? <><Wifi className="w-3 h-3" /> {todayIsNonTrading && historyFetchDate === lastTradingDay ? `${lastTradingDay} 종가` : "종가 조회됨"}</>
                      : <><WifiOff className="w-3 h-3" /> 대기 중</>
                }
              </span>
            )}
            {/* 토글 */}
            {dateMode !== "future" && (
              <div className="flex items-center gap-1.5">
                {dateMode === "past"
                  ? <History className={`w-3.5 h-3.5 ${liveMode ? "text-violet-500" : "text-muted-foreground"}`} />
                  : <Zap className={`w-3.5 h-3.5 ${liveMode ? "text-violet-500" : "text-muted-foreground"}`} />
                }
                <span className="text-xs font-medium text-muted-foreground">
                  {dateMode === "past"
                    ? (todayIsNonTrading && historyFetchDate === lastTradingDay ? "최근 장 종가 계산" : "과거일 종가 계산")
                    : "실시간 주가 계산"}
                </span>
                <Switch
                  checked={liveMode}
                  onCheckedChange={(v) => {
                    setLiveMode(v);
                    if (v) {
                      if (dateMode === "past") {
                        toast.success("과거일 종가 계산 활성화 — 보유수량을 입력해 주세요");
                        setHistoryFetchKey(k => k + 1);
                      } else {
                        toast.success("실시간 모드 활성화 — 보유수량을 입력해 주세요");
                      }
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
        {/* 미래 날짜 경고 */}
        {dateMode === "future" && (
          <p className="text-xs text-amber-500 font-medium">선택한 날짜가 미래입니다. 리밸런싱을 저장할 수 없습니다.</p>
        )}

        {/* 정기납입 입금 확인 — 입금과 리밸런싱은 독립된 이벤트다. 여기서 확인한 입금만
            cashflow 장부(= 누적 납입원금)에 들어간다. 리밸런싱 저장은 장부를 건드리지 않는다. */}
        {pendingList.map((pc) => (
          <div key={pc.period} className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-3 flex items-start gap-3">
            <Banknote className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-bold text-blue-600 dark:text-blue-400">
                {pc.period.replace("-", ".")} {ACCOUNT_LABELS_SHORT[accountId]} 정기납입
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatKRW(pc.expectedAmount)}원 · {pc.scheduledOn.slice(5).replace("-", "/")}
                {pc.timing === "after_close" ? " 저녁 입금" : " 입금"}
              </p>
              {pc.timing === "after_close" && (
                <p className="text-[11px] text-muted-foreground">다음 거래일부터 매수 가능</p>
              )}
            </div>
            <Button size="sm" className="shrink-0" onClick={() => setConfirmTarget(pc)}>
              입금 확인
            </Button>
          </div>
        ))}
        <ContributionConfirmDialog
          pending={confirmTarget}
          label={ACCOUNT_LABELS_SHORT[accountId]}
          timing={account.contributionSchedule?.timing ?? "same_day"}
          onClose={() => setConfirmTarget(null)}
          onConfirm={({ period, amount, applyGoingForward }) => {
            confirmContributionDeposit(accountId, { period, amount, applyGoingForward });
            setConfirmTarget(null);
            toast.success(`${period.replace("-", ".")} 정기납입 ${formatKRW(amount)}원을 장부에 기록했습니다`);
          }}
        />

        {/* 퇴직연금·IRP 안전자산 최소 30% 위반 경고 — 이 목표비중대로 추가매수를 실행하면
            위험자산이 한도(70%)를 넘으므로 저장까지 막는다. 설정에서 비중을 고치면 바로 풀린다. */}
        {safeAssetCheck.violated && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 space-y-1">
            <p className="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              {ACCOUNT_LABELS_SHORT[accountId]} 계좌는 비위험자산 목표비중을 최소 {MIN_SAFE_ASSET_PCT}% 이상 설정해야 합니다.
            </p>
            <p className="text-xs text-rose-600/90 dark:text-rose-400/90 tabular-nums">
              현재 비위험자산 {safeAssetCheck.safePct.toFixed(1)}% · 위험자산 {safeAssetCheck.riskPct.toFixed(1)}%
              (한도 {MAX_RISK_ASSET_PCT}%)
            </p>
            <p className="text-[11px] text-muted-foreground">
              이 목표비중으로 계산된 추가매수를 그대로 실행하면 위험자산 한도를 넘깁니다.
              설정 → 투자성향에서 비위험자산 비중을 올려주세요(현재 상태의 리밸런싱 저장은 그대로 됩니다).
            </p>
          </div>
        )}

        {/* 위험자산 비중 현황 — 경고만 한다. 저장은 항상 허용한다:
            가격 변동으로 한도를 넘긴 경우 즉시 매도 의무가 없고 기존 보유는 유지할 수 있으며,
            이 화면은 실제 상태를 기록하는 곳이기 때문이다.
            예수금 미입력(estimated)이면 확정 판정처럼 보이지 않게 "추정"으로만 표시한다 —
            예수금이 들어오면 총자산이 커져 비중이 내려갈 수 있다. 반대로 "70% 이하 정상" 같은
            확정 판정도 하지 않는다. */}
        {riskLimitCheck.required
          && (riskLimitCheck.exceeded || riskLimitCheck.estimated || riskLimitCheck.unclassifiedValue > 0) && (
          <div className={[
            "rounded-lg border px-4 py-3 space-y-1.5",
            riskLimitCheck.exceeded && !riskLimitCheck.estimated
              ? "border-rose-500/40 bg-rose-500/10"
              : "border-amber-500/40 bg-amber-500/10",
          ].join(" ")}>
            <p className={`text-xs font-bold flex items-center gap-1.5 ${
              riskLimitCheck.exceeded && !riskLimitCheck.estimated
                ? "text-rose-600 dark:text-rose-400"
                : "text-amber-600 dark:text-amber-400"
            }`}>
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              {riskLimitCheck.estimated
                ? `위험자산 추정 비중 ${riskLimitCheck.riskPct.toFixed(1)}%`
                  + (riskLimitCheck.exceeded ? ` — 한도 ${MAX_RISK_ASSET_PCT}% 초과 가능` : ` (한도 ${MAX_RISK_ASSET_PCT}%)`)
                : riskLimitCheck.exceeded
                  ? `실제 위험자산 비중 ${riskLimitCheck.riskPct.toFixed(1)}% — 한도 ${MAX_RISK_ASSET_PCT}% 초과`
                  : `위험자산 비중 ${riskLimitCheck.riskPct.toFixed(1)}% (한도 ${MAX_RISK_ASSET_PCT}%)`}
            </p>
            {riskLimitCheck.estimated && (
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                예수금 미입력 — 0원으로 가정한 임시 계산입니다. 실제 예수금을 입력하면 확정 판정됩니다.
              </p>
            )}
            <p className={`text-xs tabular-nums ${
              riskLimitCheck.exceeded && !riskLimitCheck.estimated
                ? "text-rose-600/90 dark:text-rose-400/90"
                : "text-muted-foreground"
            }`}>
              위험자산 {formatKRW(riskLimitCheck.riskValue)}원
              {" · 비위험자산 "}{formatKRW(riskLimitCheck.safeValue)}원
              {" · 예수금 "}{riskLimitCheck.cashEntered ? `${formatKRW(riskLimitCheck.cashBalance)}원` : "미입력(0 가정)"}
              {" · 총자산 "}{formatKRW(riskLimitCheck.totalAssetValue)}원{riskLimitCheck.estimated ? " (추정)" : ""}
            </p>
            {riskLimitCheck.exceeded && (
              <>
                <p className={`text-[11px] font-medium ${
                  riskLimitCheck.estimated
                    ? "text-amber-600/90 dark:text-amber-400/90"
                    : "text-rose-600/90 dark:text-rose-400/90"
                }`}>
                  추가 위험자산 매수가 제한될 수 있습니다.
                </p>
                <div className="text-[11px] text-muted-foreground space-y-0.5">
                  <p>{MAX_RISK_ASSET_PCT}%로 돌아가려면 둘 중 하나면 됩니다{riskLimitCheck.estimated ? " (예수금 0원 가정 기준)" : ""}:</p>
                  <p>
                    · 위험자산을 <span className="font-semibold tabular-nums">{formatKRW(riskLimitCheck.reduceRiskBy)}원</span> 매도
                    (예수금·비위험자산으로 옮기면 총자산은 그대로)
                  </p>
                  <p>
                    · 또는 비위험자산·예수금을 <span className="font-semibold tabular-nums">{formatKRW(riskLimitCheck.addNonRiskBy)}원</span> 추가
                    (위험자산은 그대로 두고 총자산을 늘리는 방식)
                  </p>
                  <p className="text-muted-foreground/80">
                    가격 변동으로 넘긴 경우 즉시 매도 의무는 없습니다 — 기존 보유는 유지할 수 있고, 이 상태로도 리밸런싱 저장은 됩니다.
                  </p>
                </div>
              </>
            )}
            {riskLimitCheck.unclassifiedValue > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                이 중 {formatKRW(riskLimitCheck.unclassifiedValue)}원은 <span className="font-semibold">퇴직연금 분류 미확인</span>이라
                보수적으로 위험자산으로 계산했습니다. 설정 → 종목 설정에서 지정해 주세요.
              </p>
            )}
          </div>
        )}

        {/* 입력 폼 */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">리밸런싱 일자</label>
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="mt-1 w-full h-9 justify-start text-sm font-normal tabular-nums"
                >
                  <CalendarIcon className="w-3.5 h-3.5 mr-2 text-muted-foreground shrink-0" />
                  {account.rebalanceDate || "날짜 선택"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <DateCalendar
                  mode="single"
                  selected={account.rebalanceDate ? ymdToDate(account.rebalanceDate) : undefined}
                  onSelect={(d) => {
                    if (!d) return;
                    updateAccount(accountId, { rebalanceDate: dateToYmd(d) });
                    setDateOpen(false);
                  }}
                />
                <div className="border-t p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      updateAccount(accountId, { rebalanceDate: today });
                      setDateOpen(false);
                    }}
                  >
                    오늘
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {isLiveActive ? "기준금액 (진입 시 고정)" : "기준금액 (원)"}
            </label>
            {isLiveActive ? (
              <div className="mt-1 h-9 px-3 flex items-center rounded-md border bg-muted/50 text-sm font-semibold tabular-nums text-violet-600 dark:text-violet-400">
                {formatKRW(effectiveBase)}
              </div>
            ) : (
              <NumberInput value={account.baseAmount}
                onChange={(v) => updateAccount(accountId, { baseAmount: v })}
                placeholder="0" className="mt-1 font-semibold" />
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">현재 예수금 (매매 전)</label>
            <NumberInput value={cashBalance}
              onChange={(v) => updateAccount(accountId, { cashBalance: v })}
              placeholder={cashEntered ? "0" : "입력 필요"}
              className={`mt-1 font-semibold ${cashEntered ? "" : "border-amber-500/60"}`} />
            <p className={`text-[10px] mt-1 ${cashEntered ? "text-muted-foreground" : "text-amber-500 font-medium"}`}>
              {cashEntered ? "리밸런싱 시작 전 잔액 · 매매 후 예수금은 완료 단계에서 다시 확인" : "리밸런싱 시작 전 실제 예수금을 입력해주세요"}
            </p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">이번 달 불입액 (원)</label>
            <NumberInput value={account.deposit}
              onChange={(v) => updateAccount(accountId, { deposit: v })}
              placeholder="0" className="mt-1" />
          </div>
        </div>

        {/* 기준금액 자동계산 근거 + 지금 보유금액/예수금 현황 */}
        {isLiveActive && (
          <div className="rounded-lg bg-violet-500/8 border border-violet-500/20 px-4 py-2.5 space-y-2 text-xs">
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-muted-foreground">💡 기준금액(진입 시 고정):</span>
              <span className="tabular-nums font-medium text-emerald-600">
                {dateMode === "past" ? "과거 ETF 평가액" : "ETF 평가액"} {formatKRW(investedAtEntry)}
              </span>
              <span className="text-muted-foreground">+</span>
              <span className={`tabular-nums font-medium ${cashEntered ? "text-blue-600" : "text-amber-500"}`}>
                예수금 {cashEntered ? formatKRW(cashBalance) : "미입력(0으로 계산)"}
              </span>
              <span className="text-muted-foreground">=</span>
              <span className="tabular-nums font-bold text-violet-600">{formatKRW(effectiveBase)}</span>
            </div>
            <div className="flex flex-wrap gap-3 items-center pt-2 border-t border-violet-500/20">
              <span className="text-muted-foreground">📊 지금 총자산:</span>
              <span className="tabular-nums font-medium">ETF 평가금액 {formatKRW(liveTotal)}</span>
              <span className="text-muted-foreground">+</span>
              <span className={`tabular-nums font-medium ${cashBalance < 0 ? "text-rose-500" : "text-blue-600"}`}>
                예수금 {formatKRW(cashBalance)}
              </span>
              <span className="text-muted-foreground">=</span>
              <span className="tabular-nums font-semibold">{formatKRW(totalAssetValue)}</span>
            </div>
            {!cashEntered && (
              <p className="text-[11px] text-amber-500">
                실제 예수금을 입력해주세요. 아직 한 번도 입력하지 않아 0원으로 계산하고 있습니다
                (기존 데이터에서 추정하지 않습니다).
              </p>
            )}
          </div>
        )}

        {/* 자산 테이블 */}
        <div className="rounded-lg border overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="py-2 px-1 sm:px-3 text-xs w-[72px] sm:w-auto">자산</TableHead>
                <TableHead className="hidden md:table-cell">ETF 종목명{isLiveActive && " / 종목코드"}</TableHead>
                <TableHead className="hidden md:table-cell text-right w-12">비중</TableHead>
                <TableHead className="hidden lg:table-cell text-right">기준금액</TableHead>
                <TableHead className="hidden lg:table-cell text-right">이전 평가</TableHead>
                {isLiveActive && (
                  <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">보유수량(주)</TableHead>
                )}
                <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">현재평가</TableHead>
                <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">추가매수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {effectiveRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="text-center text-sm text-muted-foreground py-8">
                    설정 → 투자성향에서 자산을 추가하고 저장하세요.
                  </TableCell>
                </TableRow>
              ) : (
                effectiveRows.map((r) => (
                  <TableRow key={r.rowId} className={r.orphaned ? "hover:bg-muted/30 bg-amber-500/5" : "hover:bg-muted/30"}>
                    {/* 자산 */}
                    <TableCell className="py-2 px-1 sm:px-3">
                      <div className="flex items-center gap-1 text-[10px] sm:text-xs">
                        {r.orphaned ? (
                          <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9px] font-semibold shrink-0">미배정 보유</span>
                        ) : (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ background: GROUP_COLORS[r.group] ?? "#888" }} />
                            <span className="truncate max-w-[52px] sm:max-w-none">{r.group}</span>
                          </>
                        )}
                      </div>
                      <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 leading-tight">{r.label}</div>
                      {r.orphaned && (
                        <div className="text-[9px] text-amber-500 mt-0.5">종목설정에서 삭제됨 · 실제 매도 전까지 자산에 포함</div>
                      )}
                      {/* 모바일: 종목 풀네임 + 종목코드 (데스크탑에선 옆 칸에 따로 나옴) */}
                      <div className="md:hidden mt-0.5 text-[10px] text-foreground/80 leading-tight">{r.etfName}</div>
                      {liveMode && r.ticker && (
                        <div className="md:hidden mt-1 flex items-center gap-1.5">
                          <span className="text-[10px] text-violet-500 tabular-nums font-mono">{r.ticker}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">비중 {r.alloc}%</span>
                        </div>
                      )}
                      {liveMode && !r.ticker && (
                        <span className="md:hidden mt-1 text-[10px] text-amber-500">코드 미설정</span>
                      )}
                    </TableCell>
                    {/* ETF 종목명 + 종목코드 */}
                    <TableCell className="hidden md:table-cell">
                      <span className="text-sm text-muted-foreground leading-tight block">
                        {r.etfName}
                      </span>
                      {liveMode && (
                        <div className="flex items-center gap-2 mt-1">
                          {r.ticker ? (
                            <>
                              <span className="text-[10px] text-violet-500 tabular-nums font-mono bg-violet-500/10 rounded px-1.5 py-0.5">{r.ticker}</span>
                              <span className="text-[10px] text-muted-foreground tabular-nums">비중 {r.alloc}%</span>
                              {r.livePrice > 0 && (
                                <span className="text-[10px] text-emerald-500 tabular-nums">₩{formatKRW(r.livePrice)}</span>
                              )}
                              {r.livePrice === 0 && isLiveActive && (
                                <span className="text-[10px] text-amber-500">조회 실패</span>
                              )}
                            </>
                          ) : (
                            <span className="text-[10px] text-amber-500">설정 → 종목설정에서 코드 입력</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right text-sm tabular-nums">{r.alloc}%</TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm tabular-nums text-muted-foreground">{formatKRW(r.target)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm tabular-nums text-muted-foreground">
                      {r.prevValue != null ? formatKRW(r.prevValue) : "—"}
                    </TableCell>
                    {/* 보유수량 입력 (실시간 모드) */}
                    {isLiveActive && (
                      <TableCell className="text-right py-2 px-1 sm:px-3">
                        <QuantityInput
                          value={quantities[r.rowId] ?? 0}
                          onChange={(qty) => setQuantities((prev) => ({ ...prev, [r.rowId]: qty }))}
                          className="h-7 w-16 text-xs text-right tabular-nums rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-violet-500"
                        />
                      </TableCell>
                    )}
                    {/* 현재 평가금액 */}
                    <TableCell className="text-right py-2 px-1 sm:px-3">
                      {isLiveActive ? (
                        <div className="text-right">
                          <p className="text-xs tabular-nums font-medium text-violet-600 dark:text-violet-400">
                            {formatKRW(r.value)}
                          </p>
                          {r.livePrice > 0 && (
                            <p className="text-[10px] text-muted-foreground tabular-nums">
                              @{formatKRW(r.livePrice)}
                            </p>
                          )}
                        </div>
                      ) : (
                        <NumberInput
                          value={r.value}
                          onChange={(v) => updateRowHolding(accountId, r.rowId, v)}
                          placeholder="0"
                          className="h-7 text-xs text-right tabular-nums w-[5.5rem] sm:w-28"
                        />
                      )}
                    </TableCell>
                    {/* 추가매수 */}
                    <TableCell className="text-right py-2 px-1 sm:px-3">
                      {isLiveActive
                        ? <LiveRebalanceCell diff={r.diff} livePrice={r.livePrice} />
                        : <RebalanceCell diff={r.diff} />
                      }
                    </TableCell>
                  </TableRow>
                ))
              )}
              {/* 합계 행 */}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell className="text-xs sm:text-sm py-2 px-2 sm:px-4">합계</TableCell>
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm">{formatKRW(effectiveBase)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm text-muted-foreground">
                  {lastHistory ? formatKRW(lastHistory.totalValue) : "—"}
                </TableCell>
                {isLiveActive && <TableCell className="text-right tabular-nums text-xs sm:text-sm py-2 px-1 sm:px-4 text-violet-600">
                  {Object.values(quantities).reduce((s, q) => s + q, 0)}주
                </TableCell>}
                <TableCell className={`text-right tabular-nums text-xs sm:text-sm py-2 px-1 sm:px-4 ${isLiveActive ? "text-violet-600 font-bold" : ""}`}>
                  {formatKRW(effectiveTotal)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button
            onClick={openFinalizeDialog}
            disabled={effectiveTotal <= 0 || dateMode === "future"}
          >
            <Check className="w-4 h-4 mr-1.5" /> 리밸런싱 완료
          </Button>
        </div>

        <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base">리밸런싱 완료 확인</DialogTitle>
            </DialogHeader>

            <div className="space-y-3 text-sm">
              <div className="rounded-lg bg-muted/40 border px-3 py-2.5 space-y-1.5">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">리밸런싱 전 총자산</span>
                  <span className="tabular-nums font-medium">{formatKRW(effectiveBase)}원</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">완료 수량 ETF 평가액</span>
                  <span className="tabular-nums font-medium">{formatKRW(effectiveTotal)}원</span>
                </div>
                <div className="flex justify-between gap-3 pt-1 border-t">
                  <span className="text-muted-foreground">현재가 기준 예상 예수금</span>
                  <span className="tabular-nums font-semibold text-violet-600 dark:text-violet-400">
                    {formatKRW(estimatedRemainingCash)}원
                  </span>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium">매매 완료 후 실제 원화예수금</label>
                <NumberInput
                  value={finalCashBalance}
                  onChange={setFinalCashBalance}
                  className="mt-1 font-semibold"
                  placeholder="0"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  예상값은 현재가 기준 참고값입니다. 실제 체결 후 증권사 앱의 원화예수금을 입력해주세요.
                </p>
              </div>

              <div className="flex justify-between gap-3 rounded-lg border px-3 py-2.5">
                <span className="text-muted-foreground">확정 총자산</span>
                <span className="tabular-nums font-bold">{formatKRW(effectiveTotal + finalCashBalance)}원</span>
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setFinalizeOpen(false)}>취소</Button>
              <Button onClick={() => completeRebalance(finalCashBalance)}>
                <Check className="w-4 h-4 mr-1" /> 완료 저장
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────
   히스토리 탭
───────────────────────────────────────────── */
function HistoryTab({ accountId }: { accountId: AccountId }) {
  const { state, addHistory, removeHistory, updateHistory, setHistoryBacktest } = usePortfolioStore();
  const account = state.accounts[accountId];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<HistoryEntry | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualTotal, setManualTotal] = useState("");
  const [manualDeposit, setManualDeposit] = useState("");
  const [chartMode, setChartMode] = useState<"value" | "return">("value");

  function addManual() {
    if (!manualDate || !manualTotal) return;
    const newEntry: Omit<HistoryEntry, "returnPct"> = {
      id: crypto.randomUUID(), date: manualDate,
      baseAmount: parseFloat(manualTotal) || 0,
      totalValue: parseFloat(manualTotal) || 0,
      deposit: parseFloat(manualDeposit) || 0,
    };
    addHistory(accountId, newEntry);
    setManualTotal(""); setManualDeposit("");
    syncGrowthBacktest([...account.history, { ...newEntry, returnPct: null }])
      .then((result) => setHistoryBacktest(accountId, result))
      .catch(() => { /* 실패해도 무시 — 지수비교 메뉴에서 다시 시도됨 */ });
  }

  const safeHistory = account.history ?? [];
  const reversed = [...safeHistory].reverse();
  const returnData = safeHistory.filter(h => h.returnPct !== null);

  return (
    <div className="space-y-5">
      {/* 차트 */}
      {safeHistory.length >= 2 && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">자산 추이</p>
            <div className="flex gap-0.5 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => setChartMode("value")}
                className={`px-3 py-1 text-xs rounded-md transition-all ${chartMode === "value" ? "bg-background shadow text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              >평가금액</button>
              <button
                onClick={() => setChartMode("return")}
                className={`px-3 py-1 text-xs rounded-md transition-all ${chartMode === "return" ? "bg-background shadow text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              >수익률</button>
            </div>
          </div>
          <div className="h-52">
            {chartMode === "value" ? (
              <ResponsiveContainer>
                <LineChart data={safeHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={52} />
                  <Tooltip
                    formatter={(v: number) => [`${formatKRW(v)} 원`, "평가금액"]}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
                  />
                  <Line type="monotone" dataKey="totalValue" name="평가금액"
                    stroke="oklch(0.62 0.18 250)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer>
                <BarChart data={returnData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(1)}%`} width={50} />
                  <Tooltip
                    formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, "수익률"]}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
                  />
                  <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} />
                  <Bar dataKey="returnPct" name="수익률" radius={[3, 3, 0, 0]}>
                    {returnData.map((entry, i) => (
                      <Cell key={i} fill={(entry.returnPct ?? 0) >= 0 ? "oklch(0.65 0.18 140)" : "oklch(0.60 0.18 20)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      )}

      {/* 전체 기록 테이블 */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b">
          <p className="font-semibold">전체 리밸런싱 기록</p>
          <p className="text-xs text-muted-foreground mt-0.5">클릭: 종목별 상세 보기</p>
        </div>

        {reversed.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">기록된 히스토리가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-8" />
                  <TableHead>날짜</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">기준금액</TableHead>
                  <TableHead className="text-right">평가금액</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">불입액</TableHead>
                  <TableHead className="text-right">수익률</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {reversed.map((h) => {
                  const isExpanded = expandedId === h.id;
                  const hasHoldings =
                    (h.holdings && Object.keys(h.holdings).length > 0) ||
                    (h.rowHoldingsSnap && Object.keys(h.rowHoldingsSnap).length > 0);
                  return (
                    <>
                      <TableRow
                        key={h.id}
                        className={`cursor-pointer transition-colors ${
                          isExpanded ? "bg-violet-50/60 dark:bg-violet-900/20" : "hover:bg-muted/30"
                        }`}
                        onClick={() => setExpandedId(isExpanded ? null : h.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {hasHoldings
                            ? isExpanded
                              ? <ChevronDown className="w-4 h-4" />
                              : <ChevronRight className="w-4 h-4" />
                            : <span className="w-4 h-4 block" />
                          }
                        </TableCell>
                        <TableCell className="font-semibold text-sm">{h.date}</TableCell>
                        <TableCell className="hidden sm:table-cell text-right tabular-nums text-sm text-muted-foreground">{formatKRW(h.baseAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm font-medium">{formatKRW(h.totalValue)}</TableCell>
                        <TableCell className="hidden sm:table-cell text-right tabular-nums text-sm text-muted-foreground">{h.deposit ? formatKRW(h.deposit) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {h.returnPct === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className={h.returnPct >= 0 ? "text-emerald-500 font-bold" : "text-rose-500 font-bold"}>
                                {formatPct(h.returnPct)}
                              </span>
                          }
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-0.5">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-violet-500"
                              onClick={() => setEditingEntry({ ...h })}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
                              onClick={() => setPendingDeleteId(h.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {isExpanded && hasHoldings && (
                        <TableRow key={`${h.id}-detail`} className="bg-violet-50/40 dark:bg-violet-900/10">
                          <TableCell colSpan={7} className="p-0">
                            <div className="px-8 py-3">
                              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                                {h.date} 종목별 보유현황
                              </p>
                              {/* 실제 예수금 스냅샷 — 이 필드가 생기기 전의 기록에는 없으므로 있을 때만 보여준다.
                                  과거 기준금액에서 역산하지 않는다(그 값은 예전 계산식의 가상값이라서다). */}
                              {h.cashBalance !== undefined && (
                                <p className="text-xs text-muted-foreground mb-2 tabular-nums">
                                  ETF 평가금액 {formatKRW(h.totalValue)}원
                                  {" + 실제 예수금 "}
                                  <span className="font-semibold text-blue-600 dark:text-blue-400">{formatKRW(h.cashBalance)}원</span>
                                  {" = 총자산 "}
                                  <span className="font-semibold">{formatKRW(h.totalValue + h.cashBalance)}원</span>
                                </p>
                              )}
                              {h.rowHoldingsSnap && Object.keys(h.rowHoldingsSnap).length > 0 ? (
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                  {Object.entries(h.rowHoldingsSnap)
                                    .filter(([, v]) => v > 0)
                                    .map(([rowId, val]) => {
                                      const etfName = h.rowEtfSnap?.[rowId] ?? rowId;
                                      const label = h.rowLabelSnap?.[rowId] ?? rowId;
                                      const qty = h.rowQuantitiesSnap?.[rowId] ?? 0;
                                      return (
                                        <div key={rowId} className="bg-background rounded-lg px-3 py-2 border text-sm">
                                          <p className="text-xs text-muted-foreground truncate">{label}</p>
                                          <p className="text-[10px] text-muted-foreground/60 truncate mb-0.5">{etfName}</p>
                                          {qty > 0 && (
                                            <p className="text-xs text-violet-500 font-medium">{qty}주</p>
                                          )}
                                          <p className="font-semibold tabular-nums">{formatKRW(val)}</p>
                                        </div>
                                      );
                                    })}
                                </div>
                              ) : (
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                                  {ASSET_ORDER.map((k) => {
                                    const val = h.holdings?.[k];
                                    if (val == null) return null;
                                    return (
                                      <div key={k} className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border text-sm">
                                        <span className="w-2 h-2 rounded-full shrink-0"
                                          style={{ background: GROUP_COLORS[ASSET_GROUPS[k].group] }} />
                                        <div className="min-w-0">
                                          <p className="text-xs text-muted-foreground truncate">{ASSET_GROUPS[k].label}</p>
                                          <p className="font-semibold tabular-nums">{formatKRW(val)}</p>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* 과거 데이터 수동 추가 */}
        <div className="px-5 py-4 border-t bg-muted/20">
          <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">과거 데이터 직접 추가</p>
          <div className="grid sm:grid-cols-4 gap-2 items-end">
            <div>
              <label className="text-xs text-muted-foreground">날짜</label>
              <Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} className="h-9 mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">총자산</label>
              <Input type="number" value={manualTotal} onChange={(e) => setManualTotal(e.target.value)} placeholder="0" className="h-9 mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">불입액</label>
              <Input type="number" value={manualDeposit} onChange={(e) => setManualDeposit(e.target.value)} placeholder="0" className="h-9 mt-1" />
            </div>
            <Button onClick={addManual} variant="outline" size="sm" className="h-9">
              <Plus className="w-4 h-4 mr-1" /> 추가
            </Button>
          </div>
        </div>
      </Card>

      {/* 히스토리 수정 다이얼로그 */}
      {editingEntry && (
        <Dialog open onOpenChange={(v) => !v && setEditingEntry(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>히스토리 수정</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">날짜</label>
                <Input type="date" value={editingEntry.date}
                  onChange={(e) => setEditingEntry({ ...editingEntry, date: e.target.value })}
                  className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">기준금액 (원)</label>
                <NumberInput value={editingEntry.baseAmount}
                  onChange={(v) => setEditingEntry({ ...editingEntry, baseAmount: v })}
                  className="mt-1" placeholder="0" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">평가금액 (원)</label>
                <NumberInput value={editingEntry.totalValue}
                  onChange={(v) => setEditingEntry({ ...editingEntry, totalValue: v })}
                  className="mt-1" placeholder="0" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">불입액 (원)</label>
                <NumberInput value={editingEntry.deposit}
                  onChange={(v) => setEditingEntry({ ...editingEntry, deposit: v })}
                  className="mt-1" placeholder="0" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setEditingEntry(null)}>취소</Button>
              <Button size="sm" onClick={() => { updateHistory(accountId, editingEntry); setEditingEntry(null); toast.success("수정됐습니다"); }}>
                <Save className="w-3.5 h-3.5 mr-1" /> 저장
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 히스토리 삭제 confirm */}
      <Dialog open={!!pendingDeleteId} onOpenChange={(v) => !v && setPendingDeleteId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>히스토리 삭제</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">이 항목을 삭제할까요? 되돌릴 수 없습니다.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>취소</Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (pendingDeleteId) removeHistory(accountId, pendingDeleteId);
              setPendingDeleteId(null);
              toast.success("삭제됐습니다");
            }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> 삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RebalanceCell({ diff }: { diff: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground text-xs">—</span>;
  if (diff > 0) return <span className="text-emerald-500 text-xs font-semibold tabular-nums">+{formatKRW(diff)}</span>;
  return <span className="text-rose-500 text-xs font-semibold tabular-nums">{formatKRW(diff)}</span>;
}

function LiveRebalanceCell({ diff, livePrice }: { diff: number; livePrice: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground text-xs">—</span>;

  const isBuy = diff > 0;
  const amount = Math.abs(diff);
  const shares = livePrice > 0 ? Math.floor(amount / livePrice) : 0;
  const actualAmount = shares * livePrice;
  const remainder = amount - actualAmount;
  const color = isBuy ? "text-emerald-500" : "text-rose-500";
  const colorLight = isBuy ? "text-emerald-400" : "text-rose-400";

  return (
    <div className="text-right space-y-0.5">
      <p className={`${color} text-xs font-semibold tabular-nums`}>{isBuy ? "+" : "-"}{formatKRW(amount)}</p>
      {livePrice > 0 && shares > 0 && (
        <p className={`${colorLight} text-[10px] tabular-nums font-medium`}>
          ≈ {shares}주 · {formatKRW(actualAmount)}원
        </p>
      )}
      {livePrice > 0 && remainder > 0 && (
        <p className="text-muted-foreground text-[10px] tabular-nums">잔액 {formatKRW(remainder)}</p>
      )}
      {livePrice > 0 && shares === 0 && (
        <p className="text-amber-500 text-[10px]">1주 미만</p>
      )}
    </div>
  );
}
