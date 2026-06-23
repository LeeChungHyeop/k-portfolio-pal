import { useState, useRef, useEffect } from "react";
import { ArrowLeft, RefreshCw, AlertCircle, KeyRound, HelpCircle } from "lucide-react";
import {
  type ProfileConfig, type FamilyData,
  verifyPin, updatePin, verifyMasterCode,
} from "@/lib/kaw/auth";
import {
  SECRET_QUESTIONS, pickRandomSQIndex, verifySQAnswer, type SQIndex,
} from "@/lib/kaw/secretQuestions";

interface Props {
  profile: ProfileConfig;
  familyData: FamilyData;
  familyCode: string;
  onSuccess: (updatedFamily: FamilyData) => void;
  onBack: () => void;
  onFamilyUpdate: (fd: FamilyData) => void;
}

type Step = "entry" | "setup" | "forgot_master" | "secret_question" | "reset_pin";

const AVATAR_COLORS = [
  "from-violet-500 to-blue-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-500",
];

function haptic(ms = 10) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(ms);
  }
}

function PinDots({ value, maxLen = 4 }: { value: string; maxLen?: number }) {
  return (
    <div className="flex gap-3 justify-center my-6">
      {Array.from({ length: maxLen }).map((_, i) => (
        <div
          key={i}
          className={`w-4 h-4 rounded-full border-2 transition-transform duration-75 ${
            i < value.length
              ? "bg-violet-500 border-violet-500 scale-110"
              : "border-muted-foreground/40"
          }`}
        />
      ))}
    </div>
  );
}

function PinPad({ onDigit, onDelete }: { onDigit: (d: string) => void; onDelete: () => void }) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  return (
    <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto">
      {keys.map((k, i) => {
        if (!k) return <div key={i} />;
        if (k === "⌫") return (
          <button key={i}
            onPointerDown={(e) => { e.preventDefault(); haptic(); onDelete(); }}
            className="h-14 rounded-2xl text-lg font-medium bg-muted/50 hover:bg-muted active:scale-90 active:bg-muted transition-transform duration-75 touch-manipulation select-none">
            {k}
          </button>
        );
        return (
          <button key={i}
            onPointerDown={(e) => { e.preventDefault(); haptic(); onDigit(k); }}
            className="h-14 rounded-2xl text-lg font-semibold bg-card border hover:bg-muted active:scale-90 active:bg-muted/80 transition-transform duration-75 shadow-sm touch-manipulation select-none">
            {k}
          </button>
        );
      })}
    </div>
  );
}

