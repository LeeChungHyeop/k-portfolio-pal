// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 연금계좌 실잔고 **읽기 전용** 조회 — 오케스트레이션 + Worker 핸들러
//
//   GET /api/kis/account?product=22|29     세션 토큰 필요
//
// 조회 어댑터(`kis-account-server.ts`)와 토큰 로직(`getKisAccessToken`)을 **그대로
// 재사용**한다. 이 모듈은 (1) 어떤 계좌를 조회할지 정하고 (2) 호출을 묶고 (3) 결과를
// `kis-account-observe.ts` 의 관측 구조로 넘길 뿐이다.
//
// 하지 않는 것:
//   · 주문 · 이체 · 입금을 하지 않는다 (GET 조회뿐 — 어댑터 테스트가 소스로 고정한다)
//   · DB 에 쓰지 않는다. 관측을 저장하는 것은 별개의 결정이다(005 의 observation API)
//   · 계좌번호를 응답·로그에 내보내지 않는다. 응답에 CANO 가 없고 console 호출도 없다
//   · 이전 중인 계좌를 조회하지 않는다 — 빈 응답을 잔고 0 으로 읽는 사고를 막는다
// ─────────────────────────────────────────────────────────────────────────────

import { json, requireSession, serviceClient, type DataEnv } from "./data-server";
import { fetchKisPrices, getKisAccessToken, type KVLike } from "./kis-server";
import {
  fetchBuyingPower,
  toVerifiedBuyingPower,
  type BuyingPowerResult,
  type VerifiedBuyingPowerEntry,
} from "./kis-buying-power";
import {
  fetchIrpDeposit,
  fetchIrpPresentBalance,
  fetchPensionSavingsBalance,
  redactKisSecrets,
  type KisAccountCredentials,
  type KisBalanceSnapshot,
  type KisDepositResult,
} from "./kis-account-server";
import {
  KIS_ACCOUNT_IDENTITY,
  KIS_BROKER,
  KIS_BUYING_POWER_SUPPORT,
  KIS_PRODUCTS,
  buildBuyPlanInputs,
  buildKisObservation,
  isKisProductCode,
  resolveKisInstance,
  type BuyPlanInputs,
  type KisAccountObservation,
  type KisProductCode,
  type NotQueriedReason,
} from "./kis-account-observe";
import { parseBrokerAccounts, type BrokerAccountInstance } from "./broker-account";
import { kstDateString } from "./snapshot";
import { kisApiQueryGate } from "./broker-connection";

// ── 레지스트리 파싱 ─────────────────────────────────────────────────────────
// 클라이언트와 **같은** 파서를 쓴다(broker-account.ts). 테스트·호출부 호환을 위해 재export.
export { parseBrokerAccounts };

// ── 조회 오케스트레이션 ─────────────────────────────────────────────────────

export interface KisReadDeps {
  fetchPensionSavings: typeof fetchPensionSavingsBalance;
  fetchIrpPresent: typeof fetchIrpPresentBalance;
  fetchIrpDeposit: typeof fetchIrpDeposit;
  fetchBuyingPower: typeof fetchBuyingPower;
  /** 지정가 기준가로 쓸 현재가. 서버가 직접 조회한다(클라이언트가 보낸 값을 쓰지 않는다) */
  fetchPrices: (
    tickers: string[], appKey: string, appSecret: string,
  ) => Promise<{ results: Record<string, { price: number; source: string }>; timestamp: string }>;
  now: () => Date;
}

export const defaultKisReadDeps: KisReadDeps = {
  fetchPensionSavings: fetchPensionSavingsBalance,
  fetchIrpPresent: fetchIrpPresentBalance,
  fetchIrpDeposit,
  fetchBuyingPower,
  fetchPrices: (tickers, appKey, appSecret) => fetchKisPrices(tickers, appKey, appSecret),
  now: () => new Date(),
};

/** CANO 는 종합계좌번호 **8자리**다. 10자리/하이픈은 INVALID_CHECK_ACNO 로 실패한다. */
export const CANO_RE = /^\d{8}$/;

export interface KisReadRequest {
  productCode: KisProductCode;
  registry: readonly BrokerAccountInstance[];
  /** 없으면 조회하지 않고 not_queried 로 돌려준다 */
  credentials: KisAccountCredentials | null;
  token?: string;
}

