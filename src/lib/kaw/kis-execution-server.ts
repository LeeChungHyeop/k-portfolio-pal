// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kis/executions/preview — 한국투자 체결내역 **읽기 전용 미리보기** (Phase 4-B)
//
//   요청  { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }      연금저축(상품코드 22) 고정
//   응답  KisExecutionPreviewResponse (kis-execution-compose.ts)
//
// 순서가 곧 안전장치다:
//   세션 → 요청 모양 → 소유권(authorizeKisAccess) → credential 설정 → 계좌 등록·운용방식 →
//   토큰 → 조회(구간별 GET, 재시도 없음) → 원장 읽기 → 조립
// 앞 단계가 막히면 뒤 단계(토큰 발급 포함)를 실행하지 않는다.
//
// ## 하지 않는 것
//   · 쓰기: 이 파일에는 insert / upsert / update / delete / rpc 가 없다(테스트로 고정)
//   · 원장 반영 · 리밸런싱 완료 기록 생성 · cashflow 생성
//   · 응답 원문 · 계좌번호 · 키 · 토큰의 저장·로그·응답 포함
//   · 자동 재시도 — 실패하면 사유를 분류해 돌려주고 끝낸다
//
// credential(KIS_ACCOUNT_APP_KEY / KIS_ACCOUNT_APP_SECRET / KIS_ACCOUNT_CANO / 소유 가족·프로필)이 없는 환경
// (= 지금 운영)에서는 503 `not_configured` 를 돌려줄 뿐 어떤 외부 호출도 하지 않는다. 기존
// 기능은 이 경로와 무관하게 동작한다.
// ─────────────────────────────────────────────────────────────────────────────

import { json, requireSession, serviceClient } from "./data-server";
import { authorizeKisAccess, resolveKisAccountApp, type KisAccountEnv } from "./kis-account-read";
import { getKisAccessToken, type KVLike } from "./kis-server";
import { redactKisSecrets, type KisAccountCredentials } from "./kis-account-server";
import { parseBrokerAccounts, type BrokerAccountInstance } from "./broker-account";
import { kisApiQueryGate } from "./broker-connection";
import { kstDateString } from "./snapshot";
import type { AccountId } from "./constants";
import type { LedgerTransaction, TransactionCorrection, TradeSide } from "./ledger";
import type { CashFlowInput } from "./derived-cash";
import {
  CCLD_DEFAULT_MAX_PAGES,
  fetchCcldWindow,
  planCcldWindows,
  type CcldFetchResult,
  type FetchLike,
  type ParsedCcldRow,
  type CcldSummary,
} from "./kis-ccld-history";
import {
  composeExecutionPreview,
  type ExecQueryInfo,
  type KisExecutionPreviewResponse,
} from "./kis-execution-compose";

/** data-server 의 serviceClient 가 돌려주는 클라이언트 타입(supabase-js 를 직접 import 하지 않는다 — 서버 모듈 경계 테스트) */
type ServiceClient = NonNullable<ReturnType<typeof serviceClient>>;

