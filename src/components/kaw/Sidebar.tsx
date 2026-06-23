import { useEffect, useState } from "react";
import { LayoutDashboard, Building2, PiggyBank, TrendingUp, Briefcase, Settings, Wallet, Sun, X, LogOut, RefreshCw, Users, Cloud, CloudOff } from "lucide-react";
import { usePortfolioStore, syncNow } from "@/lib/kaw/store";
import { type FamilyData } from "@/lib/kaw/auth";

export type Page = "dashboard" | "retirement" | "isa" | "pension" | "irp" | "settings";

const DEPLOY_DATE = "2026.06.23 19:22";

const NAV = [
  { id: "dashboard"  as Page, label: "대시보드",    icon: LayoutDashboard, color: "text-violet-500" },
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

export function Sidebar({ active, onNavigate, mobileOpen = false, onMobileClose }: Props) {
  const { familyCode, currentUser, dbLoading, dbError, hasSupabase, deactivateProfile, logoutCode } = usePortfolioStore();

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
        </div>
        <button
          onClick={() => { deactivateProfile(); onMobileClose?.(); }}
          className="w-full mt-1.5 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
        >
          <Users className="w-3.5 h-3.5" /> 프로필 전환
        </button>
      </div>

      {/* 메뉴 */}
      <nav className="flex-1 px-2 py-3 overflow-y-auto sidebar-scroll">
        {/* 대시보드 */}
        {NAV.slice(0, 1).map(({ id, label, icon: Icon, color }) => {
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
          {NAV.slice(1).map(({ id, label, icon: Icon, color }) => {
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

      {/* 동기화 상태 + 수동 동기화 버튼 */}
      {familyCode && (
        <div className="mx-2 mb-1 space-y-1">
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
          </div>
          {hasSupabase && (
            <button
              onClick={() => syncNow()}
              disabled={dbLoading}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all
                bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 active:bg-violet-500/30
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${dbLoading ? "animate-spin" : ""}`} />
              {dbLoading ? "동기화 중…" : "지금 동기화"}
            </button>
          )}
        </div>
      )}

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

        <p className="px-3 pt-1 text-[10px] text-muted-foreground/50 text-center">
          최근배포일: {DEPLOY_DATE}
        </p>
      </div>
    </aside>
  );
}