export interface KisReadResult {
  observation: KisAccountObservation;
  plan: BuyPlanInputs;
}

/**
 * 한 상품코드의 잔고를 읽어 관측 + 주문안 입력으로 돌려준다.
 *
 * 조회 순서 규칙: **조회해도 되는지 먼저 정하고(instance·credential), 그 뒤에만 호출한다.**
 * 이전 중인 계좌나 credential 이 없는 경우 네트워크를 타지 않는다.
 */
export async function readKisAccount(
  req: KisReadRequest,
  deps: KisReadDeps = defaultKisReadDeps,
): Promise<KisReadResult> {
  const now = deps.now();
  const stateAsOf = kstDateString(now);
  const observedAt = now.toISOString();
  const resolution = resolveKisInstance(req.productCode, req.registry, stateAsOf);

  const finish = (extra: { balance?: KisBalanceSnapshot; deposit?: KisDepositResult; skipped?: NotQueriedReason }) => {
    const observation = buildKisObservation({
      productCode: req.productCode, resolution, stateAsOf, observedAt, ...extra,
    });
    return { observation, plan: buildBuyPlanInputs(observation) };
  };

  // 계좌 상태가 조회를 막는 경우 — 호출하지 않는다.
  //   · 미등록(sentinel): 어느 계좌인지 주장이 없다 → 조회하지 않는다
  //   · 계산만 제공: 사용자가 API 를 쓰지 않기로 했다 → 조회하지 않는다
  if (
    resolution.kind === "not_yet_active" ||
    resolution.kind === "no_longer_active" ||
    resolution.kind === "ambiguous" ||
    resolution.kind === "unregistered"
  ) {
    return finish({});
  }
  if (resolution.instance.connectionMode !== "api_readonly") {
    return finish({ skipped: "mode_calc_only" });
  }

  const cred = req.credentials;
  if (!cred || !req.token) return finish({ skipped: "credentials_missing" });
  if (!CANO_RE.test(cred.cano)) return finish({ skipped: "invalid_account_config" });

  if (req.productCode === "22") {
    const balance = await deps.fetchPensionSavings(cred, req.token);
    return finish({ balance });
  }

  // IRP: 서로 독립인 두 호출. 한쪽이 실패해도 다른 쪽 결과는 남긴다.
  const [balance, deposit] = await Promise.all([
    deps.fetchIrpPresent(cred, req.token),
    deps.fetchIrpDeposit(cred, req.token),
  ]);
  return finish({ balance, deposit });
}

// ── 매수가능조회 (연금저축 22, 종목별 지정가) ─────────────────────────────

export type BuyingPowerStatus =
  /** 요청한 모든 종목이 검증됐다 */
  | "verified"
  /** 일부만 검증됐다 — 클라이언트는 이것을 예산으로 인정하지 않는다 */
  | "partial"
  /** 조회하지 않았다(계좌 조회가 안 됐거나 미지원 상품·시세 없음) */
  | "not_queried"
  | "failed";

export interface KisBuyingPowerResponse {
  status: BuyingPowerStatus;
  reason?: string;
  /** 조회 시각(ISO). 지정가의 기준시각이기도 하다 */
  asOf: string | null;
  /** 검증된 종목별 항목(단가·주문가능금액·최대수량). 클라이언트가 계획 단가와 대조한다 */
  entries: VerifiedBuyingPowerEntry[];
  /** 종목별 결과 요약 — 금액 없이 성공 여부와 응답코드만 */
  perTicker: Array<{ ticker: string; price: number | null; ok: boolean; rtCd?: string; msgCd?: string }>;
}

const TICKER_QUERY_RE = /^[A-Z0-9]{6}$/;
export const BUYING_POWER_MAX_TICKERS = 10;

/** `?tickers=a,b` 를 읽는다. 모양이 틀리면 전체를 거부한다(일부만 조용히 버리지 않는다). */
export function parseTickerQuery(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return [];
  const list = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (list.length > BUYING_POWER_MAX_TICKERS) return null;
  if (!list.every((t) => TICKER_QUERY_RE.test(t))) return null;
  return list;
}

