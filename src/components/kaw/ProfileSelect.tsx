import { useState } from "react";

function haptic(ms = 10) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(ms);
  }
}
import { UserPlus, ArrowLeft, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  type ProfileConfig, type FamilyData,
  addProfile, verifyMasterCode, verifyPin, restoreProfile,
} from "@/lib/kaw/auth";

interface Props {
  familyCode: string;
  familyData: FamilyData;
  onSelect: (profile: ProfileConfig) => void;
  onFamilyUpdate: (fd: FamilyData) => void;
}

const AVATAR_COLORS = [
  "from-violet-500 to-blue-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-500",
  "from-sky-500 to-cyan-500",
  "from-purple-500 to-indigo-500",
];

type Step = "list" | "master_verify" | "create" | "restore_prompt" | "restore_verify";

export function ProfileSelect({ familyCode, familyData, onSelect, onFamilyUpdate }: Props) {
  const [step, setStep] = useState<Step>("list");
  const [masterInput, setMasterInput] = useState("");
  const [masterError, setMasterError] = useState<string | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);

  const [newLabel, setNewLabel] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPinConfirm, setNewPinConfirm] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 복원 플로우
  const [matchedDeleted, setMatchedDeleted] = useState<ProfileConfig | null>(null);
  const [restorePin, setRestorePin] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);

  async function handleMasterVerify(e: React.FormEvent) {
    e.preventDefault();
    setMasterLoading(true);
    setMasterError(null);
    const ok = await verifyMasterCode(masterInput, familyData, familyCode);
    setMasterLoading(false);
    if (!ok) { setMasterError("액세스 코드가 일치하지 않습니다."); return; }
    setStep("create");
    setMasterInput("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim()) { setCreateError("프로필 이름을 입력해주세요."); return; }
    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) { setCreateError("4자리 숫자 비밀번호를 입력해주세요."); return; }
    if (newPin !== newPinConfirm) { setCreateError("비밀번호가 일치하지 않습니다."); return; }

    // 삭제된 프로필과 이름 일치 확인
    const deleted = familyData.deleted_profiles ?? [];
    const match = deleted.find((p) => p.label.trim() === newLabel.trim());
    if (match) {
      setMatchedDeleted(match);
      setRestorePin("");
      setRestoreError(null);
      setStep("restore_prompt");
      return;
    }

    setCreateLoading(true);
    setCreateError(null);
    try {
      const updated = await addProfile(familyCode, newLabel, newPin, familyData);
      onFamilyUpdate(updated);
      setStep("list");
      setNewLabel(""); setNewPin(""); setNewPinConfirm("");
    } catch (err: unknown) {
      setCreateError((err as { message?: string })?.message ?? "오류가 발생했습니다.");
    }
    setCreateLoading(false);
  }

  async function handleRestoreVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!matchedDeleted) return;
    setRestoreLoading(true);
    setRestoreError(null);
    const ok = await verifyPin(familyCode, matchedDeleted.id, restorePin, familyData);
    if (!ok) {
      setRestoreError("비밀번호가 일치하지 않습니다.");
      setRestorePin("");
      setRestoreLoading(false);
      return;
    }
    try {
      const updated = await restoreProfile(familyCode, matchedDeleted.id, familyData);
      onFamilyUpdate(updated);
      const restoredProfile = updated.profiles.find((p) => p.id === matchedDeleted.id);
      if (restoredProfile) onSelect(restoredProfile);
    } catch (err: unknown) {
      setRestoreError((err as { message?: string })?.message ?? "복원 중 오류가 발생했습니다.");
    }
    setRestoreLoading(false);
  }

  async function handleCreateAnyway() {
    // 복원 거부 → 새 프로필로 생성 진행
    setStep("create");
    setMatchedDeleted(null);
    setCreateLoading(true);
    setCreateError(null);
    try {
      const updated = await addProfile(familyCode, newLabel, newPin, familyData);
      onFamilyUpdate(updated);
      setStep("list");
      setNewLabel(""); setNewPin(""); setNewPinConfirm("");
    } catch (err: unknown) {
      setCreateError((err as { message?: string })?.message ?? "오류가 발생했습니다.");
    }
    setCreateLoading(false);
  }

  if (step === "restore_prompt") {
    return (
      <Screen>
        <button onClick={() => { setStep("create"); setMatchedDeleted(null); }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> 돌아가기
        </button>
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center mb-4 shadow-md">
          <span className="text-2xl font-bold text-white">{matchedDeleted?.label.charAt(0)}</span>
        </div>
        <h2 className="text-xl font-bold mb-2">예전 프로필을 발견했어요</h2>
        <p className="text-sm text-muted-foreground mb-6">
          <span className="font-semibold text-foreground">"{matchedDeleted?.label}"</span>은(는) 이전에 삭제된 프로필입니다.<br />
          기존 자산 정보를 불러오시겠습니까?
        </p>
        <div className="space-y-2">
          <button
            onClick={() => setStep("restore_verify")}
            className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-all"
          >
            <CheckCircle2 className="w-4 h-4" /> 불러오기
          </button>
          <button
            onClick={handleCreateAnyway}
            disabled={createLoading}
            className="w-full h-11 rounded-xl border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all flex items-center justify-center gap-2"
          >
            {createLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "새로 만들기"}
          </button>
        </div>
      </Screen>
    );
  }

  if (step === "restore_verify") {
    return (
      <Screen>
        <button onClick={() => setStep("restore_prompt")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> 돌아가기
        </button>
        <h2 className="text-xl font-bold mb-1">기존 비밀번호 확인</h2>
        <p className="text-sm text-muted-foreground mb-6">
          <span className="font-semibold text-foreground">{matchedDeleted?.label}</span>의 기존 프로필 비밀번호를 입력하세요.
        </p>
        <form onSubmit={handleRestoreVerify} className="space-y-3">
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={restorePin}
            onChange={(e) => { setRestorePin(e.target.value.replace(/\D/g, "")); setRestoreError(null); }}
            placeholder="••••"
            autoFocus
            className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.5em]"
          />
          {restoreError && (
            <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{restoreError}
            </div>
          )}
          <button type="submit" disabled={restoreLoading || restorePin.length !== 4}
            className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition-all">
            {restoreLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "복원하기"}
          </button>
        </form>
      </Screen>
    );
  }

  if (step === "master_verify") {
    return (
      <Screen>
        <button onClick={() => { setStep("list"); setMasterInput(""); setMasterError(null); }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> 돌아가기
        </button>
        <h2 className="text-xl font-bold mb-1">액세스 코드 확인</h2>
        <p className="text-sm text-muted-foreground mb-6">새 프로필을 만들려면 액세스 코드를 입력하세요.</p>
        <form onSubmit={handleMasterVerify} className="space-y-3">
          <input
            type="password"
            value={masterInput}
            onChange={(e) => { setMasterInput(e.target.value); setMasterError(null); }}
            placeholder="액세스 코드를 입력하세요"
            autoFocus
            autoComplete="off"
            className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all"
          />
          {masterError && (
            <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{masterError}
            </div>
          )}
          <button type="submit" disabled={masterLoading || !masterInput}
            className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition-all">
            {masterLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "확인"}
          </button>
        </form>
      </Screen>
    );
  }

  if (step === "create") {
    return (
      <Screen>
        <button onClick={() => { setStep("list"); setCreateError(null); }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> 돌아가기
        </button>
        <h2 className="text-xl font-bold mb-1">새 프로필 추가</h2>
        <p className="text-sm text-muted-foreground mb-6">이름과 개인 비밀번호 4자리를 설정하세요.</p>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">프로필 이름</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => { setNewLabel(e.target.value); setCreateError(null); }}
              placeholder="예: 철수"
              autoFocus
              className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">비밀번호 (숫자 4자리)</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={newPin}
              onChange={(e) => { setNewPin(e.target.value.replace(/\D/g, "")); setCreateError(null); }}
              placeholder="••••"
              className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.5em]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">비밀번호 확인</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={newPinConfirm}
              onChange={(e) => { setNewPinConfirm(e.target.value.replace(/\D/g, "")); setCreateError(null); }}
              placeholder="••••"
              className="w-full h-11 px-4 rounded-xl border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.5em]"
            />
          </div>
          {createError && (
            <div className="flex items-center gap-2 text-rose-500 text-xs bg-rose-500/10 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{createError}
            </div>
          )}
          {newPin.length === 4 && newPin === newPinConfirm && (
            <div className="flex items-center gap-2 text-emerald-500 text-xs bg-emerald-500/10 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />비밀번호가 일치합니다.
            </div>
          )}
          <button type="submit" disabled={createLoading || !newLabel.trim() || newPin.length !== 4}
            className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition-all">
            {createLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "프로필 생성"}
          </button>
        </form>
      </Screen>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold tracking-tight">누가 보고 있나요?</h1>
          <p className="text-muted-foreground mt-2 text-sm">프로필을 선택하세요</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
          {familyData.profiles.map((profile, i) => (
            <button
              key={profile.id}
              onClick={() => { haptic(15); onSelect(profile); }}
              className="flex flex-col items-center gap-3 p-6 rounded-2xl border bg-card hover:border-violet-400 hover:shadow-lg active:scale-95 transition-transform duration-75 touch-manipulation select-none group"
            >
              <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center shadow-md group-hover:shadow-lg transition-shadow`}>
                <span className="text-2xl font-bold text-white">
                  {profile.label.charAt(0)}
                </span>
              </div>
              <span className="text-sm font-semibold">{profile.label}</span>
            </button>
          ))}

          {/* + 프로필 추가 */}
          <button
            onClick={() => setStep("master_verify")}
            className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-dashed bg-card/50 hover:border-violet-400 hover:bg-card active:scale-95 transition-transform duration-75 touch-manipulation select-none group"
          >
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-muted-foreground/30 group-hover:border-violet-400 flex items-center justify-center transition-colors">
              <UserPlus className="w-7 h-7 text-muted-foreground/50 group-hover:text-violet-500 transition-colors" />
            </div>
            <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
              프로필 추가
            </span>
          </button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          K-올웨더 · 액세스 코드로 연결됨
        </p>
      </div>
    </div>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
