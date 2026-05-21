import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, Wallet, RefreshCw } from "lucide-react";
import { Sidebar, type Page } from "@/components/kaw/Sidebar";
import { Dashboard } from "@/components/kaw/Dashboard";
import { AccountPage } from "@/components/kaw/AccountPage";
import { SettingsPage } from "@/components/kaw/SettingsPage";
import { AuthGate } from "@/components/kaw/AuthGate";
import { usePortfolioStore } from "@/lib/kaw/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "K-올웨더 포트폴리오 트래커" },
      { name: "description", content: "K-올웨더 자산 배분 리밸런싱 및 수익률 관리 대시보드" },
    ],
  }),
  component: Index,
});

function Index() {
  const { familyCode, dbLoading } = usePortfolioStore();
  const [page, setPage] = useState<Page>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── 라우팅 가드: 인증 전 ────────────────────────────────────────────────
  // 앱 최초 로드 시 (familyCode 없고 로딩 중) → 로딩 스피너
  // familyCode 없고 로딩 아닐 때 → AuthGate
  if (!familyCode) {
    if (dbLoading) {
      return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-500 grid place-items-center shadow">
            <Wallet className="w-6 h-6 text-white" />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" />
            데이터를 불러오는 중…
          </div>
        </div>
      );
    }
    return <AuthGate />;
  }

  // ── 메인 앱 ─────────────────────────────────────────────────────────────
  function navigate(p: Page) {
    setPage(p);
    setSidebarOpen(false);
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* 모바일 오버레이 */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <Sidebar active={page} onNavigate={navigate} mobileOpen={sidebarOpen} onMobileClose={() => setSidebarOpen(false)} />

      <main className="flex-1 overflow-y-auto min-w-0">
        {/* 모바일 상단 헤더 */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b bg-card sticky top-0 z-30">
          <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-muted transition-colors" aria-label="메뉴 열기">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 grid place-items-center">
              <Wallet className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-bold text-sm">K-올웨더</span>
          </div>
        </div>

        {page === "dashboard"  && <Dashboard />}
        {page === "retirement" && <AccountPage accountId="retirement" />}
        {page === "isa"        && <AccountPage accountId="isa" />}
        {page === "pension"    && <AccountPage accountId="pension" />}
        {page === "irp"        && <AccountPage accountId="irp" />}
        {page === "settings"   && <SettingsPage />}
      </main>
    </div>
  );
}