/**
 * 종목별 지정가 매수가능조회. **GET 만 한다.**
 *
 * 앞 단계(권한·등록·운용방식·계좌 조회 성공)를 통과한 요청에서만 부른다. 22 에서만 실증
 * 됐으므로 29 는 조회하지 않는다. 시세가 없는 종목은 조회하지 않는다(0 원 단가로
 * 묻지 않는다).
 */
export async function readKisBuyingPower(
  req: {
    productCode: KisProductCode;
    observation: KisAccountObservation;
    credentials: KisAccountCredentials | null;
    token?: string;
    tickers: string[];
  },
  deps: KisReadDeps = defaultKisReadDeps,
): Promise<KisBuyingPowerResponse> {
  const none = (status: BuyingPowerStatus, reason: string): KisBuyingPowerResponse => ({
    status, reason, asOf: null, entries: [], perTicker: [],
  });

  if (req.productCode !== "22") {
    return none("not_queried", "이 상품은 아직 매수가능조회를 지원하지 않습니다 (22 만 실증됨)");
  }
  if (!req.tickers.length) return none("not_queried", "종목이 지정되지 않았습니다");
  // 계좌 조회가 성공하지 못했으면(미등록·이전 중·권한 없음 등) 묻지 않는다.
  if (req.observation.cash.kind !== "observed") {
    return none("not_queried", "계좌 조회가 되지 않아 매수가능조회를 하지 않았습니다");
  }
  if (!req.credentials || !req.token) return none("not_queried", "credential 이 없습니다");

  const { appKey, appSecret } = req.credentials;
  let prices: Record<string, { price: number; source: string }> = {};
  let timestamp = deps.now().toISOString();
  try {
    const r = await deps.fetchPrices(req.tickers, appKey, appSecret);
    prices = r.results;
    timestamp = r.timestamp || timestamp;
  } catch {
    return none("failed", "시세를 가져오지 못해 지정가 기준을 정할 수 없습니다");
  }

  const entries: VerifiedBuyingPowerEntry[] = [];
  const perTicker: KisBuyingPowerResponse["perTicker"] = [];
  for (const ticker of req.tickers) {
    const quote = prices[ticker];
    const price = quote && quote.price > 0 ? quote.price : null;
    if (price === null || !Number.isInteger(price)) {
      perTicker.push({ ticker, price: null, ok: false });
      continue; // 시세가 없거나 정수가 아니면 묻지 않는다
    }
    const r: BuyingPowerResult = await deps.fetchBuyingPower(
      req.credentials, req.token, { ticker, unitPrice: price, ordDvsn: "00" }, "22",
    );
    const entry = toVerifiedBuyingPower(r);
    perTicker.push({
      ticker, price, ok: entry !== null,
      ...(r.rtCd !== undefined ? { rtCd: r.rtCd } : {}),
      ...(r.msgCd !== undefined ? { msgCd: r.msgCd } : {}),
    });
    if (entry) entries.push(entry);
  }

  const status: BuyingPowerStatus =
    entries.length === req.tickers.length ? "verified"
      : entries.length > 0 ? "partial"
      : "failed";
  return {
    status,
    ...(status === "failed" ? { reason: "매수가능조회가 확인되지 않았습니다" } : {}),
    asOf: timestamp,
    entries,
    perTicker,
  };
}

// ── Worker 핸들러 ───────────────────────────────────────────────────────────

export interface KisAccountEnv extends DataEnv {
  /**
   * **계좌 조회·주문 전용** 앱키/시크릿. 시세용 `KIS_APP_KEY`/`KIS_APP_SECRET` 과 별개의 앱이다.
   * 시세용 앱은 기본 주식계좌에 묶여 있어 연금저축(22) 계좌를 조회하면 INVALID_CHECK_ACNO 로 실패한다.
   * 이 값이 없을 때 시세용 키로 **대신 조회하지 않는다** — `resolveKisAccountApp` 참고.
   */
  KIS_ACCOUNT_APP_KEY?: string;
  KIS_ACCOUNT_APP_SECRET?: string;
  /** 종합계좌번호 8자리. 응답·로그에 나가지 않는다 */
  KIS_ACCOUNT_CANO?: string;
  /**
   * 위 계좌(`KIS_ACCOUNT_CANO`)의 **소유 가족 코드 + 소유 프로필 id**. 둘 다 비밀값이 아니다.
   *
   * 서버가 가진 증권사 credential 은 **한 사람의 계좌**다. 프로필 id 만으로는 부족하다 —
   * 가족마다 같은 프로필명(`hyeobi` 등)을 쓸 수 있어서, 다른 가족의 동일 이름 프로필이
   * 세션만으로 이 계좌를 조회할 수 있다. 그래서 **서명 검증된 세션의 가족 코드와 프로필이
   * 모두** 아래 두 값과 같아야 한다. 둘 중 하나라도 설정되어 있지 않으면 **아무도 조회할 수
   * 없다**(fail closed).
   */
  KIS_ACCOUNT_OWNER_FAMILY_CODE?: string;
  KIS_ACCOUNT_OWNER_PROFILE?: string;
  /** 체결 → 거래원장 반영 flag. 정확히 "on" 일 때만 켜진다(Phase 4-C-2). 기본 꺼짐 */
  KIS_LEDGER_APPLY_ENABLED?: string;
}

