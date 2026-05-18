import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { usePortfolioStore } from "@/lib/kaw/store";
import { ACCOUNT_IDS, ACCOUNT_LABELS, PROFILE_LABELS, type AccountId } from "@/lib/kaw/constants";
import { ProfilePanel } from "@/components/kaw/ProfilePanel";
import { AccountTab } from "@/components/kaw/AccountTab";
import { HistorySection } from "@/components/kaw/HistorySection";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Download, Upload, RotateCcw, Wallet } from "lucide-react";

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
  const { state, resetAll, importJson } = usePortfolioStore();
  const [active, setActive] = useState<AccountId>("retirement");
  const fileRef = useRef<HTMLInputElement>(null);

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kaw-portfolio-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    f.text().then((t) => { try { importJson(JSON.parse(t)); } catch { alert("잘못된 JSON 파일입니다."); } });
    e.target.value = "";
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground grid place-items-center">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <h1 className="font-semibold leading-tight">K-올웨더 포트폴리오</h1>
              <p className="text-xs text-muted-foreground">리밸런싱 & 수익률 트래커 · {PROFILE_LABELS[state.profile]}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <input ref={fileRef} type="file" accept="application/json" hidden onChange={onImport} />
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-1.5" /> 가져오기
            </Button>
            <Button variant="ghost" size="sm" onClick={exportJson}>
              <Download className="w-4 h-4 mr-1.5" /> 내보내기
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { if (confirm("모든 데이터를 초기화할까요?")) resetAll(); }}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> 초기화
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <ProfilePanel />

        <div>
          <Tabs value={active} onValueChange={(v) => setActive(v as AccountId)}>
            <TabsList className="grid grid-cols-5 w-full sm:w-auto">
              {ACCOUNT_IDS.map((id) => (
                <TabsTrigger key={id} value={id}>{ACCOUNT_LABELS[id]}</TabsTrigger>
              ))}
            </TabsList>
            {ACCOUNT_IDS.map((id) => (
              <TabsContent key={id} value={id} className="space-y-6 mt-4">
                <AccountTab accountId={id} />
                <HistorySection accountId={id} />
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <footer className="text-xs text-muted-foreground text-center py-4">
          모든 데이터는 브라우저 localStorage에만 저장됩니다. UH: 환노출 · H: 환헤지
        </footer>
      </main>
    </div>
  );
}
