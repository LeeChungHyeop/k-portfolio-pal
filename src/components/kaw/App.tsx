import { useState, useEffect } from "react";
import { Menu, Wallet, RefreshCw } from "lucide-react";
import { Sidebar, type Page, DEPLOY_DATE } from "@/components/kaw/Sidebar";
import { Dashboard } from "@/components/kaw/Dashboard";
import { IndexComparison } from "@/components/kaw/IndexComparison";
import { AccountPage } from "@/components/kaw/AccountPage";
import { SettingsPage } from "@/components/kaw/SettingsPage";

import { AuthGate } from "@/components/kaw/AuthGate";
import { ProfileSelect } from "@/components/kaw/ProfileSelect";
import { PinGate } from "@/components/kaw/PinGate";
import { usePortfolioStore, activateProfile, deactivateProfile, logoutCode, loginWithCode, ACCESS_CODE } from "@/lib/kaw/store";
import { KisPriceProvider } from "@/lib/kaw/KisPriceContext";
import {
  type ProfileConfig, type FamilyData,
  loadFamilyData, defaultFamilyData, setSessionProfile,
} from "@/lib/kaw/auth";
import { useIdleTimer } from "@/lib/kaw/useIdleTimer";

function LoadingScreen() {
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

// forcedDemoProfileId가 주어지면(/demo 라우트) 그 값을 그대로 쓰고, 없으면(/ 라우트) ?demo= 쿼리파라미터를 본다.
export function App({ forcedDemoProfileId }: { forcedDemoProfileId?: string } = {}) {
  const { familyCode, currentUser, dbLoading } = usePortfolioStore();

  const [page, setPage] = useState<Page>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [familyData, setFamilyData] = useState<FamilyData | null>(null);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<ProfileConfig | null>(null);

  // 데모 링크(/demo 또는 ?demo=<profileId>): 액세스 코드 입력·프로필 목록(실명 노출) 화면을 건너뛰고
  // 지정된 프로필의 PIN 입력 화면으로 바로 이동 — 다른 사람에게 특정 프로필만 보여줄 때 사용
  const [queryDemoProfileId] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("demo") : null,
  );
  const demoProfileId = forcedDemoProfileId ?? queryDemoProfileId;

  // Reload family data when code changes or profile deactivated
  useEffect(() => {
    if (!familyCode || currentUser) return;
    setFamilyLoading(true);
    loadFamilyData(familyCode).then((fd) => {
      setFamilyData(fd);
      setFamilyLoading(false);
    });
  }, [familyCode, currentUser]);

  // 데모 링크로 들어온 경우 액세스 코드 자동 입력
  useEffect(() => {
    if (!demoProfileId || familyCode || dbLoading) return;
    loginWithCode(ACCESS_CODE).catch(() => {});
  }, [demoProfileId, familyCode, dbLoading]);

  // Clear selected profile when navigating back (currentUser became "")
  useEffect(() => {
    if (!currentUser) setSelectedProfile(null);
  }, [currentUser]);

  // 자동 세션 종료: 10분 무입력 → 프로필 선택, 60분 무입력 → 액세스 코드
  useIdleTimer({
    active:           !!familyCode,
    onProfileTimeout: deactivateProfile,
    onLogoutTimeout:  logoutCode,
  });

  // Phase 1: No family code
  if (!familyCode) {
    if (dbLoading) return <LoadingScreen />;
    return <AuthGate />;
  }

  // Profile activation in progress
  if (dbLoading && !currentUser) return <LoadingScreen />;

  // Phase 2: Code entered, but profile not authenticated
  if (!currentUser) {
    if (familyLoading) return <LoadingScreen />;

    const fd = familyData ?? defaultFamilyData();

    if (!selectedProfile) {
      // 데모 링크: 프로필 목록(실명 노출) 대신 지정된 프로필로 바로 진입
      const demoProfile = demoProfileId ? fd.profiles.find((p) => p.id === demoProfileId) : null;
      if (demoProfile) {
        return (
          <PinGate
            profile={demoProfile}
            familyData={fd}
            familyCode={familyCode}
            onSuccess={(updatedFamily) => {
              setFamilyData(updatedFamily);
              setSessionProfile(demoProfile.id);
              activateProfile(demoProfile.id);
            }}
            onBack={() => { window.location.href = "/"; }}
            onFamilyUpdate={setFamilyData}
          />
        );
      }
      return (
        <ProfileSelect
          familyCode={familyCode}
          familyData={fd}
          onSelect={setSelectedProfile}
          onFamilyUpdate={setFamilyData}
        />
      );
    }

    return (
      <PinGate
        profile={selectedProfile}
        familyData={fd}
        familyCode={familyCode}
        onSuccess={(updatedFamily) => {
          setFamilyData(updatedFamily);
          setSessionProfile(selectedProfile.id);
          activateProfile(selectedProfile.id);
        }}
        onBack={() => setSelectedProfile(null)}
        onFamilyUpdate={setFamilyData}
      />
    );
  }

  // Phase 3: Fully authenticated
  function navigate(p: Page) {
    setPage(p);
    setSidebarOpen(false);
  }

  return (
    <KisPriceProvider>
    <div className="flex bg-background overflow-hidden" style={{ height: "100dvh" }}>
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <Sidebar
        active={page}
        onNavigate={navigate}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
        familyData={familyData}
        onFamilyUpdate={setFamilyData}
      />

      <main className="flex-1 overflow-y-auto min-w-0">
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b bg-card sticky top-0 z-30">
          <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-muted transition-colors" aria-label="메뉴 열기">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 grid place-items-center shrink-0">
              <Wallet className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-bold text-sm">K-올웨더</span>
          </div>
          <span className="text-[10px] text-muted-foreground/50 shrink-0">{DEPLOY_DATE}</span>
        </div>

        {page === "dashboard"  && <Dashboard onNavigate={navigate} />}
        {page === "compare"    && <IndexComparison />}
        {page === "retirement" && <AccountPage accountId="retirement" />}
        {page === "isa"        && <AccountPage accountId="isa" />}
        {page === "pension"    && <AccountPage accountId="pension" />}
        {page === "irp"        && <AccountPage accountId="irp" />}
        {page === "settings"   && (
          <SettingsPage
            familyData={familyData ?? defaultFamilyData()}
            onFamilyUpdate={setFamilyData}
          />
        )}

      </main>
    </div>
    </KisPriceProvider>
  );
}