export type KisAuthorization =
  | { ok: true }
  | { ok: false; reason: "owner_not_configured" | "family_mismatch" | "profile_not_owner" };

/**
 * 이 세션이 서버의 KIS 계좌를 조회할 **권한**이 있는가.
 *
 * 권한의 근거는 **서버 설정과 서명 검증된 세션**뿐이다. 클라이언트가 저장한 레지스트리
 * (`_meta.brokerAccounts`)나 `connectionMode` 는 사용자가 쓸 수 있는 값이라 권한의 근거가
 * 될 수 없다 — 그것은 "이 계좌를 API 로 보고 싶다"는 선호일 뿐이다.
 *
 *   1. 소유 가족 코드·소유 프로필이 **둘 다** 서버에 설정돼 있어야 한다 (없으면 전원 거부)
 *   2. 세션의 가족 코드가 소유 가족 코드와 정확히 같아야 한다
 *   3. 세션의 프로필이 소유 프로필과 정확히 같아야 한다
 *
 * 비교는 **완전 일치**다(대소문자 무시·부분 일치·trim 없음). 설정값의 앞뒤 공백만 설정
 * 실수로 보고 제거한다.
 */
export function authorizeKisAccess(
  session: { code: string; profile: string },
  env: Pick<KisAccountEnv, "KIS_ACCOUNT_OWNER_FAMILY_CODE" | "KIS_ACCOUNT_OWNER_PROFILE">,
): KisAuthorization {
  const ownerFamily = env.KIS_ACCOUNT_OWNER_FAMILY_CODE?.trim();
  const ownerProfile = env.KIS_ACCOUNT_OWNER_PROFILE?.trim();
  if (!ownerFamily || !ownerProfile) return { ok: false, reason: "owner_not_configured" };
  if (!session.code || session.code !== ownerFamily) return { ok: false, reason: "family_mismatch" };
  if (!session.profile || session.profile !== ownerProfile) {
    return { ok: false, reason: "profile_not_owner" };
  }
  return { ok: true };
}

/**
 * 계좌 조회·주문에 쓸 앱 credential. **`KIS_ACCOUNT_APP_*` 만 본다.**
 *
 * 시세용 `KIS_APP_KEY`/`KIS_APP_SECRET` 으로 대체하지 않는다: 그 앱은 다른 계좌(기본 주식계좌)에
 * 묶여 있어서, 대체하면 의도하지 않은 계좌를 조회하거나 오류로 실패한다. 둘 중 하나라도 비어 있으면
 * null 이고 호출자는 503(설정 없음)으로 끝낸다 — 토큰 발급도 하지 않는다.
 */
export function resolveKisAccountApp(
  env: Pick<KisAccountEnv, "KIS_ACCOUNT_APP_KEY" | "KIS_ACCOUNT_APP_SECRET">,
): { appKey: string; appSecret: string } | null {
  const appKey = env.KIS_ACCOUNT_APP_KEY?.trim();
  const appSecret = env.KIS_ACCOUNT_APP_SECRET?.trim();
  return appKey && appSecret ? { appKey, appSecret } : null;
}

