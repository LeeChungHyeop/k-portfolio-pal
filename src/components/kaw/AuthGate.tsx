import { useState } from "react";
import { Wallet, Shield, RefreshCw, Wifi, HardDrive, AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { loginWithCode } from "@/lib/kaw/store";

export function AuthGate() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<"new" | "existing" | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || trimmed.length < 4) {
      setError("코드는 최소 4자 이상이어야 합니다.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await loginWithCode(trimmed);
      setJoined(result);
      await new Promise((r) => setTimeout(r, 800));
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "오류가 발생했습니다. 다시 시도해주세요.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-500 shadow-lg">
            <Wallet className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">K-올웨더</h1>
            <p className="text-sm text-muted-foreground mt-1">포트폴리오 트래커</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-card border rounded-2xl shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-violet-500 shrink-0" />
            <div>
              <p className="font-semibold text-sm">가족 공유 코드로 시작</p>
              <p className="text-xs text-muted-foreground">코드가 곧 비밀번호이자 공유 방 ID입니다</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">가족 공유 코드</label>
              <input
                type="text"
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
                placeholder="예: KimFamily2025"
                disabled={loading}
                className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all disabled:opacity-50 font-medium tracking-wide"
                autoFocus
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {error}
              </div>
            )}

            {joined && (
              <div className="flex items-center gap-2 text-emerald-500 text-xs bg-emerald-500/10 rounded-lg px-3 py-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                {joined === "new" ? "새로운 방이 생성됐습니다! 프로필 선택으로 이동 중…" : "기존 데이터를 불러오는 중…"}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !code.trim() || !!joined}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> 확인 중…</>
              ) : (
                <><ArrowRight className="w-4 h-4" /> 시작하기</>
              )}
            </button>
          </form>

          <div className="space-y-2 pt-1">
            <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <Wifi className="w-3.5 h-3.5 shrink-0 mt-0.5 text-violet-400" />
              <p>동일한 코드를 입력한 모든 기기에서 실시간으로 데이터가 공유됩니다.</p>
            </div>
            <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-400" />
              <p>처음 입력하면 새 방이 생성되고, 기존 코드 입력 시 저장된 데이터를 불러옵니다.</p>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          회원가입이 필요 없습니다 · 코드를 기억하세요
        </p>
      </div>
    </div>
  );
}
