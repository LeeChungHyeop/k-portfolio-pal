// ─────────────────────────────────────────────────────────────────────────────
// 거래 이벤트 상세 — 그 날 실제로 무엇을 사고팔았고 보유수량이 어떻게 변했는가
//
// 핵심은 체결 나열이 아니라 **이전 보유수량 → 매매 → 이후 보유수량**이 한눈에 보이는 것이다.
//
// 세 가지를 구분해서 보여준다:
//   1. 증권사가 준 사실        — 원본 그대로. 주지 않은 값은 "—" 이고 추정하지 않는다.
//   2. 우리가 계산한 값        — 전후 보유수량(계좌별 전체 재생 결과)
//   3. 사용자가 고친 것        — 정정 overlay. 원본과 나란히 보여주고 되돌릴 수 있다.
//
// 편집은 전부 overlay 다. 원장(kaw_transaction_ledger)은 어떤 경우에도 수정되지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import {
  X, Pencil, EyeOff, Eye, Scissors, ArrowRightLeft, RotateCcw, History,
  Check, AlertTriangle, Info, ChevronLeft,
} from "lucide-react";
import { ACCOUNT_LABELS_SHORT } from "@/lib/kaw/constants";
import {
  defaultEventId, splitEventId,
  type EventTransactionLine, type ResolvedEvent,
} from "@/lib/kaw/ledger";
import { useLedgerMutations, useLedgerAudit } from "@/lib/kaw/useLedger";
import {
  EVENT_TYPE_OPTIONS, SUGGESTED_TAGS, eventTypeLabel, eventDateLabel,
  dateConfidenceOf, fmtAmount, fmtNullableAmount, fmtQty, fmtDelta,
  auditActionLabel, correctedFieldLabel, fmtAuditTime,
} from "@/lib/kaw/ledger-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

// ── 거래 한 줄 ──────────────────────────────────────────────────────────────

