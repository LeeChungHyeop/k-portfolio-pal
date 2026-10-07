// ─────────────────────────────────────────────────────────────────────────────
// 거래 이력 — 전역 페이지
//
// 리밸런싱 이력의 source of truth 는 **실제 체결내역**이다. 이 화면은 그것만 보여준다 —
// 과거 목표비중으로 "이렇게 리밸런싱했을 것"을 역산하지 않는다.
//
// 기본 단위는 개별 체결이 아니라 **Rebalance Event**(동일 계좌 + 동일 거래일)다.
// 파생값(건수·금액·전후 보유수량)은 DB 에 없고 `ledger.ts resolveEvents` 가 계산한다.
//
// legacy `AccountState.history` 와 그걸 읽는 모듈(snapshot / benchmark / backtest /
// 계좌 화면 히스토리 탭)은 **이 화면과 무관하다.** 여기서는 신규 /api/ledger 만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import {
  Search, SlidersHorizontal, X, Database, RefreshCw, AlertTriangle,
  ReceiptText, Eye, EyeOff, Merge, Pencil, ChevronRight,
} from "lucide-react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore } from "@/lib/kaw/store";
import {
  filterEvents, eventFacets, defaultEventId,
  type EventFilter, type ResolvedEvent, type TradeSide,
} from "@/lib/kaw/ledger";
import { useLedger, useResolvedEvents, useLedgerMutations } from "@/lib/kaw/useLedger";
import {
  eventTypeLabel, eventDateLabel, eventDateConfidence, topEtfLabel, fmtAmount,
} from "@/lib/kaw/ledger-ui";
import { LedgerEventDetail } from "@/components/kaw/LedgerEventDetail";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

// ── 상태 안내 (loading / unavailable / error / empty 를 명확히 구분한다) ────