/**
 * GET /api/kis/account?product=22|29
 *
 *   200 { observation, plan, buyingPowerSupport }
 *   400 { error }                     product 가 22/29 가 아니다
 *   401                               세션 없음/만료
 *   403 { error }                     이 프로필에는 조회 권한이 없다 — **조회하지 않았다**
 *   503 { unavailable }               서버 설정(credential)이 없다
 *
 * 순서가 곧 안전장치다: **권한 → 계좌 등록·방식 → credential → 토큰 → 조회.**
 * 앞 단계가 막히면 뒤 단계(토큰 발급 포함)를 실행하지 않는다.
 *
 * **조회 실패는 200 이다** — 어느 축이 왜 실패했는지가 본문의 `failed`/`not_queried` 이고,
 * 그것을 HTTP 오류로 올리면 "일부만 성공"한 IRP 결과를 표현할 수 없다.
 */
export async function handleKisAccountGet(request: Request, env: KisAccountEnv): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);

  const product = new URL(request.url).searchParams.get("product");
  if (!isKisProductCode(product)) {
    return json({ error: "product 는 22(연금저축) 또는 29(IRP) 입니다." }, 400);
  }

  // 요청 모양 검증 — 권한 판단 전에 끝낸다(잘못된 요청은 어떤 외부 호출도 일으키지 않는다).
  const tickers = parseTickerQuery(new URL(request.url).searchParams.get("tickers"));
  if (tickers === null) {
    return json({ error: `tickers 는 6자리 종목코드를 쉼표로 구분해 ${BUYING_POWER_MAX_TICKERS}개까지입니다.` }, 400);
  }

  // 1) 권한. 실패하면 DB 도 credential 도 건드리지 않는다. 사유는 본문에 싣지 않는다
  //    (서버 설정 상태를 알려주지 않는다).
  const auth = authorizeKisAccess(session, env);
  if (!auth.ok) {
    return json({ error: "이 프로필에는 한국투자 계좌 조회 권한이 없습니다." }, 403);
  }

  // 2) 이 프로필의 레지스트리. 못 읽으면 비어 있는 것으로 본다 → 미등록 → 조회하지 않는다.
  let registry: BrokerAccountInstance[] = [];
  const client = serviceClient(env);
  if (client) {
    const { data } = await client
      .from("kaw_data").select("data")
      .eq("family_code", session.code)
      .eq("profile", session.profile)
      .eq("account_type", "_meta")
      .maybeSingle();
    registry = parseBrokerAccounts((data?.data as { brokerAccounts?: unknown } | null)?.brokerAccounts);
  }

  const app = resolveKisAccountApp(env);
  if (!app) {
    return json({ unavailable: true, error: "KIS credential 이 설정되지 않았습니다." }, 503);
  }
  const { appKey, appSecret } = app;
  const cano = env.KIS_ACCOUNT_CANO;

  // 3) 계좌 등록 + 운용방식. 허용되지 않으면 토큰도 발급하지 않는다.
  const accountType = KIS_PRODUCTS[product].logicalAccountType;
  const gate = kisApiQueryGate(registry, accountType, kstDateString(), product);

  let credentials: KisAccountCredentials | null = null;
  let token: string | undefined;
  if (gate.allowed && cano) {
    credentials = { appKey, appSecret, cano };
    try {
      token = await getKisAccessToken(appKey, appSecret, env.RATE_LIMIT as KVLike | undefined);
    } catch (e) {
      // 토큰 발급 오류 문구에 키가 섞일 수 있다 — 본문에 싣지 않는다.
      void redactKisSecrets(e, [appKey, appSecret, cano]);
      token = undefined;
    }
  }

  const { observation, plan } = await readKisAccount({
    productCode: product,
    registry,
    credentials,
    token,
  });

  // 종목별 매수가능조회(선택). 계좌 조회가 성공한 경우에만 하며, 요청한 종목만 묻는다.
  // (모양 검증은 앞에서 끝냈다 — 잘못된 요청으로 증권사를 호출하지 않는다.)
  const buyingPower: KisBuyingPowerResponse | null = tickers.length
    ? await readKisBuyingPower({ productCode: product, observation, credentials, token, tickers })
    : null;

  return json({
    observation,
    plan,
    buyingPower,
    buyingPowerSupport: KIS_BUYING_POWER_SUPPORT[product],
    broker: KIS_BROKER,
    // 22/29 가 같은 종합계좌번호라는 가정은 **검증되지 않았다**. 소비자가 이 응답을 주문
    // 계좌의 식별 근거로 쓰지 않도록 응답에 명시한다.
    accountIdentity: KIS_ACCOUNT_IDENTITY,
  });
}