export function PinGate({ profile, familyData, familyCode, onSuccess, onBack, onFamilyUpdate }: Props) {
  const colorIdx = familyData.profiles.findIndex((p) => p.id === profile.id) % AVATAR_COLORS.length;
  const avatarColor = AVATAR_COLORS[Math.max(0, colorIdx)];

  const hasPinSet = Boolean(profile.pin_hash);
  const [step, setStep] = useState<Step>(hasPinSet ? "entry" : "setup");

  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [onConfirmStep, setOnConfirmStep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 마스터 코드 인증
  const [masterInput, setMasterInput] = useState("");
  const [masterError, setMasterError] = useState<string | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);
  const masterRef = useRef<HTMLInputElement>(null);

  // 비밀 질문 인증
  const [sqIdx, setSqIdx] = useState<SQIndex>(0);
  const [sqAnswer, setSqAnswer] = useState("");
  const [sqError, setSqError] = useState<string | null>(null);

  useEffect(() => {
    if (step === "forgot_master") masterRef.current?.focus();
  }, [step]);

  function resetState() {
    setPin(""); setPinConfirm(""); setOnConfirmStep(false);
    setError(null); setMasterInput(""); setMasterError(null);
    setSqAnswer(""); setSqError(null);
  }

  // ── PIN entry ──────────────────────────────────────────────────────────────
  async function handlePinEntry(digit: string) {
    const next = pin + digit;
    setPin(next); setError(null);
    if (next.length === 4) {
      setLoading(true);
      const ok = await verifyPin(familyCode, profile.id, next, familyData);
      setLoading(false);
      if (ok) { onSuccess(familyData); }
      else { setError("비밀번호가 틀렸습니다. 다시 시도해주세요."); setPin(""); }
    }
  }

  // ── PIN setup ──────────────────────────────────────────────────────────────
  async function handlePinSetup(digit: string) {
    if (!onConfirmStep) {
      const next = pin + digit;
      setPin(next);
      if (next.length === 4) { setOnConfirmStep(true); setPinConfirm(""); }
    } else {
      const next = pinConfirm + digit;
      setPinConfirm(next); setError(null);
      if (next.length === 4) {
        if (pin !== next) {
          setError("비밀번호가 일치하지 않습니다. 다시 입력해주세요.");
          setPinConfirm(""); setPin(""); setOnConfirmStep(false);
          return;
        }
        setLoading(true);
        try {
          const updated = await updatePin(familyCode, profile.id, pin, familyData);
          onFamilyUpdate(updated); onSuccess(updated);
        } catch { setError("저장 중 오류가 발생했습니다."); setLoading(false); }
      }
    }
  }

  // ── Reset PIN (after master or secret question verified) ───────────────────
  async function handlePinReset(digit: string) {
    const next = pinConfirm + digit;
    setPinConfirm(next); setError(null);
    if (next.length === 4) {
      setLoading(true);
      try {
        const updated = await updatePin(familyCode, profile.id, next, familyData);
        onFamilyUpdate(updated); onSuccess(updated);
      } catch { setError("저장 중 오류가 발생했습니다."); setLoading(false); }
    }
  }

  function handleDelete() {
    if (step === "entry") setPin((p) => p.slice(0, -1));
    else if (step === "setup") {
      if (onConfirmStep) setPinConfirm((p) => p.slice(0, -1));
      else setPin((p) => p.slice(0, -1));
    } else if (step === "reset_pin") setPinConfirm((p) => p.slice(0, -1));
    setError(null);
  }

  async function handleMasterVerify(e: React.FormEvent) {
    e.preventDefault();
    setMasterLoading(true); setMasterError(null);
    const ok = await verifyMasterCode(masterInput, familyData, familyCode);
    setMasterLoading(false);
    if (!ok) { setMasterError("액세스 코드가 일치하지 않습니다."); return; }
    setStep("reset_pin");
    setMasterInput(""); setPinConfirm(""); setError(null);
  }

  function goToSecretQuestion() {
    setSqIdx(pickRandomSQIndex());
    setSqAnswer(""); setSqError(null);
    setStep("secret_question");
  }

  function handleSQVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifySQAnswer(sqIdx, sqAnswer)) {
      setSqError("정답이 맞지 않습니다. 다시 시도해주세요.");
      setSqAnswer("");
      return;
    }
    setStep("reset_pin");
    setPinConfirm(""); setError(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const currentPin = step === "entry" ? pin : (onConfirmStep ? pinConfirm : pin);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-xs">

        {/* Back */}
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" /> 프로필 선택으로
        </button>

        {/* Avatar */}
        <div className="flex flex-col items-center mb-2">
          <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${avatarColor} flex items-center justify-center shadow-lg mb-3`}>
            <span className="text-3xl font-bold text-white">{profile.label.charAt(0)}</span>
          </div>
          <h2 className="text-xl font-bold">{profile.label}</h2>
        </div>

        {/* ── 마스터 코드 인증 ──────────────────────────────────── */}
        {step === "forgot_master" && (
          <div className="mt-6 space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              액세스 코드를 입력하면<br />비밀번호를 초기화할 수 있습니다.
            </p>
            <form onSubmit={handleMasterVerify} className="space-y-3">
              <input
                ref={masterRef}
                type="password"
                value={masterInput}
                onChange={(e) => { setMasterInput(e.target.value); setMasterError(null); }}
                placeholder="액세스 코드를 입력하세요"
                className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all"
              />
              {masterError && (
                <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />{masterError}
                </div>
              )}
              <button type="submit" disabled={masterLoading || !masterInput}
                className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold disabled:opacity-50 transition-all">
                {masterLoading ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : "확인 후 비밀번호 재설정"}
              </button>
              <button type="button" onClick={() => { setStep(hasPinSet ? "entry" : "setup"); resetState(); }}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors">
                취소
              </button>
            </form>

            {/* 비밀 질문 대안 */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="text-xs text-muted-foreground bg-background px-2">또는</span>
              </div>
            </div>
            <button
              onClick={goToSecretQuestion}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-violet-500 transition-colors"
            >
              <HelpCircle className="w-4 h-4" /> 비밀 질문으로 인증
            </button>
          </div>
        )}

        {/* ── 비밀 질문 인증 ────────────────────────────────────── */}
        {step === "secret_question" && (
          <div className="mt-6 space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              비밀 질문에 답하면<br />비밀번호를 재설정할 수 있습니다.
            </p>
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
                autoFocus
                autoComplete="off"
                className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all"
              />
              {sqError && (
                <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />{sqError}
                </div>
              )}
              <button type="submit" disabled={!sqAnswer.trim()}
                className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold disabled:opacity-50 transition-all">
                확인 후 비밀번호 재설정
              </button>
              <button type="button" onClick={() => { setStep(hasPinSet ? "entry" : "setup"); resetState(); }}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors">
                취소
              </button>
            </form>
          </div>
        )}

        {/* ── PIN 재설정 ────────────────────────────────────────── */}
        {step === "reset_pin" && (
          <>
            <p className="text-center text-sm text-muted-foreground mt-2">새 비밀번호 4자리를 입력하세요.</p>
            {error && (
              <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2 mt-3">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
              </div>
            )}
            <PinDots value={pinConfirm} />
            {loading
              ? <div className="flex justify-center"><RefreshCw className="w-5 h-5 animate-spin text-violet-500" /></div>
              : <PinPad onDigit={handlePinReset} onDelete={handleDelete} />
            }
          </>
        )}

        {/* ── 일반 PIN 입력 / 설정 ────────────────────────────────── */}
        {(step === "entry" || step === "setup") && (
          <>
            <p className="text-center text-sm text-muted-foreground mt-2">
              {step === "setup" && !onConfirmStep && "사용할 비밀번호 4자리를 설정해주세요."}
              {step === "setup" && onConfirmStep && "비밀번호를 한 번 더 입력해주세요."}
              {step === "entry" && "비밀번호를 입력하세요."}
            </p>

            {error && (
              <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2 mt-3">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
              </div>
            )}

            <PinDots value={currentPin} />

            {loading
              ? <div className="flex justify-center"><RefreshCw className="w-5 h-5 animate-spin text-violet-500" /></div>
              : <PinPad
                  onDigit={step === "entry" ? handlePinEntry : handlePinSetup}
                  onDelete={handleDelete}
                />
            }

            {step === "entry" && (
              <button
                onClick={() => { setStep("forgot_master"); resetState(); }}
                className="w-full mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5" /> 비밀번호를 잊으셨나요?
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
