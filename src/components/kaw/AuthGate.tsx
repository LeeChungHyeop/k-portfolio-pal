import { useState } from "react";
import {
  Wallet, Lock, RefreshCw, Wifi, HardDrive, AlertCircle,
  ArrowRight, CheckCircle2, Lightbulb, HelpCircle, ArrowLeft,
} from "lucide-react";
import { loginWithCode, ACCESS_CODE } from "@/lib/kaw/store";
import {
  SECRET_QUESTIONS, pickRandomSQIndex, verifySQAnswer, type SQIndex,
} from "@/lib/kaw/secretQuestions";

type Step = "entry" | "secret_question";

export function AuthGate() {
  const [step, setStep] = useState<Step>("entry");

  // 액세스 코드 입력 단계
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<"new" | "existing" | null>(null);

  // 비밀 질문 단계
  const [sqIdx, setSqIdx] = useState<SQIndex>(0);
  const [sqAnswer, setSqAnswer] = useState("");
  const [sqError, setSqError] = useState<string | null>(null);
  const [sqLoading, setSqLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) { setError("액세스 코드를 입력해주세요."); return; }
    setLoading(true); setError(null);
    try {
      const result = await loginWithCode(trimmed);
      setJoined(result);
      await new Promise((r) => setTimeout(r, 800));
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "오류가 발생했습니다. 다시 시도해주세요.");
      setLoading(false);
    }
  }

  function goToSecretQuestion() {
    setSqIdx(pickRandomSQIndex());
    setSqAnswer(""); setSqError(null);
    setStep("secret_question");
  }

  async function handleSQVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifySQAnswer(sqIdx, sqAnswer)) {
      setSqError("정답이 맞지 않습니다. 다시 시도해주세요.");
      setSqAnswer("");
      return;
    }
    setSqLoading(true);
    try {
      const result = await loginWithCode(ACCESS_CODE);
      setJoined(result);
      await new Promise((r) => setTimeout(r, 800));
    } catch (err: unknown) {
      setSqError((err as { message?: string })?.message ?? "오류가 발생했습니다.");
    }
    setSqLoading(false);
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

        <div className="bg-card border rounded-2xl shadow-sm p-6 space-y-5">

          {/* ── 비밀 질문 단계 ──────────────────────────────────── */}
          {step === "secret_question" && (
            <>
              <button
                onClick={() => setStep("entry")}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> 돌아가기
              </button>
              <div className="flex items-center gap-2.5">
                <HelpCircle className="w-5 h-5 text-violet-500 shrink-0" />
                <div>
                  <p className="font-semibold text-sm">비밀 질문으로 인증</p>
                  <p className="text-xs text-muted-foreground">정답을 입력하면 자동으로 접속됩니다</p>
                </div>
              </div>

              <div className="bg-muted/50 border rounded-xl px-4 py-3">
                <p className="text-sm font-medium text-center">
                  {SECRET_QUESTIONS[sqIdx].question}
                </p>
              </div>

              <form onSubmit={handleSQVerify} className="space-y-3">
                <input
                  type="text"
                  value={sqAnswer}
                  onChange={(e) => { setSqAnswer(e.target.value); setSqError(null); }}
                  placeholder="정답을 입력하세요"
                  disabled={sqLoading}
                  autoFocus
                  autoComplete="off"
                  className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all disabled:opacity-50"
                />
                {sqError && (
                  <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />{sqError}
                  </div>
                )}
                {joined && (
                  <div className="flex items-center gap-2 text-emerald-500 text-xs bg-emerald-500/10 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />인증 완료! 이동 중…
                  </div>
                )}
                <button
                  type="submit"
                  disabled={sqLoading || !sqAnswer.trim() || !!joined}
                  className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sqLoading ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" /> 확인 중…</>
                  ) : (
                    <><ArrowRight className="w-4 h-4" /> 확인 후 입장하기</>
                  )}
                </button>
              </form>
            </>
          )}

          {/* ── 액세스 코드 입력 단계 ────────────────────────────── */}
          {step === "entry" && (
            <>
              <div className="flex items-center gap-2.5">
                <Lock className="w-5 h-5 text-violet-500 shrink-0" />
                <div>
                  <p className="font-semibold text-sm">액세스 코드로 시작</p>
                  <p className="text-xs text-muted-foreground">코드를 입력하면 프로필 선택으로 이동합니다</p>
                </div>
              </div>

              {/* Hint */}
              <div className="flex items-center gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3.5 py-2.5">
                <Lightbulb className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                  힌트: 첫째딸 이름만 영어로
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">액세스 코드</label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setError(null); }}
                    placeholder="액세스 코드를 입력하세요"
                    disabled={loading}
                    className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all disabled:opacity-50 font-medium tracking-wide"
                    autoFocus
                    autoComplete="off"
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
                  </div>
                )}
                {joined && (
                  <div className="flex items-center gap-2 text-emerald-500 text-xs bg-emerald-500/10 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    {joined === "new" ? "처음 오셨군요! 프로필 선택으로 이동 중…" : "프로필 선택으로 이동 중…"}
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
                    <><ArrowRight className="w-4 h-4" /> 입장하기</>
                  )}
                </button>
              </form>

              {/* 코드 분실 */}
              <div className="pt-1 text-center">
                <button
                  onClick={goToSecretQuestion}
                  className="text-xs text-muted-foreground hover:text-violet-500 transition-colors inline-flex items-center gap-1"
                >
                  <HelpCircle className="w-3.5 h-3.5" /> 코드를 잊으셨나요?
                </button>
              </div>

              <div className="space-y-2 pt-1">
                <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <Wifi className="w-3.5 h-3.5 shrink-0 mt-0.5 text-violet-400" />
                  <p>동일한 코드로 접속한 모든 기기에서 실시간으로 데이터가 공유됩니다.</p>
                </div>
                <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-400" />
                  <p>각 프로필은 개인 비밀번호로 보호되며 데이터가 독립적으로 관리됩니다.</p>
                </div>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          K-올웨더 · 가족 자산 포트폴리오 트래커
        </p>
      </div>
    </div>
  );
}