function StateBlock({
  icon: Icon, title, detail, tone = "muted",
}: {
  icon: typeof Database; title: string; detail?: string;
  tone?: "muted" | "warn";
}) {
  return (
    <div className="py-16 px-4 grid place-items-center text-center">
      <div className="space-y-2 max-w-sm">
        <Icon className={`w-7 h-7 mx-auto ${tone === "warn" ? "text-amber-500" : "text-muted-foreground/40"}`} />
        <p className="text-sm font-medium">{title}</p>
        {detail && <p className="text-[12px] leading-relaxed text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

// ── 필터 ────────────────────────────────────────────────────────────────────

interface FilterState {
  from: string;
  to: string;
  accountIds: AccountId[];
  side: TradeSide | "";
  types: string[];
  tags: string[];
  query: string;
  includeHidden: boolean;
}

const EMPTY_FILTER: FilterState = {
  from: "", to: "", accountIds: [], side: "", types: [], tags: [], query: "", includeHidden: false,
};

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs border transition-colors whitespace-nowrap ${
        active
          ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-300/60 dark:border-violet-700/60 font-medium"
          : "text-muted-foreground border-transparent hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function FilterBar({
  value, onChange, facets, resultCount, totalCount,
}: {
  value: FilterState;
  onChange: (f: FilterState) => void;
  facets: ReturnType<typeof eventFacets>;
  resultCount: number;
  totalCount: number;
}) {
  // 모바일에서는 접어 둔다 — 필터가 화면을 다 먹으면 목록을 볼 수 없다.
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  const activeCount =
    (value.from || value.to ? 1 : 0) + (value.accountIds.length ? 1 : 0)
    + (value.side ? 1 : 0) + (value.types.length ? 1 : 0)
    + (value.tags.length ? 1 : 0) + (value.includeHidden ? 1 : 0);

  return (
    <Card className="p-3 md:p-4 space-y-3">
      {/* 검색은 항상 보인다 — 가장 많이 쓰는 입력이다 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={value.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="종목명 · 종목코드 · 메모 · 태그"
            className="pl-8 h-9 text-sm"
          />
          {value.query && (
            <button
              type="button"
              onClick={() => set({ query: "" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
              aria-label="검색어 지우기"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <Button
          variant="outline" size="sm"
          onClick={() => setOpen((v) => !v)}
          className="h-9 shrink-0 gap-1.5"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">필터</span>
          {activeCount > 0 && (
            <span className="px-1.5 rounded bg-violet-500/20 text-violet-600 dark:text-violet-300 text-[10px]">
              {activeCount}
            </span>
          )}
        </Button>
      </div>

      {open && (
        <div className="space-y-3 pt-1 border-t">
          <div>
            <p className="text-[11px] text-muted-foreground mb-1.5">기간</p>
            <div className="flex items-center gap-2">
              <Input
                type="date" value={value.from} onChange={(e) => set({ from: e.target.value })}
                className="h-8 text-xs flex-1 min-w-0"
              />
              <span className="text-xs text-muted-foreground shrink-0">~</span>
              <Input
                type="date" value={value.to} onChange={(e) => set({ to: e.target.value })}
                className="h-8 text-xs flex-1 min-w-0"
              />
            </div>
          </div>

          <div>
            <p className="text-[11px] text-muted-foreground mb-1.5">계좌</p>
            <div className="flex flex-wrap gap-1">
              {ACCOUNT_IDS.map((id) => (
                <Chip
                  key={id}
                  active={value.accountIds.includes(id)}
                  onClick={() => set({ accountIds: toggle(value.accountIds, id) })}
                >
                  {ACCOUNT_LABELS_SHORT[id]}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[11px] text-muted-foreground mb-1.5">매매</p>
            <div className="flex flex-wrap gap-1">
              <Chip active={value.side === "buy"} onClick={() => set({ side: value.side === "buy" ? "" : "buy" })}>
                매수 포함
              </Chip>
              <Chip active={value.side === "sell"} onClick={() => set({ side: value.side === "sell" ? "" : "sell" })}>
                매도 포함
              </Chip>
            </div>
          </div>

          {facets.types.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">이벤트 유형</p>
              <div className="flex flex-wrap gap-1">
                {facets.types.map((t) => (
                  <Chip key={t} active={value.types.includes(t)} onClick={() => set({ types: toggle(value.types, t) })}>
                    {eventTypeLabel(t)}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {facets.tags.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">태그</p>
              <div className="flex flex-wrap gap-1">
                {facets.tags.map((t) => (
                  <Chip key={t} active={value.tags.includes(t)} onClick={() => set({ tags: toggle(value.tags, t) })}>
                    #{t}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={value.includeHidden}
                onCheckedChange={(c) => set({ includeHidden: c === true })}
              />
              숨긴 이벤트도 보기
            </label>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange(EMPTY_FILTER)}>
              필터 초기화
            </Button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {resultCount === totalCount
          ? `${totalCount}건`
          : `${resultCount}건 / 전체 ${totalCount}건`}
      </p>
    </Card>
  );
}

// ── 목록 한 줄 ──────────────────────────────────────────────────────────────

function EventBadges({ e }: { e: ResolvedEvent }) {
  const conf = eventDateConfidence(e);
  return (
    <>
      {e.hidden && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] gap-1 text-muted-foreground">
          <EyeOff className="w-2.5 h-2.5" /> 숨김
        </Badge>
      )}
      {e.regrouped && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-violet-300/60 text-violet-600 dark:text-violet-300">
          수정됨
        </Badge>
      )}
      {!conf.direct && (
        <Badge
          variant="outline" title={conf.detail}
          className="h-5 px-1.5 text-[10px] border-amber-300/60 text-amber-700 dark:text-amber-300"
        >
          날짜 {conf.label}
        </Badge>
      )}
      {e.lines.some((l) => l.effective.corrected) && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-sky-300/60 text-sky-700 dark:text-sky-300">
          정정
        </Badge>
      )}
    </>
  );
}

function EventRow({
  e, selected, selectable, onSelect, onOpen,
}: {
  e: ResolvedEvent;
  selected: boolean;
  selectable: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <>
      {/* ── 데스크톱: 표 한 줄 ── */}
      <tr
        className={`hidden md:table-row border-b last:border-0 hover:bg-muted/40 cursor-pointer ${
          e.hidden ? "opacity-55" : ""
        }`}
        onClick={onOpen}
      >
        {selectable && (
          <td className="py-2 pl-3 pr-1 w-8" onClick={(ev) => ev.stopPropagation()}>
            <Checkbox checked={selected} onCheckedChange={(c) => onSelect(c === true)} />
          </td>
        )}
        <td className="py-2 px-2 whitespace-nowrap text-xs tabular-nums">{eventDateLabel(e)}</td>
        <td className="py-2 px-2 whitespace-nowrap text-xs">{ACCOUNT_LABELS_SHORT[e.accountId]}</td>
        <td className="py-2 px-2 whitespace-nowrap text-xs">{eventTypeLabel(e.type)}</td>
        <td className="py-2 px-2 text-right text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
          {e.buyCount || "—"}
        </td>
        <td className="py-2 px-2 text-right text-xs tabular-nums text-rose-600 dark:text-rose-400">
          {e.sellCount || "—"}
        </td>
        <td className="py-2 px-2 text-right text-xs tabular-nums">
          {e.buyAmount ? fmtAmount(e.buyAmount) : "—"}
        </td>
        <td className="py-2 px-2 text-right text-xs tabular-nums">
          {e.sellAmount ? fmtAmount(e.sellAmount) : "—"}
        </td>
        <td className="py-2 px-2 text-xs max-w-[200px] truncate" title={e.topEtfNames.join(", ")}>
          {topEtfLabel(e)}
        </td>
        <td className="py-2 px-2 text-xs max-w-[160px] truncate text-muted-foreground" title={e.memo}>
          {e.memo || "—"}
        </td>
        <td className="py-2 px-2">
          <div className="flex flex-wrap items-center gap-1">
            {e.tags.map((t) => (
              <Badge key={t} variant="secondary" className="h-5 px-1.5 text-[10px]">#{t}</Badge>
            ))}
            <EventBadges e={e} />
          </div>
        </td>
        <td className="py-2 pr-3 text-right">
          <ChevronRight className="w-4 h-4 text-muted-foreground/50 inline" />
        </td>
      </tr>

      {/* ── 모바일: 카드 ── 표를 가로 스크롤시키지 않는다 */}
      <tr className="md:hidden">
        <td colSpan={99} className="p-0">
          <div
            onClick={onOpen}
            className={`border-b last:border-0 px-3 py-2.5 active:bg-muted/50 ${e.hidden ? "opacity-55" : ""}`}
          >
            <div className="flex items-start gap-2">
              {selectable && (
                <div className="pt-0.5" onClick={(ev) => ev.stopPropagation()}>
                  <Checkbox checked={selected} onCheckedChange={(c) => onSelect(c === true)} />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium tabular-nums">{eventDateLabel(e)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {ACCOUNT_LABELS_SHORT[e.accountId]} · {eventTypeLabel(e.type)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate">{topEtfLabel(e)}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                  {e.buyCount > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      매수 {e.buyCount}종목 {fmtAmount(e.buyAmount)}
                    </span>
                  )}
                  {e.sellCount > 0 && (
                    <span className="text-rose-600 dark:text-rose-400">
                      매도 {e.sellCount}종목 {fmtAmount(e.sellAmount)}
                    </span>
                  )}
                </div>
                {e.memo && <p className="text-[11px] text-muted-foreground truncate">{e.memo}</p>}
                {/* 배지는 데스크톱과 같은 조건으로 띄운다 — 정정·추정 날짜가 모바일에서만
                    사라지면 같은 이벤트가 화면 크기에 따라 달라 보인다. */}
                {(e.tags.length > 0 || e.hidden || e.regrouped
                  || e.lines.some((l) => l.effective.corrected)
                  || !eventDateConfidence(e).direct) && (
                  <div className="flex flex-wrap items-center gap-1">
                    {e.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="h-5 px-1.5 text-[10px]">#{t}</Badge>
                    ))}
                    <EventBadges e={e} />
                  </div>
                )}
              </div>
              {/* 카드 좌우 패딩이 px-3 뿐이라 화살표가 화면 끝에 붙어 잘린 것처럼 보였다.
                  mr-2 로 8px 더 안쪽에 둔다(총 20px). 본문은 flex-1 이라 8px 만 줄어든다. */}
              <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-1 mr-2" />
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

// ── 페이지 ──────────────────────────────────────────────────────────────────

export function LedgerPage() {
  const { currentUser } = usePortfolioStore();
  const ledger = useLedger(!!currentUser);
  const allEvents = useResolvedEvents(ledger.data);
  const { assign } = useLedgerMutations();

  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  // 병합 모드 — 체크박스로 여러 이벤트를 고른 뒤 하나로 합친다.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const facets = useMemo(() => eventFacets(allEvents), [allEvents]);
  const events = useMemo(() => {
    const f: EventFilter = {
      from: filter.from || undefined,
      to: filter.to || undefined,
      accountIds: filter.accountIds.length ? filter.accountIds : undefined,
      side: filter.side || undefined,
      types: filter.types.length ? filter.types : undefined,
      tags: filter.tags.length ? filter.tags : undefined,
      query: filter.query || undefined,
      includeHidden: filter.includeHidden,
    };
    return filterEvents(allEvents, f);
  }, [allEvents, filter]);

  const openEvent = openId ? allEvents.find((e) => e.id === openId) ?? null : null;

  const selectedEvents = selected
    .map((id) => allEvents.find((e) => e.id === id))
    .filter((e): e is ResolvedEvent => !!e);

  // 병합은 **같은 계좌끼리만** 허용한다 — 다른 계좌 거래를 한 이벤트에 담으면
  // "그 이벤트의 계좌"가 무엇인지 말할 수 없게 된다.
  const mergeBlocked = selectedEvents.length >= 2
    && new Set(selectedEvents.map((e) => e.accountId)).size > 1;

  async function doMerge() {
    if (selectedEvents.length < 2 || mergeBlocked) return;
    // 가장 이른 이벤트로 합친다 — 사용자가 "그 날의 작업"으로 기억하는 쪽이 보통 앞이다.
    const sorted = [...selectedEvents].sort((a, b) => a.date.localeCompare(b.date));
    const target = sorted[0];
    const movingIds = sorted.slice(1).flatMap((e) => e.lines.map((l) => l.effective.id));
    try {
      await assign.mutateAsync({
        transactionIds: movingIds, eventId: target.id, action: "event_merge",
      });
      toast.success(`${selectedEvents.length}개 이벤트를 ${target.date} 로 병합했습니다`);
      setSelected([]);
      setSelectMode(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "병합에 실패했습니다");
    }
  }

  // ── 상태 분기 — loading / error / unavailable / empty 를 섞지 않는다 ──
  function Body() {
    if (ledger.isLoading) {
      return <StateBlock icon={RefreshCw} title="거래 원장을 불러오는 중…" />;
    }
    if (ledger.isError) {
      return (
        <StateBlock
          icon={AlertTriangle} tone="warn" title="거래 원장을 불러오지 못했습니다"
          detail="잠시 후 다시 시도해주세요. 다른 화면(대시보드·계좌)은 영향을 받지 않습니다."
        />
      );
    }
    if (ledger.data?.unavailable) {
      return (
        <StateBlock
          icon={Database} title="거래 원장 기능이 아직 활성화되지 않았습니다"
          detail="migration 004 를 적용하면 실제 체결내역 기반 거래 이력이 여기에 표시됩니다. 그때까지 다른 화면은 평소대로 동작합니다."
        />
      );
    }
    if (allEvents.length === 0) {
      return (
        <StateBlock
          icon={ReceiptText} title="아직 적재된 거래가 없습니다"
          detail="증권사 체결내역을 적재하면 계좌·날짜별 매매 이벤트가 여기에 쌓입니다."
        />
      );
    }
    if (events.length === 0) {
      return (
        <StateBlock
          icon={Search} title="조건에 맞는 거래가 없습니다"
          detail="필터를 줄이거나 검색어를 지워보세요."
        />
      );
    }
    return (
      <div className="overflow-hidden">
        <table className="w-full">
          <thead className="hidden md:table-header-group">
            <tr className="border-b text-[11px] text-muted-foreground">
              {selectMode && <th className="w-8 pl-3" />}
              <th className="py-2 px-2 text-left font-medium">거래일</th>
              <th className="py-2 px-2 text-left font-medium">계좌</th>
              <th className="py-2 px-2 text-left font-medium">유형</th>
              <th className="py-2 px-2 text-right font-medium">매수</th>
              <th className="py-2 px-2 text-right font-medium">매도</th>
              <th className="py-2 px-2 text-right font-medium">매수금액</th>
              <th className="py-2 px-2 text-right font-medium">매도금액</th>
              <th className="py-2 px-2 text-left font-medium">주요 종목</th>
              <th className="py-2 px-2 text-left font-medium">메모</th>
              <th className="py-2 px-2 text-left font-medium">태그</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <EventRow
                key={e.id}
                e={e}
                selectable={selectMode}
                selected={selected.includes(e.id)}
                onSelect={(c) => setSelected((s) => (c ? [...s, e.id] : s.filter((x) => x !== e.id)))}
                onOpen={() => (selectMode ? undefined : setOpenId(e.id))}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const showTools = !ledger.isLoading && !ledger.data?.unavailable && allEvents.length > 0;

  return (
    <div className="space-y-4 pb-24 md:pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">거래 이력</h2>
          <p className="text-[11px] text-muted-foreground">
            실제 증권사 체결내역 기준입니다. 같은 계좌·같은 거래일의 체결이 하나의 이벤트로 묶입니다.
          </p>
        </div>
        {showTools && (
          <Button
            variant={selectMode ? "default" : "outline"} size="sm" className="h-8 gap-1.5"
            onClick={() => { setSelectMode((v) => !v); setSelected([]); }}
          >
            <Merge className="w-3.5 h-3.5" />
            {selectMode ? "병합 취소" : "이벤트 병합"}
          </Button>
        )}
      </div>

      {showTools && (
        <FilterBar
          value={filter} onChange={setFilter} facets={facets}
          resultCount={events.length} totalCount={allEvents.length}
        />
      )}

      <Card className="p-0 overflow-hidden"><Body /></Card>

      {/* 병합 모드 액션 바 — 모바일에서도 손가락이 닿는 곳에 고정한다 */}
      {selectMode && selected.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t bg-background/95 backdrop-blur px-4 py-3 md:static md:border md:rounded-xl md:bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              <span className="font-medium">{selected.length}개 선택</span>
              {mergeBlocked && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  서로 다른 계좌는 병합할 수 없습니다
                </span>
              )}
              {!mergeBlocked && selected.length >= 2 && (
                <span className="ml-2 text-muted-foreground">
                  가장 이른 날짜({[...selectedEvents].sort((a, b) => a.date.localeCompare(b.date))[0].date})로 합칩니다
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelected([])}>
                선택 해제
              </Button>
              <Button
                size="sm" className="h-8"
                disabled={selected.length < 2 || mergeBlocked || assign.isPending}
                onClick={doMerge}
              >
                {assign.isPending ? "병합 중…" : "병합"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {openEvent && (
        <LedgerEventDetail
          event={openEvent}
          allEvents={allEvents}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
