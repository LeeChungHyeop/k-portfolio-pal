import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plug, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACCOUNT_LABELS, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore } from "@/lib/kaw/store";
import {
  BROKER_CHOICE_LABEL,
  CONNECTION_MODE_LABEL,
  allowedModes,
  connectionOf,
  type BrokerChoice,
} from "@/lib/kaw/broker-connection";
import type { ConnectionMode } from "@/lib/kaw/broker-account";
import { requestKisAccount } from "@/lib/kaw/kis-account-client";
import { describeKisResult, type KisResultView } from "@/lib/kaw/kis-account-view";
import { kstDateString } from "@/lib/kaw/snapshot";
import { correctInstanceStart, isRealIsoDate } from "@/lib/kaw/broker-connection";

const TONE: Record<KisResultView["tone"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-rose-600 dark:text-rose-400",
};

/**
 * 계좌별 증권사 · 운용방식 설정.
 *
 * 기본은 **계산만 제공**이다(기존 사용자 포함). 이 카드는 레지스트리(`brokerAccounts`)만
 * 바꾸고 수량·예수금·거래기록을 건드리지 않는다. "연결 확인"은 사용자가 누를 때만
 * 서버를 부르며, 계산만 제공이면 요청 자체를 보내지 않는다.
 */
export function BrokerConnectionCard({ accountId }: { accountId: AccountId }) {
  const { state, setBrokerConnection, correctBrokerStart } = usePortfolioStore();
  const registry = state.brokerAccounts ?? [];
  const today = kstDateString();
  const current = useMemo(() => connectionOf(registry, accountId, today), [registry, accountId, today]);

  const [broker, setBroker] = useState<BrokerChoice | null>(null);
  const [mode, setMode] = useState<ConnectionMode | null>(null);
  // 시작일은 **기본값이 없다.** 오늘 날짜를 미리 채우면 실제 이전일·입금 확인일이 아닌 값이 조용히
  // 저장된다 — 사용자가 날짜를 직접 입력하고, 그 날짜가 실제 확인된 날임을 체크해야 저장된다.
  const [since, setSince] = useState("");
  const [sinceConfirmed, setSinceConfirmed] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixDate, setFixDate] = useState("");
  const [fixConfirmed, setFixConfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<KisResultView | null>(null);

  // 사용자가 건드리지 않은 동안에는 저장된 값을 그대로 보여준다.
  const shownBroker = broker ?? current.broker;
  const shownMode = mode ?? current.mode;
  const modes = shownBroker ? allowedModes(shownBroker, accountId) : (["calc_only"] as ConnectionMode[]);
  const effectiveMode: ConnectionMode = modes.includes(shownMode) ? shownMode : "calc_only";
  const brokerChanges = shownBroker !== null && shownBroker !== current.broker;
  const dirty = shownBroker !== null && (brokerChanges || effectiveMode !== current.mode);
  const startReady = !brokerChanges || (isRealIsoDate(since) && sinceConfirmed);

  // 시작일 정정 미리보기 — 저장하지 않고 결과만 계산한다.
  const fixPreview = useMemo(
    () => (current.instance && isRealIsoDate(fixDate)
      ? correctInstanceStart(registry, current.instance.id, fixDate, { today })
      : null),
    [registry, current.instance, fixDate, today],
  );

  function apply() {
    if (!shownBroker || !startReady) return;
    const r = setBrokerConnection(
      accountId,
      { broker: shownBroker, mode: effectiveMode },
      brokerChanges ? since : undefined,
    );
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    setBroker(null);
    setMode(null);
    setView(null);
    setSince("");
    setSinceConfirmed(false);
    toast.success(
      r.createdId
        ? "계좌 설정을 저장했습니다. 이전 계좌 기록은 그대로 보존됩니다."
        : r.changed ? "운용방식을 저장했습니다." : "변경된 내용이 없습니다.",
    );
  }

  async function check() {
    if (checking) return;
    setChecking(true);
    try {
      const r = await requestKisAccount(registry, accountId, today);
      setView(describeKisResult(r));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="p-4 md:p-5 space-y-3 md:space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          증권사 · 운용방식
        </h3>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{ACCOUNT_LABELS[accountId]} 계좌의 증권사</p>
        <div className="flex gap-2 flex-wrap">
          {(["kis", "other"] as BrokerChoice[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => { setBroker(b); setMode(null); }}
              className={[
                "px-3 py-1.5 text-sm rounded-lg border transition-colors",
                shownBroker === b
                  ? "bg-primary/10 border-primary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {BROKER_CHOICE_LABEL[b]}
            </button>
          ))}
        </div>
        {current.broker === null && !broker && (
          <p className="text-xs text-muted-foreground">
            아직 설정하지 않았습니다. 지금은 <b>계산만 제공</b>으로 동작합니다.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">운용방식</p>
        <div className="flex gap-2 flex-wrap">
          {(["calc_only", "api_readonly"] as ConnectionMode[]).map((m) => {
            const enabled = shownBroker !== null && modes.includes(m);
            return (
              <button
                key={m}
                type="button"
                disabled={!enabled}
                onClick={() => setMode(m)}
                className={[
                  "px-3 py-1.5 text-sm rounded-lg border transition-colors",
                  effectiveMode === m && enabled
                    ? "bg-primary/10 border-primary text-foreground font-medium"
                    : "text-muted-foreground",
                  enabled ? "hover:text-foreground" : "opacity-50 cursor-not-allowed",
                ].join(" ")}
              >
                {CONNECTION_MODE_LABEL[m]}
              </button>
            );
          })}
        </div>
        {shownBroker === "other" && (
          <p className="text-xs text-muted-foreground">
            기타 증권사는 계산만 제공됩니다 (수량·예수금을 직접 입력).
          </p>
        )}
        {shownBroker === "kis" && !current.apiSupported && (
          <p className="text-xs text-muted-foreground">
            이 계좌 종류는 아직 API 조회를 지원하지 않아 계산만 제공됩니다.
          </p>
        )}
      </div>

      {brokerChanges && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">이 증권사 계좌 사용 시작일 (필수)</p>
          <Input
            type="date"
            value={since}
            onChange={(e) => { setSince(e.target.value); setSinceConfirmed(false); }}
            className="max-w-[11rem]"
          />
          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sinceConfirmed}
              disabled={!isRealIsoDate(since)}
              onChange={(e) => setSinceConfirmed(e.target.checked)}
            />
            <span>
              이 날짜는 <b>실제 계좌 이전 완료일 또는 자금 입금 확인일</b>입니다(오늘 날짜를 임의로 넣지 않았습니다).
            </span>
          </label>
          {since === today && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              입력한 날짜가 오늘입니다. 실제 이전·입금 확인일이 오늘이 아니라면 그 날짜로 바꿔 주세요 —
              저장 후에는 시작일을 정정해야 합니다.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            기존 계좌의 수량·예수금·거래기록은 그대로 두고, 이 날짜부터 새 계좌로 구분합니다.
            시작일이 미래면 그 날까지는 조회하지 않습니다(이전 진행 중). 날짜를 모르면 저장하지 말고
            확인한 뒤에 설정하세요(그동안은 계산만 제공으로 동작합니다).
          </p>
        </div>
      )}

      <Button size="sm" disabled={!dirty || !startReady} onClick={apply}>
        설정 저장
      </Button>

      {current.instance && (
        <div className="space-y-1.5 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              현재 계좌 사용 시작일: <b className="text-foreground tabular-nums">{current.instance.activeFrom}</b>
            </p>
            {!fixing && (
              <Button size="sm" variant="outline" onClick={() => setFixing(true)}>시작일 정정</Button>
            )}
          </div>
          {fixing && (
            <div className="space-y-1.5">
              <Input
                type="date"
                value={fixDate}
                max={today}
                onChange={(e) => { setFixDate(e.target.value); setFixConfirmed(false); }}
                className="max-w-[11rem]"
              />
              {fixPreview && !fixPreview.ok && (
                <p className="text-xs text-rose-600 dark:text-rose-400">{fixPreview.message}</p>
              )}
              {fixPreview && fixPreview.ok && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>이 계좌의 시작일이 {fixPreview.previousStart} → <b>{fixDate}</b> 로 바뀝니다.</p>
                  {fixPreview.movedPredecessor && (
                    <p>
                      이전 계좌({fixPreview.movedPredecessor.label})의 종료일도 {fixPreview.movedPredecessor.previousActiveTo} →{" "}
                      <b>{fixPreview.movedPredecessor.nextActiveTo}</b> 로 함께 바뀝니다.
                    </p>
                  )}
                  <p>수량·예수금·거래·완료 기록은 바뀌지 않습니다. 날짜로 계좌를 구분하는 표시만 달라집니다.</p>
                </div>
              )}
              <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={fixConfirmed}
                  disabled={!(fixPreview && fixPreview.ok)}
                  onChange={(e) => setFixConfirmed(e.target.checked)}
                />
                <span>이 날짜는 <b>실제 확인된 이전 완료일 또는 입금 확인일</b>입니다.</span>
              </label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!(fixPreview && fixPreview.ok) || !fixConfirmed}
                  onClick={() => {
                    if (!current.instance) return;
                    const r = correctBrokerStart(current.instance.id, fixDate);
                    if (!r.ok) { toast.error(r.message); return; }
                    toast.success("시작일을 정정했습니다. 기록은 그대로 보존됩니다.");
                    setFixing(false); setFixDate(""); setFixConfirmed(false);
                  }}
                >
                  정정 저장
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setFixing(false); setFixDate(""); setFixConfirmed(false); }}>
                  취소
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {current.ambiguous && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          같은 날짜에 사용 중인 계좌가 둘 이상이라 설정을 바꿀 수 없습니다.
        </p>
      )}

      {current.mode === "api_readonly" && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <p className="text-xs text-muted-foreground">
              읽기 전용입니다. 주문·자동매매는 지원하지 않습니다.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={check} disabled={checking}>
            {checking ? "확인 중…" : "연결 확인 (읽기 전용 조회)"}
          </Button>
          {view && (
            <div className="text-xs space-y-0.5" role="status">
              <p className={`font-medium ${TONE[view.tone]}`}>{view.title}</p>
              {view.lines.map((l, i) => (
                <p key={i} className="text-muted-foreground break-words">{l}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
