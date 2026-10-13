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
import { getKisAccessToken, type KVLike } from "./kis-server";
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
  now: () => Date;
}

export const defaultKisReadDeps: KisReadDeps = {
  fetchPensionSavings: fetchPensionSavingsBalance,
  fetchIrpPresent: fetchIrpPresentBalance,
  fetchIrpDeposit,
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

// ── Worker 핸들러 ───────────────────────────────────────────────────────────

export interface KisAccountEnv extends DataEnv {
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
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

  const { KIS_APP_KEY: appKey, KIS_APP_SECRET: appSecret, KIS_ACCOUNT_CANO: cano } = env;
  if (!appKey || !appSecret) {
    return json({ unavailable: true, error: "KIS credential 이 설정되지 않았습니다." }, 503);
  }

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

  return json({
    observation,
    plan,
    buyingPowerSupport: KIS_BUYING_POWER_SUPPORT[product],
    broker: KIS_BROKER,
    // 22/29 가 같은 종합계좌번호라는 가정은 **검증되지 않았다**. 소비자가 이 응답을 주문
    // 계좌의 식별 근거로 쓰지 않도록 응답에 명시한다.
    accountIdentity: KIS_ACCOUNT_IDENTITY,
  });
}