export const EXEC_ACCOUNT_TYPE: AccountId = "pension";
export const EXEC_PRODUCT_CODE = "22";
/** 한 번에 조회할 수 있는 최대 기간(일). 3개월 이전 구간을 쪼개도 호출 수가 작게 유지된다 */
export const EXEC_MAX_SPAN_DAYS = 93;
const LEDGER_ROW_LIMIT = 5000;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toYmd = (iso: string) => iso.replaceAll("-", "");
function isRealIso(d: unknown): d is string {
  if (typeof d !== "string" || !ISO.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
const spanDays = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 + 1;

export interface ExecDeps {
  fetchImpl?: FetchLike;
  /** 테스트 주입. 기본은 KV 캐시를 쓰는 getKisAccessToken */
  getToken?: (env: KisAccountEnv, cred: Pick<KisAccountCredentials, "appKey" | "appSecret">) => Promise<string>;
  today?: () => string;
}

const defaultGetToken: NonNullable<ExecDeps["getToken"]> = (env, c) =>
  getKisAccessToken(c.appKey, c.appSecret, env.RATE_LIMIT as KVLike | undefined);

// ── 서버 행(snake_case) → 도메인 타입 (useLedger.ts 의 매핑과 같다. 그 파일은 react-query 를 끌어와 서버에서 쓸 수 없다) ──

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const dateStr = (v: unknown): string => String(v ?? "").slice(0, 10);

export function ledgerRowToTransaction(r: Record<string, unknown>): LedgerTransaction {
  return {
    id: String(r.id),
    accountId: r.account_type as AccountId,
    ticker: String(r.ticker),
    etfName: String(r.etf_name ?? ""),
    side: r.side === "sell" ? "sell" : "buy",
    quantity: num(r.quantity),
    price: num(r.price),
    amount: num(r.amount),
    tradeDate: r.trade_date ? dateStr(r.trade_date) : null,
    settlementDate: r.settlement_date ? dateStr(r.settlement_date) : null,
    inferredTradeDate: r.inferred_trade_date ? dateStr(r.inferred_trade_date) : null,
    eventDate: dateStr(r.event_date),
    tradeDateEvidence: String(r.trade_date_evidence ?? ""),
    fee: numOrNull(r.fee),
    tax: numOrNull(r.tax),
    postQuantity: numOrNull(r.post_quantity),
    source: String(r.source ?? ""),
    sourceFile: (r.source_file as string | null) ?? null,
    sourceRow: (r.source_row as number | null) ?? null,
    sourceFingerprint: typeof r.source_fingerprint === "string" ? r.source_fingerprint : undefined,
    fingerprintVersion: typeof r.fingerprint_version === "number" ? r.fingerprint_version : undefined,
    importBatchId: (r.import_batch_id as string | null) ?? null,
  };
}

export function correctionRowToOverlay(r: Record<string, unknown>): TransactionCorrection {
  return {
    transactionId: String(r.transaction_id),
    correctedQuantity: numOrNull(r.corrected_quantity),
    correctedPrice: numOrNull(r.corrected_price),
    correctedAmount: numOrNull(r.corrected_amount),
    correctedTradeDate: r.corrected_trade_date ? dateStr(r.corrected_trade_date) : null,
    correctedSide: r.corrected_side === "buy" || r.corrected_side === "sell" ? (r.corrected_side as TradeSide) : null,
    correctedTicker: (r.corrected_ticker as string | null) ?? null,
    excluded: r.excluded === true,
    reason: (r.reason as string | null) ?? null,
  };
}

// ── DB 읽기 (읽기 전용) ─────────────────────────────────────────────────────

interface LedgerBundle {
  ok: boolean;
  ledger: LedgerTransaction[];
  corrections: Map<string, TransactionCorrection>;
  flows: CashFlowInput[];
  registry: BrokerAccountInstance[];
}

async function readBundle(client: ServiceClient, code: string, profile: string): Promise<LedgerBundle> {
  const [tx, corr, meta, acct] = await Promise.all([
    client.from("kaw_transaction_ledger").select("*")
      .eq("family_code", code).eq("profile", profile).eq("account_type", EXEC_ACCOUNT_TYPE)
      .order("event_date", { ascending: true }).limit(LEDGER_ROW_LIMIT),
    client.from("kaw_transaction_correction").select("*")
      .eq("family_code", code).eq("profile", profile).limit(LEDGER_ROW_LIMIT),
    client.from("kaw_data").select("data")
      .eq("family_code", code).eq("profile", profile).eq("account_type", "_meta").maybeSingle(),
    client.from("kaw_data").select("data")
      .eq("family_code", code).eq("profile", profile).eq("account_type", EXEC_ACCOUNT_TYPE).maybeSingle(),
  ]);
  const ledger = ((tx.data ?? []) as Record<string, unknown>[]).map(ledgerRowToTransaction);
  const corrections = new Map<string, TransactionCorrection>();
  for (const r of (corr.data ?? []) as Record<string, unknown>[]) {
    const c = correctionRowToOverlay(r);
    corrections.set(c.transactionId, c);
  }
  const cashflows = ((acct.data?.data as { cashflows?: unknown } | null)?.cashflows ?? []) as Array<Record<string, unknown>>;
  const flows: CashFlowInput[] = Array.isArray(cashflows)
    ? cashflows
        .filter((c) => typeof c?.date === "string" && typeof c?.amount === "number")
        .map((c) => ({
          date: c.date as string, amount: c.amount as number,
          ...(c.timing === "after_close" ? { timing: "after_close" as const } : {}),
        }))
    : [];
  return {
    ok: !tx.error,
    ledger,
    corrections,
    flows,
    registry: parseBrokerAccounts((meta.data?.data as { brokerAccounts?: unknown } | null)?.brokerAccounts),
  };
}

// ── 핸들러 ──────────────────────────────────────────────────────────────────

export async function handleKisExecutionsPreview(
  request: Request,
  env: KisAccountEnv,
  deps: ExecDeps = {},
): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);

  // 1) 요청 모양 — 잘못된 요청은 어떤 외부 호출도 일으키지 않는다.
  const body = (await request.json().catch(() => null)) as { start?: unknown; end?: unknown } | null;
  const today = (deps.today ?? kstDateString)();
  if (!body || !isRealIso(body.start) || !isRealIso(body.end)) {
    return json({ error: "start / end 는 YYYY-MM-DD 형식이어야 합니다." }, 400);
  }
  const { start, end } = body;
  if (start > end) return json({ error: "시작일이 종료일보다 늦습니다." }, 400);
  if (end > today) return json({ error: "종료일이 미래입니다." }, 400);
  if (spanDays(start, end) > EXEC_MAX_SPAN_DAYS) {
    return json({ error: `조회 기간은 ${EXEC_MAX_SPAN_DAYS}일 이내여야 합니다.` }, 400);
  }

  // 2) 권한. 사유는 본문에 싣지 않는다(서버 설정 상태를 알려주지 않는다).
  if (!authorizeKisAccess(session, env).ok) {
    return json({ error: "이 프로필에는 한국투자 계좌 조회 권한이 없습니다." }, 403);
  }

  // 3) credential. 없으면 여기서 끝난다 — DB 도 KIS 도 건드리지 않는다.
  const app = resolveKisAccountApp(env);
  const cano = env.KIS_ACCOUNT_CANO;
  if (!app || !cano) {
    return json({ unavailable: true, state: "not_configured", error: "한국투자 계좌 조회 설정이 서버에 없습니다." }, 503);
  }

  // 4) 이 프로필의 레지스트리 + 계좌 등록 · 운용방식 게이트
  const client = serviceClient(env);
  if (!client) return json({ error: "서버 설정 오류" }, 503);
  const bundle = await readBundle(client, session.code, session.profile);
  const gate = kisApiQueryGate(bundle.registry, EXEC_ACCOUNT_TYPE, today, EXEC_PRODUCT_CODE);
  if (!gate.allowed) {
    return json({ state: "gate_blocked", reason: gate.reason } satisfies KisExecutionPreviewResponse);
  }
  if (!bundle.ok) return json({ state: "ledger_unavailable" } satisfies KisExecutionPreviewResponse);

  // 5) 토큰 → 조회. 재시도하지 않는다.
  const { appKey, appSecret } = app;
  const cred: KisAccountCredentials = { appKey, appSecret, cano };
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  let token: string;
  try {
    token = await (deps.getToken ?? defaultGetToken)(env, cred);
  } catch (e) {
    void redactKisSecrets(e, [appKey, appSecret, cano]);
    return json({
      state: "query_failed",
      failure: { kind: "auth", httpStatus: 0, rtCd: null, msgCd: null, msg1: null },
    } satisfies KisExecutionPreviewResponse);
  }

  const plan = planCcldWindows(toYmd(start), toYmd(end), toYmd(today));
  if (!plan.ok) return json({ error: "조회 기간을 해석할 수 없습니다." }, 400);

  const rows: ParsedCcldRow[] = [];
  const summaries: Array<CcldSummary | null> = [];
  let pagesRead = 0;
  let unreadPages = false;
  let dupKeys = 0;
  let sawAbsent = false;
  const results: CcldFetchResult[] = [];
  for (const w of plan.windows) {
    const r = await fetchCcldWindow(cred, { productCode: "22", window: w }, fetchImpl, {
      token, maxPages: CCLD_DEFAULT_MAX_PAGES,
    });
    results.push(r);
    if (r.failure) {
      return json({ state: "query_failed", failure: r.failure } satisfies KisExecutionPreviewResponse);
    }
    for (const p of r.pages) {
      pagesRead++;
      summaries.push(p.summary);
      if (p.listState === "list_absent") sawAbsent = true;
    }
    rows.push(...r.rows);
    unreadPages ||= r.unreadPages;
    dupKeys += r.duplicateOrderKeys.length;
  }

  const query: ExecQueryInfo = {
    start, end,
    windows: plan.windows.length,
    pagesRead,
    complete: !unreadPages && results.every((r) => r.complete),
    unreadPages,
    listState: sawAbsent ? "list_absent" : rows.length > 0 ? "rows" : "empty",
    duplicateOrderKeys: dupKeys,
  };

  // 6) 조립. 어디에도 쓰지 않는다.
  const composed = composeExecutionPreview({
    rows, summaries, query,
    ledger: bundle.ledger, corrections: bundle.corrections, registry: bundle.registry, flows: bundle.flows,
    accountType: EXEC_ACCOUNT_TYPE, productCode: EXEC_PRODUCT_CODE, today,
  });
  return json(composed);
}
