import { useEffect, useState } from "react";
import { LayoutDashboard, Building2, PiggyBank, TrendingUp, Briefcase, Settings, Wallet, Sun, X, LogOut, RefreshCw, Users, Cloud, CloudOff, Wifi, WifiOff, Info, GitCompare } from "lucide-react";
import { usePortfolioStore, syncNow, getOrDefaultLibrary, formatKRW } from "@/lib/kaw/store";
import { type FamilyData } from "@/lib/kaw/auth";
import { useKisPriceContext, type TickerMeta } from "@/lib/kaw/KisPriceContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export type Page = "dashboard" | "compare" | "retirement" | "isa" | "pension" | "irp" | "settings";

// 빌드 시점에 vite.config.ts가 baking한 실제 커밋 해시/일시 (import.meta.env.VITE_* — build 시점 값이라 항상 정확함)
const BUILD_TIME = (import.meta.env.VITE_BUILD_TIME as string | undefined) ?? "";
const COMMIT_HASH = (import.meta.env.VITE_COMMIT_HASH as string | undefined) ?? "";
export const DEPLOY_DATE = [BUILD_TIME, COMMIT_HASH].filter(Boolean).join(" · ");

const NAV = [
  { id: "dashboard"  as Page, label: "대시보드",    icon: LayoutDashboard, color: "text-violet-500" },
  { id: "compare"    as Page, label: "지수비교",    icon: GitCompare,      color: "text-cyan-500" },
  { id: "retirement" as Page, label: "퇴직연금",    icon: Building2,       color: "text-blue-500" },
  { id: "isa"        as Page, label: "ISA계좌",     icon: PiggyBank,       color: "text-emerald-500" },
  { id: "pension"    as Page, label: "연금저축펀드", icon: TrendingUp,     color: "text-amber-500" },
  { id: "irp"        as Page, label: "IRP계좌",     icon: Briefcase,       color: "text-rose-500" },
];

