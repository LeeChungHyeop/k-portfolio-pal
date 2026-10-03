// ─────────────────────────────────────────────────────────────────────────────
// 일별 자산 스냅샷 행 만들기 — 순수 함수 (Supabase 의존성 없음)
//
// Worker 의 cron(data-server.ts writeDailySnapshots)이 DB 에서 읽어온 값을 그대로 넘기고,
// 여기서 "그 날 그 계좌의 한 행"을 만든다. DB 접근과 분리해 둔 이유는 규칙을 테스트로
// 고정하기 위해서다.
//
// 금액 정의 (앱 · live view 와 동일):
//   ETF 평가액 = 마지막으로 확정된 리밸런싱의 rowQuantitiesSnap x 그 시점 시세
//   총자산     = ETF 평가액 + 실제 예수금(cashBalance)
//   deposit(월 납입액)은 총자산에 **더하지 않는다.**
//
// 정확성 규칙 (추정하지 않는다):
//   - 보유종목 중 신선한 시세를 못 구한 종목이 **하나라도** 있으면 그 계좌의 그 날 행을
//     만들지 않는다. 일부만 최신인 평가액은 그 날 성과를 틀리게 만든다.
//   - rowHoldingsSnap(저장된 평가금액) 폴백을 쓰지 않는다 — 화면 표시용 폴백이지
//     그 날의 시세가 아니다.
//   - **외부 입출금(cashflow)을 여기에 복사해두지 않는다.** 장부는 과거 날짜에 나중에
//     추가·수정·삭제될 수 있어서 복사본이 곧 stale 해진다. source of truth 는 항상
//     AccountState.cashflows 이고, 기간 성과는 이 평가액 + 계산 시점의 현재 장부로 낸다.
//   - 한국 공휴일은 판단하지 않는다. 휴장일에 만들어지는 행은 직전 거래일 종가 x 보유수량
//     이고, 그것은 그 날의 실제 평가액으로서 옳다(그 날 손익이 0이 될 뿐이다).
//
// 같은 날 여러 번 돌아도 (family_code, profile, account_type, snapshot_date) 가 같으므로
// DB 의 PK + upsert 로 한 행만 유지된다. 이 함수는 같은 입력에 대해 항상 같은 키를 낸다.
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotPrice {
  price: number;
  /** ISO 문자열 */
  fetchedAt: string;
}

export interface SnapshotHistoryLike {
  date: string;
  rowQuantitiesSnap?: Record<string, number>;
  rowEtfSnap?: Record<string, string>;
}

export interface SnapshotAccountInput {
  familyCode: string;
  profile: string;
  accountType: string;
  history: readonly SnapshotHistoryLike[];
  cashBalance?: number;
}

export interface SnapshotRow {
  family_code: string;
  profile: string;
  account_type: string;
  snapshot_date: string;
  market_value: number;
  cash_balance: number;
  total_asset_value: number;
  price_fetched_at: string | null;
  holding_count: number;
}

export type SnapshotSkip = { label: string; reason: string };

export interface BuildSnapshotRowsResult {
  rows: SnapshotRow[];
  skipped: SnapshotSkip[];
}

export const SNAPSHOT_UPSERT_CONFLICT = "family_code,profile,account_type,snapshot_date";

/** UTC 시각 → 한국시간 기준 YYYY-MM-DD */
export function kstDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * UTC 시각 → 한국시간 기준 YYYY-MM.
 *
 * 브라우저 local timezone 에 의존하지 않고 고정 +9 로 계산한다(KST 는 서머타임이 없다).
 * `toISOString().slice(0, 7)` 을 그대로 쓰면 매월 1일 00:00~08:59 KST 에 **이전 달**이 나온다
 * (예: 2026-11-01 00:30 KST = UTC 2026-10-31 → "2026-10").
 */
export function kstMonthString(at: Date = new Date()): string {
  return kstDateString(at).slice(0, 7);
}