function TxLine({
  line, selectable, selected, onSelect, onCorrect,
}: {
  line: EventTransactionLine;
  selectable: boolean;
  selected: boolean;
  onSelect: (c: boolean) => void;
  onCorrect: () => void;
}) {
  const { transaction: t, effective: e } = line;
  const conf = dateConfidenceOf(t.tradeDateEvidence);
  const isBuy = e.side === "buy";

  return (
    <div className={`border rounded-xl p-3 space-y-2 ${e.excluded ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        {selectable && (
          <div className="pt-0.5">
            <Checkbox checked={selected} onCheckedChange={(c) => onSelect(c === true)} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium truncate">{e.etfName}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{e.ticker}</span>
            <Badge
              variant="outline"
              className={`h-5 px-1.5 text-[10px] ${
                isBuy
                  ? "border-emerald-300/60 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-300/60 text-rose-700 dark:text-rose-300"
              }`}
            >
              {isBuy ? "매수" : "매도"}
            </Badge>
            {e.corrected && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-sky-300/60 text-sky-700 dark:text-sky-300">
                정정 {e.correctedFields.map(correctedFieldLabel).join("·")}
              </Badge>
            )}
            {e.excluded && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">계산 제외</Badge>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] shrink-0" onClick={onCorrect}>
          <Pencil className="w-3 h-3 mr-1" /> 정정
        </Button>
      </div>

      {/* 이전 → 매매 → 이후. 이 화면의 핵심이라 가장 눈에 띄게 둔다. */}
      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs tabular-nums">
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">이전</p>
          <p className="font-medium">{fmtQty(line.beforeQuantity)}</p>
        </div>
        <div className="flex-1 text-center">
          <p className={`font-semibold ${isBuy ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {fmtDelta(line.deltaQuantity)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {fmtAmount(e.price)}원 · {fmtAmount(e.amount)}원
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">이후</p>
          <p className="font-medium">{fmtQty(line.afterQuantity)}</p>
        </div>
      </div>

      {line.postQuantityMismatch === true && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          증권사가 보고한 거래 후 잔고({fmtQty(t.postQuantity!)})와 계산값이 다릅니다.
        </p>
      )}

      {/* 원본 사실 — 증권사가 주지 않은 값은 "—" 로 둔다 */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
        <div><dt className="inline text-muted-foreground">체결수량 </dt><dd className="inline tabular-nums">{fmtQty(e.quantity)}</dd></div>
        <div><dt className="inline text-muted-foreground">체결단가 </dt><dd className="inline tabular-nums">{fmtAmount(e.price)}</dd></div>
        <div><dt className="inline text-muted-foreground">거래금액 </dt><dd className="inline tabular-nums">{fmtAmount(e.amount)}</dd></div>
        <div><dt className="inline text-muted-foreground">수수료 </dt><dd className="inline tabular-nums">{fmtNullableAmount(t.fee)}</dd></div>
        <div><dt className="inline text-muted-foreground">세금 </dt><dd className="inline tabular-nums">{fmtNullableAmount(t.tax)}</dd></div>
        <div><dt className="inline text-muted-foreground">거래후잔고 </dt><dd className="inline tabular-nums">{t.postQuantity === null ? "—" : fmtQty(t.postQuantity)}</dd></div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="inline text-muted-foreground">거래일 </dt>
          <dd className="inline tabular-nums">
            {e.eventDate}
            <span className={conf.direct ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"} title={conf.detail}>
              {" "}({conf.label})
            </span>
          </dd>
        </div>
        <div><dt className="inline text-muted-foreground">결제일 </dt><dd className="inline tabular-nums">{t.settlementDate ?? "—"}</dd></div>
        <div className="col-span-2 sm:col-span-3 truncate">
          <dt className="inline text-muted-foreground">source </dt>
          <dd className="inline text-muted-foreground">{t.source}{t.sourceFile ? ` · ${t.sourceFile}` : ""}</dd>
        </div>
      </dl>

      {e.corrected && (
        <p className="text-[11px] text-sky-700 dark:text-sky-300">
          원본: 수량 {fmtQty(t.quantity)} · 단가 {fmtAmount(t.price)} · 금액 {fmtAmount(t.amount)}
          {t.tradeDate ? ` · 거래일 ${t.tradeDate}` : ""}
        </p>
      )}
    </div>
  );
}

// ── 정정 다이얼로그 ─────────────────────────────────────────────────────────

function CorrectDialog({
  line, onClose,
}: { line: EventTransactionLine; onClose: () => void }) {
  const { correct } = useLedgerMutations();
  const { transaction: t, effective: e } = line;
  const [quantity, setQuantity] = useState(String(e.quantity));
  const [price, setPrice] = useState(String(e.price));
  const [tradeDate, setTradeDate] = useState(e.eventDate);
  const [excluded, setExcluded] = useState(e.excluded);
  const [reason, setReason] = useState("");

  const changed =
    Number(quantity) !== t.quantity
    || Number(price) !== t.price
    || tradeDate !== (t.tradeDate ?? t.inferredTradeDate ?? t.eventDate)
    || excluded;

  async function save() {
    try {
      await correct.mutateAsync({
        transactionId: t.id,
        correctedQuantity: Number(quantity) !== t.quantity ? Number(quantity) : null,
        correctedPrice: Number(price) !== t.price ? Number(price) : null,
        correctedTradeDate: tradeDate !== (t.tradeDate ?? t.inferredTradeDate) ? tradeDate : null,
        excluded,
        reason: reason.trim() || undefined,
      });
      toast.success("정정했습니다. 원본은 그대로 보존됩니다.");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "정정에 실패했습니다");
    }
  }

  async function revert() {
    try {
      await correct.mutateAsync({ transactionId: t.id, clear: true });
      toast.success("원본으로 되돌렸습니다");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "되돌리기에 실패했습니다");
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">거래정보 정정</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 rounded-lg bg-muted/60 p-2.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            원본 체결 기록은 <strong>수정되지 않습니다.</strong> 정정값은 따로 저장되고,
            언제든 원본으로 되돌릴 수 있습니다.
          </p>

          <div className="text-xs">
            <p className="font-medium">{t.etfName} <span className="text-muted-foreground">{t.ticker}</span></p>
            <p className="text-muted-foreground tabular-nums">
              원본: {t.side === "buy" ? "매수" : "매도"} {fmtQty(t.quantity)}주 ·
              {" "}{fmtAmount(t.price)}원 · {fmtAmount(t.amount)}원
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">체결수량</span>
              <Input value={quantity} onChange={(ev) => setQuantity(ev.target.value)} inputMode="decimal" className="h-8 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">체결단가</span>
              <Input value={price} onChange={(ev) => setPrice(ev.target.value)} inputMode="decimal" className="h-8 text-sm" />
            </label>
          </div>
          <label className="space-y-1 block">
            <span className="text-[11px] text-muted-foreground">
              거래일 {t.tradeDate ? "(증권사 보고)" : "(추정값 — 정정할 수 있습니다)"}
            </span>
            <Input type="date" value={tradeDate} onChange={(ev) => setTradeDate(ev.target.value)} className="h-8 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox checked={excluded} onCheckedChange={(c) => setExcluded(c === true)} />
            이 거래를 계산에서 제외 (중복 적재·취소된 주문 등)
          </label>
          <label className="space-y-1 block">
            <span className="text-[11px] text-muted-foreground">사유 (선택)</span>
            <Input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="예: 증권사 정정 통보" className="h-8 text-sm" />
          </label>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {e.corrected && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={revert} disabled={correct.isPending}>
                <RotateCcw className="w-3.5 h-3.5" /> 원본 복귀
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-8" onClick={onClose}>취소</Button>
            <Button size="sm" className="h-8" onClick={save} disabled={!changed || correct.isPending}>
              저장
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 변경 이력 ───────────────────────────────────────────────────────────────

function AuditList({ eventId }: { eventId: string }) {
  const audit = useLedgerAudit(eventId, true);
  if (audit.isLoading) return <p className="text-[11px] text-muted-foreground">불러오는 중…</p>;
  if (!audit.data?.length) {
    return <p className="text-[11px] text-muted-foreground">아직 변경 이력이 없습니다.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {audit.data.map((a) => (
        <li key={a.id} className="text-[11px] flex flex-wrap items-baseline gap-x-2">
          <span className="tabular-nums text-muted-foreground">{fmtAuditTime(a.at)}</span>
          <span className="font-medium">{auditActionLabel(a.action)}</span>
          <span className="text-muted-foreground">{a.actor}</span>
          {a.note && <span className="text-muted-foreground">— {a.note}</span>}
        </li>
      ))}
    </ul>
  );
}

// ── 상세 ────────────────────────────────────────────────────────────────────

export function LedgerEventDetail({
  event, allEvents, onClose,
}: {
  event: ResolvedEvent;
  allEvents: readonly ResolvedEvent[];
  onClose: () => void;
}) {
  const { saveEvent, assign } = useLedgerMutations();
  const [memo, setMemo] = useState(event.memo);
  const [tags, setTags] = useState<string[]>([...event.tags]);
  const [type, setType] = useState(event.type);
  const [tagInput, setTagInput] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [correcting, setCorrecting] = useState<EventTransactionLine | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  const dirty = memo !== event.memo
    || type !== event.type
    || tags.join("|") !== [...event.tags].join("|");

  const patchBase = { id: event.id, accountId: event.accountId, eventDate: event.date };

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); }
    catch (err) { toast.error(err instanceof Error ? err.message : "요청에 실패했습니다"); }
  }

  const saveMeta = () => run(
    () => saveEvent.mutateAsync({ ...patchBase, memo, tags, type }),
    "저장했습니다",
  );
  const toggleHidden = () => run(
    () => saveEvent.mutateAsync({ ...patchBase, hidden: !event.hidden }),
    event.hidden ? "다시 표시합니다" : "숨겼습니다",
  );

  /** 분리 — 고른 거래를 새 이벤트로 뗀다. 사용자는 "분리"만 알면 된다. */
  async function doSplit() {
    if (!picked.length) return;
    // 같은 날짜에 이미 분리 이벤트가 있으면 다음 번호를 쓴다.
    const used = allEvents.filter((e) => e.id.startsWith(`${defaultEventId(event.accountId, event.date)}#`)).length;
    const newId = splitEventId(event.accountId, event.date, used + 1);
    await run(async () => {
      await saveEvent.mutateAsync({
        id: newId, accountId: event.accountId, eventDate: event.date,
        type: event.type, isUserCreated: true,
      });
      await assign.mutateAsync({ transactionIds: picked, eventId: newId, action: "event_split" });
    }, `${picked.length}건을 새 이벤트로 분리했습니다`);
    setPicked([]);
  }

  /** 이동 — 고른 거래를 다른 이벤트로. 같은 계좌의 이벤트만 후보로 보여준다. */
  const moveTargets = useMemo(
    () => allEvents
      .filter((e) => e.accountId === event.accountId && e.id !== event.id)
      .slice(0, 50),
    [allEvents, event],
  );

  async function doMove(targetId: string) {
    if (!picked.length) return;
    await run(
      () => assign.mutateAsync({ transactionIds: picked, eventId: targetId, action: "tx_move" }),
      `${picked.length}건을 옮겼습니다`,
    );
    setPicked([]);
    setMoveOpen(false);
  }

  /** 기본 grouping 복귀 — override 를 지운다. 사용자는 "자동 분류로 되돌리기"로 읽는다. */
  const resetGrouping = () => run(
    () => assign.mutateAsync({
      transactionIds: event.lines.map((l) => l.effective.id),
      eventId: null, action: "tx_move",
    }),
    "자동 분류(계좌·거래일)로 되돌렸습니다",
  );

  const busy = saveEvent.isPending || assign.isPending;

  return (
    <>
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto p-0">
          {/* pr-12: 공용 Dialog 의 X 버튼(absolute right-4 top-4)과 제목이 겹치지 않게 비워둔다. */}
          <DialogHeader className="px-4 pt-3 pb-3 pr-12 border-b sticky top-0 bg-background z-10">
            {/* 모바일 전용 뒤로가기.
                데스크톱은 우상단 X 로 닫지만, 아이폰에서는 그 X 가 작고 본문이 스크롤되면
                시야에서 사라져서 "바깥을 살짝 눌러야 닫히는" 상태였다. sticky 헤더 안에
                두어 **스크롤 중에도 항상 보이게** 한다. 탭 영역은 44px 에 가깝게 잡았다. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="거래 이력으로 돌아가기"
              className="md:hidden -ml-2 mb-0.5 inline-flex w-fit min-h-9 items-center gap-0.5
                         self-start rounded-md py-2 pl-1.5 pr-2.5 text-xs font-medium
                         text-muted-foreground active:bg-muted"
            >
              <ChevronLeft className="w-4 h-4" />
              거래 이력
            </button>
            <DialogTitle className="text-base flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{eventDateLabel(event)}</span>
              <span className="text-muted-foreground font-normal">
                {ACCOUNT_LABELS_SHORT[event.accountId]}
              </span>
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {eventTypeLabel(event.type)}
              </Badge>
              {event.hidden && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">숨김</Badge>}
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground">
              매수 {event.buyCount}종목 {fmtAmount(event.buyAmount)}원 ·
              {" "}매도 {event.sellCount}종목 {fmtAmount(event.sellAmount)}원 ·
              {" "}거래 {event.tradeCount}건
            </p>
          </DialogHeader>

          <div className="px-4 pb-4 space-y-4">
            {/* ── 거래 목록 ── */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-semibold">체결 내역</h4>
                {event.lines.length > 1 && (
                  // 좁은 화면에서는 이 안내가 제목을 밀어내고 잘린다 — 체크박스가 이미
                  // 보이므로 넓은 화면에서만 띄운다.
                  <span className="hidden sm:inline text-[11px] text-muted-foreground">
                    선택하면 분리·이동할 수 있습니다
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {event.lines.map((l) => (
                  <TxLine
                    key={l.effective.id}
                    line={l}
                    selectable={event.lines.length > 1}
                    selected={picked.includes(l.effective.id)}
                    onSelect={(c) => setPicked((p) =>
                      c ? [...p, l.effective.id] : p.filter((x) => x !== l.effective.id))}
                    onCorrect={() => setCorrecting(l)}
                  />
                ))}
              </div>

              {picked.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 p-2.5">
                  <span className="text-[11px] font-medium">{picked.length}건 선택</span>
                  <div className="flex flex-wrap gap-2 ml-auto">
                    <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1" onClick={() => setPicked([])}>
                      해제
                    </Button>
                    <Button
                      variant="outline" size="sm" className="h-7 text-[11px] gap-1"
                      onClick={() => setMoveOpen(true)} disabled={busy || moveTargets.length === 0}
                    >
                      <ArrowRightLeft className="w-3 h-3" /> 다른 이벤트로 이동
                    </Button>
                    <Button
                      size="sm" className="h-7 text-[11px] gap-1"
                      onClick={doSplit}
                      disabled={busy || picked.length === event.lines.length}
                      title={picked.length === event.lines.length ? "전부 선택하면 분리할 것이 없습니다" : undefined}
                    >
                      <Scissors className="w-3 h-3" /> 새 이벤트로 분리
                    </Button>
                  </div>
                </div>
              )}
            </section>

            {/* ── 보유수량 변화 요약 ── */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold">이 이벤트로 바뀐 보유수량</h4>
              <div className="rounded-xl border divide-y text-xs">
                {Object.keys(event.postHoldings).length === 0 && (
                  <p className="p-3 text-muted-foreground">변동 없음</p>
                )}
                {Object.entries(event.postHoldings).map(([ticker, after]) => {
                  const before = event.preHoldings[ticker] ?? 0;
                  const name = event.lines.find((l) => l.effective.ticker === ticker)?.effective.etfName ?? ticker;
                  return (
                    <div key={ticker} className="flex items-center gap-2 p-2.5">
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="tabular-nums text-muted-foreground shrink-0">
                        {fmtQty(before)} → <strong className="text-foreground">{fmtQty(after)}</strong>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ── 분류 정보 ── */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold">메모 · 태그 · 유형</h4>

              <Textarea
                value={memo} onChange={(e) => setMemo(e.target.value)}
                placeholder="예: 반도체 비중 축소 / 월 정기납입 / ISA 현금 확보"
                rows={2} className="text-sm"
              />

              <div className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <button
                    key={t} type="button"
                    onClick={() => setTags((s) => s.filter((x) => x !== t))}
                    className="h-6 px-2 rounded-md bg-secondary text-[11px] inline-flex items-center gap-1"
                  >
                    #{t} <X className="w-2.5 h-2.5" />
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && tagInput.trim()) {
                      e.preventDefault();
                      setTags((s) => [...new Set([...s, tagInput.trim()])]);
                      setTagInput("");
                    }
                  }}
                  placeholder="태그 입력 후 Enter" className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {SUGGESTED_TAGS.filter((t) => !tags.includes(t)).map((t) => (
                  <button
                    key={t} type="button"
                    onClick={() => setTags((s) => [...s, t])}
                    className="h-6 px-2 rounded-md border text-[11px] text-muted-foreground hover:bg-muted"
                  >
                    + {t}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap gap-1 pt-1">
                {EVENT_TYPE_OPTIONS.map((t) => (
                  <button
                    key={t} type="button" onClick={() => setType(t)}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                      type === t
                        ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-300/60"
                        : "text-muted-foreground border-transparent hover:bg-muted"
                    }`}
                  >
                    {eventTypeLabel(t)}
                  </button>
                ))}
              </div>

              <div className="flex justify-end">
                <Button size="sm" className="h-8" onClick={saveMeta} disabled={!dirty || busy}>
                  <Check className="w-3.5 h-3.5 mr-1" /> 저장
                </Button>
              </div>
            </section>

            {/* ── 그 밖의 동작 ── */}
            <section className="flex flex-wrap gap-2 pt-1 border-t">
              <Button variant="outline" size="sm" className="h-8 text-[11px] gap-1.5 mt-3" onClick={toggleHidden} disabled={busy}>
                {event.hidden ? <><Eye className="w-3.5 h-3.5" /> 다시 표시</> : <><EyeOff className="w-3.5 h-3.5" /> 숨기기</>}
              </Button>
              {event.regrouped && (
                <Button variant="outline" size="sm" className="h-8 text-[11px] gap-1.5 mt-3" onClick={resetGrouping} disabled={busy}>
                  <RotateCcw className="w-3.5 h-3.5" /> 자동 분류로 되돌리기
                </Button>
              )}
              <Button
                variant="ghost" size="sm" className="h-8 text-[11px] gap-1.5 mt-3"
                onClick={() => setShowAudit((v) => !v)}
              >
                <History className="w-3.5 h-3.5" /> 변경 이력
              </Button>
            </section>

            {showAudit && (
              <section className="rounded-xl border p-3">
                <AuditList eventId={event.id} />
              </section>
            )}

            <p className="text-[10px] text-muted-foreground leading-relaxed">
              숨김·메모·태그·분리·이동은 분류 정보일 뿐이며 증권사 체결 기록 자체를 바꾸지 않습니다.
              거래정보 정정도 원본을 그대로 두고 정정값을 따로 저장합니다.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {correcting && <CorrectDialog line={correcting} onClose={() => setCorrecting(null)} />}

      {moveOpen && (
        <Dialog open onOpenChange={() => setMoveOpen(false)}>
          <DialogContent className="max-w-sm max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base">어느 이벤트로 옮길까요?</DialogTitle>
            </DialogHeader>
            <p className="text-[11px] text-muted-foreground">
              같은 계좌({ACCOUNT_LABELS_SHORT[event.accountId]})의 이벤트만 고를 수 있습니다.
            </p>
            <div className="space-y-1">
              {moveTargets.map((t) => (
                <button
                  key={t.id} type="button" onClick={() => doMove(t.id)} disabled={busy}
                  className="w-full text-left px-3 py-2 rounded-lg border hover:bg-muted text-xs disabled:opacity-50"
                >
                  <span className="tabular-nums font-medium">{eventDateLabel(t)}</span>
                  <span className="text-muted-foreground"> · {eventTypeLabel(t.type)} · 거래 {t.tradeCount}건</span>
                  {t.memo && <p className="text-[11px] text-muted-foreground truncate">{t.memo}</p>}
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