interface Props {
  active: Page;
  onNavigate: (p: Page) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  familyData?: FamilyData | null;
  onFamilyUpdate?: (fd: FamilyData) => void;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

function PriceDetailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { prices, meta, totalCount, retryingTickers, refetchSingleTicker } = useKisPriceContext();
  const { state } = usePortfolioStore();
  const library = getOrDefaultLibrary(state);
  const allTickers = [...new Set(
    library.map((d) => d.ticker).filter((t): t is string => typeof t === "string" && t.length === 6),
  )];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">실시간 주가 연동 현황</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-1 pr-2">
            {totalCount === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">종목 없음</p>
            ) : allTickers.map((ticker) => {
              const def = library.find((d) => d.ticker === ticker);
              const m: TickerMeta | undefined = meta[ticker];
              const price = prices[ticker] ?? 0;
              const isFirstLoad = !m && Object.keys(meta).length === 0;
              const source = m?.source;
              const isRetrying = retryingTickers.has(ticker);
              // 재시도 버튼 표시 조건: KIS 실패(Naver fallback) 또는 에러
              const showRetry = !isFirstLoad && (source === "naver" || source === "failed");
              const srcLabel = isFirstLoad ? "—" : source === "kis" ? "KIS" : source === "naver" ? "네이버" : "실패";
              const srcColor = isFirstLoad ? "text-muted-foreground" : source === "kis" ? "text-blue-500" : source === "naver" ? "text-amber-500" : "text-rose-500";
              return (
                <div key={ticker} className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold truncate">{def?.defaultEtf ?? def?.label ?? ticker}</p>
                      <p className="text-[10px] text-muted-foreground">{def?.label ?? ""} · <span className="font-mono">{ticker}</span></p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className="text-xs font-semibold tabular-nums">
                          {price > 0 ? `₩${formatKRW(price)}` : "—"}
                        </p>
                        <p className={`text-[10px] font-medium ${srcColor}`}>{srcLabel}</p>
                      </div>
                      {showRetry && (
                        <button
                          onClick={() => refetchSingleTicker(ticker)}
                          disabled={isRetrying}
                          className="p-1.5 rounded-lg hover:bg-muted transition-colors border border-border/50"
                          title="KIS 재시도"
                        >
                          <RefreshCw className={`w-3 h-3 ${isRetrying ? "animate-spin text-violet-500" : "text-muted-foreground"}`} />
                        </button>
                      )}
                    </div>
                  </div>
                  {m && (
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-muted-foreground">{fmtTime(m.timestamp)}</p>
                      {m.source === "failed" && m.error && (
                        <p className="text-[10px] text-rose-500 truncate max-w-[60%] text-right" title={m.error}>{m.error}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export function Sidebar({ active, onNavigate, mobileOpen = false, onMobileClose }: Props) {
  const { familyCode, currentUser, dbLoading, dbError, hasSupabase, deactivateProfile, logoutCode } = usePortfolioStore();
  const { successCount, totalCount, configured, isLoading: priceLoading } = useKisPriceContext();
  const [priceDetailOpen, setPriceDetailOpen] = useState(false);

  const [dark, setDark] = useState(() => {
    if (typeof document === "undefined") return true;
    if (!localStorage.getItem("kaw.theme")) return true;
    return document.documentElement.classList.contains("dark");
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("kaw.theme", dark ? "dark" : "light");
  }, [dark]);

  const USER_LABELS: Record<string, string> = { hyeobi: "혀비", dayoung: "다영" };
  const profileLabel = currentUser ? (USER_LABELS[currentUser] ?? currentUser) : "—";

  return (
    <aside className={[
      "w-56 shrink-0 border-r bg-card flex flex-col h-screen shadow-sm",
      "transition-transform duration-200 ease-in-out",
      "fixed left-0 top-0 z-50",
      "md:sticky md:translate-x-0 md:z-auto",
      mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
    ].join(" ")}>

      {/* 로고 */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-blue-500 text-white grid place-items-center shrink-0 shadow">
          <Wallet className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm leading-tight">K-올웨더</p>
          <p className="text-xs text-muted-foreground truncate">포트폴리오 트래커</p>
        </div>
        <button onClick={onMobileClose} className="md:hidden p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 현재 프로필 */}
      <div className="px-3 py-3 border-b">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">현재 프로필</p>
        <div className="flex items-center gap-2 px-2 py-2 rounded-xl bg-gradient-to-r from-violet-500/10 to-blue-500/10 border border-violet-200/50 dark:border-violet-800/50">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-white">{profileLabel.charAt(0)}</span>
          </div>
          <span className="text-sm font-semibold flex-1 truncate">{profileLabel}</span>
          {dbLoading && <RefreshCw className="w-3 h-3 animate-spin text-violet-500 shrink-0" />}
          <button
            onClick={() => { logoutCode(); onMobileClose?.(); }}
            className="p-1.5 rounded-lg hover:bg-rose-500/10 text-muted-foreground hover:text-rose-500 transition-colors shrink-0"
            title="로그아웃"
            aria-label="로그아웃"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        <button
          onClick={() => { deactivateProfile(); onMobileClose?.(); }}
          className="w-full mt-1.5 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
        >
          <Users className="w-3.5 h-3.5" /> 프로필 전환
        </button>
      </div>

      {/* 메뉴 */}
      <nav className="flex-1 px-2 pt-3 pb-1 overflow-y-auto sidebar-scroll">
        {/* 대시보드 + 지수비교 */}
        {NAV.slice(0, 2).map(({ id, label, icon: Icon, color }) => {
          const isActive = active === id;
          return (
            <button key={id} onClick={() => { onNavigate(id); onMobileClose?.(); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? "bg-gradient-to-r from-violet-500/10 to-blue-500/10 text-foreground shadow-sm border border-violet-200/50 dark:border-violet-800/50"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${isActive ? color : ""}`} />
              <span className="truncate">{label}</span>
              {isActive && <span className={`ml-auto w-1.5 h-1.5 rounded-full ${color.replace("text-", "bg-")}`} />}
            </button>
          );
        })}

        {/* 구분선 + 섹션 레이블 */}
        <div className="mx-1 my-3 border-t border-border/60" />
        <p className="px-3 mb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">계좌별 관리</p>

        {/* 계좌 메뉴 */}
        <div className="space-y-0.5">
          {NAV.slice(2).map(({ id, label, icon: Icon, color }) => {
            const isActive = active === id;
            return (
              <button key={id} onClick={() => { onNavigate(id); onMobileClose?.(); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? "bg-gradient-to-r from-violet-500/10 to-blue-500/10 text-foreground shadow-sm border border-violet-200/50 dark:border-violet-800/50"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? color : ""}`} />
                <span className="truncate">{label}</span>
                {isActive && <span className={`ml-auto w-1.5 h-1.5 rounded-full ${color.replace("text-", "bg-")}`} />}
              </button>
            );
          })}
        </div>

      </nav>

      {/* 실시간 주가 + 클라우드 동기화 — 하단 고정 */}
      <div className="mx-2 mb-1 space-y-1">
        {totalCount > 0 && (
          <div className="px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 bg-muted/40">
            {priceLoading && successCount === 0 ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin text-violet-400 shrink-0" />
                <span className="text-muted-foreground flex-1">주가 로딩 중…</span></>
            ) : !configured ? (
              <><WifiOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                <span className="text-rose-500 flex-1 truncate">KIS API 미설정</span></>
            ) : (
              <><Wifi className={`w-3.5 h-3.5 shrink-0 ${successCount === totalCount ? "text-emerald-500" : "text-amber-500"}`} />
                <span className={`flex-1 ${successCount === totalCount ? "text-muted-foreground" : "text-amber-500"}`}>
                  실시간 주가 {successCount}/{totalCount}
                </span></>
            )}
            <button
              onClick={() => setPriceDetailOpen(true)}
              className="ml-auto shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
              title="상세 보기"
            >
              <Info className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
        )}
        {familyCode && (
          <div className="px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 bg-muted/40">
            {dbError ? (
              <><CloudOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                <span className="text-rose-500 flex-1 truncate" title={dbError}>동기화 오류</span></>
            ) : dbLoading ? (
              <><RefreshCw className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />
                <span className="text-muted-foreground flex-1">동기화 중…</span></>
            ) : hasSupabase ? (
              <><Cloud className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="text-muted-foreground flex-1">클라우드 동기화</span></>
            ) : (
              <><CloudOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span className="text-amber-500 flex-1">로컬 전용</span></>
            )}
            {hasSupabase && (
              <button
                onClick={() => syncNow()}
                disabled={dbLoading}
                className="ml-auto shrink-0 p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="지금 동기화"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${dbLoading ? "animate-spin text-violet-400" : "text-muted-foreground"}`} />
              </button>
            )}
          </div>
        )}
      </div>
      <PriceDetailDialog open={priceDetailOpen} onClose={() => setPriceDetailOpen(false)} />

      {/* 하단 */}
      <div className="px-2 py-3 border-t space-y-0.5">
        <button onClick={() => { onNavigate("settings"); onMobileClose?.(); }}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
            active === "settings"
              ? "bg-gradient-to-r from-violet-500/10 to-blue-500/10 text-foreground shadow-sm border border-violet-200/50 dark:border-violet-800/50"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Settings className={`w-4 h-4 shrink-0 ${active === "settings" ? "text-slate-500" : ""}`} />
          <span className="truncate">설정</span>
          {active === "settings" && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-slate-500" />}
        </button>

        <button
          onClick={() => setDark(!dark)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
        >
          <Sun className={`w-4 h-4 shrink-0 ${!dark ? "text-amber-400" : ""}`} />
          <span>라이트 모드</span>
          <div className={`ml-auto w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${!dark ? "bg-violet-500" : "bg-muted-foreground/30"}`}>
            <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${!dark ? "translate-x-4" : "translate-x-0"}`} />
          </div>
        </button>

        <button
          onClick={() => { logoutCode(); onMobileClose?.(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 transition-all"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          <span>로그아웃</span>
        </button>

        <p className="hidden md:block px-3 pt-1 text-[10px] text-muted-foreground/50 text-center">
          최근배포일: {DEPLOY_DATE}
        </p>
      </div>
    </aside>
  );
}