/**
 * 한국시간 기준 "마지막 거래일" — 주말이면 직전 금요일, 평일이면 그 날.
 *
 * 공휴일은 보지 않는다(앱 규칙: 주말만 롤백, 비거래일 종가는 서버가 폴백한다).
 *
 * 요일 판정은 **KST 날짜 문자열을 UTC 자정으로 파싱해서** 한다 — `new Date().getDay()` 는
 * 브라우저/OS timezone 의 요일이고, 거기서 날짜를 뺀 뒤 다시 `toISOString()` 으로 UTC 로
 * 돌리면 KST 자정 부근에 하루가 더 밀린다(예: 토 00:30 KST → 로컬 금요일 → UTC 목요일).
 */
export function lastTradingDayKst(at: Date = new Date()): string {
  const kstDate = kstDateString(at);
  const t = Date.parse(`${kstDate}T00:00:00Z`);
  const dayOfWeek = new Date(t).getUTCDay(); // 0=일 … 6=토 (timezone 무관)
  const back = dayOfWeek === 6 ? 1 : dayOfWeek === 0 ? 2 : 0;
  return back === 0 ? kstDate : new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** 한국시간 기준 HH:MM */
export function kstTimeString(at: Date = new Date()): string {
  return new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);
}

function lastConfirmed(history: readonly SnapshotHistoryLike[]): SnapshotHistoryLike | null {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted[sorted.length - 1];
}

export function buildDailySnapshotRows(
  accounts: readonly SnapshotAccountInput[],
  /** ETF명 → 종목코드 */
  tickerByEtf: ReadonlyMap<string, string>,
  /** 종목코드(대문자) → 신선한 시세. 신선하지 않은 시세는 애초에 넣지 않는다. */
  freshPriceByTicker: ReadonlyMap<string, SnapshotPrice>,
  snapshotDate: string,
): BuildSnapshotRowsResult {
  const rows: SnapshotRow[] = [];
  const skipped: SnapshotSkip[] = [];

  for (const acc of accounts) {
    const label = `${acc.familyCode}/${acc.profile}/${acc.accountType}`;
    // _shared / _meta 같은 예약 프로필은 계좌가 아니다.
    if (acc.profile.startsWith("_")) continue;

    const last = lastConfirmed(acc.history);
    if (!last) { skipped.push({ label, reason: "history 없음" }); continue; }
    const qtySnap = last.rowQuantitiesSnap;
    if (!qtySnap || Object.keys(qtySnap).length === 0) {
      skipped.push({ label, reason: "확정 보유수량 없음" });
      continue;
    }

    let marketValue = 0;
    let holdingCount = 0;
    let oldestFetchedAt: string | null = null;
    let missing: string | null = null;

    for (const [rowId, rawQty] of Object.entries(qtySnap)) {
      const qty = Number(rawQty ?? 0);
      if (!(qty > 0)) continue;
      const etfName = last.rowEtfSnap?.[rowId] ?? rowId;
      const ticker = tickerByEtf.get(etfName);
      const fp = ticker ? freshPriceByTicker.get(ticker.toUpperCase()) : undefined;
      if (!fp || !(fp.price > 0)) { missing = etfName; break; }
      marketValue += qty * fp.price;
      holdingCount += 1;
      if (!oldestFetchedAt || fp.fetchedAt < oldestFetchedAt) oldestFetchedAt = fp.fetchedAt;
    }

    if (missing) { skipped.push({ label, reason: `시세 없음/오래됨 (${missing})` }); continue; }
    if (!holdingCount) { skipped.push({ label, reason: "평가 가능한 보유종목 없음" }); continue; }

    const cash = Math.round(Number(acc.cashBalance ?? 0) || 0);
    const market = Math.round(marketValue);

    rows.push({
      family_code: acc.familyCode,
      profile: acc.profile,
      account_type: acc.accountType,
      snapshot_date: snapshotDate,
      market_value: market,
      cash_balance: cash,
      // 총자산 = ETF 평가액 + 실제 예수금. deposit 은 더하지 않는다.
      total_asset_value: market + cash,
      price_fetched_at: oldestFetchedAt,
      holding_count: holdingCount,
    });
  }

  return { rows, skipped };
}
