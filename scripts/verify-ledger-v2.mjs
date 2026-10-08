// ─────────────────────────────────────────────────────────────────────────────
// v2 데이터셋 검증 — **읽기 전용, 네트워크 없음.** DB 에 아무것도 쓰지 않는다.
//
//   node scripts/verify-ledger-v2.mjs
//
// 두 층을 본다:
//
//   A. v1 ↔ v2 관계  — v2 가 정말 "v1 전체 + 6건"인가. 기존 463건이 **한 필드도**
//      바뀌지 않았는지 전수 비교하고, fingerprint 가 463/463 동일한지 본다.
//   B. v2 자체 정합성 — 재생 보유수량 / 음수 / postQuantity / 이벤트 / 신원.
//      여기는 앱의 `verifyDataset` 를 그대로 호출한다 — 같은 판정을 쓰려는 것이다.
//
// 추가로 production 체크포인트 세 개를 상수로 박아두고 대조한다
// (사용자가 production 화면에서 읽어 알려준 값이다 — 여기서 DB 를 읽지 않는다).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildV2Text } from "./build-ledger-v2.mjs";
import { parseVerifiedDataset, verifyDataset, formatChecks } from "../src/lib/kaw/verified-transactions.ts";
import { replayFinalHoldings, resolveEvents, findDuplicateFingerprints } from "../src/lib/kaw/ledger.ts";

const v1raw = JSON.parse(readFileSync(resolve(process.cwd(), "data/verified-transactions.v1.json"), "utf-8"));
const v2text = readFileSync(resolve(process.cwd(), "data/verified-transactions.v2.json"), "utf-8");
const v2raw = JSON.parse(v2text);

// production 에서 사용자가 확인해 알려준 값. 여기서 DB 를 읽지 않는다.
const PROD_ROW_QUANTITIES_SNAP_2026_10_02 = { 360750: 297, "0167A0": 0, "0181B0": 0, 367380: 81 };
const PROD_PENSION_CASH_BALANCE = 28531;   // production 현재값
const CAPTURE_CASH_BALANCE_20261008 = 29296; // 캡처 10/08 예수금잔액
const DEPOSIT_INTEREST_20261008 = 765;

const out = [];
const check = (name, ok, detail) => out.push({ name, ok, detail });

// ── A. v1 ↔ v2 ──────────────────────────────────────────────────────────────

check("v2 생성 재현 가능", buildV2Text() === v2text,
  "build-ledger-v2.mjs 출력과 파일이 동일");

check("v1 파일 미변경", v1raw.transactions.length === 463 && v1raw.rebalanceEvents.length === 65,
  `v1 거래 ${v1raw.transactions.length}건 / 이벤트 ${v1raw.rebalanceEvents.length}개`);

const v1ById = new Map(v1raw.transactions.map((t) => [t.id, t]));
const v2ById = new Map(v2raw.transactions.map((t) => [t.id, t]));
const carried = v1raw.transactions.filter((t) => v2ById.has(t.id));
const changed = carried.filter((t) => JSON.stringify(t) !== JSON.stringify(v2ById.get(t.id)));
check("기존 463건 전수 동일", carried.length === 463 && changed.length === 0,
  `${carried.length}/463 존재, 내용 변경 ${changed.length}건`
  + (changed.length ? ` (${changed.slice(0, 3).map((t) => t.id).join(", ")})` : ""));

const newIds = v2raw.transactions.filter((t) => !v1ById.has(t.id));
check("신규 거래 6건만 추가", newIds.length === 6,
  `${newIds.length}건 (${[...new Set(newIds.map((t) => t.account))].join(",")})`);
check("신규 id 가 기존과 충돌 없음", new Set(v2raw.transactions.map((t) => t.id)).size === 469,
  `유일 id ${new Set(v2raw.transactions.map((t) => t.id)).size} / 469`);

// fingerprint 는 파서가 채운다 — v1·v2 를 각각 파싱해 기존 463건을 맞춰본다.
const pv1 = parseVerifiedDataset(v1raw);
const pv2 = parseVerifiedDataset(v2raw);
const fp1 = new Map(pv1.transactions.map((t) => [t.id, t.sourceFingerprint]));
const fpSame = pv2.transactions.filter((t) => fp1.has(t.id) && fp1.get(t.id) === t.sourceFingerprint);
check("기존 fingerprint 463/463 동일", fpSame.length === 463, `${fpSame.length}/463`);

const newFps = pv2.transactions.filter((t) => !fp1.has(t.id)).map((t) => t.sourceFingerprint);
check("신규 fingerprint 6개, 기존과 중복 없음",
  newFps.length === 6 && newFps.every((f) => ![...fp1.values()].includes(f)),
  `${newFps.length}개`);
check("fingerprint 전체 중복 0", findDuplicateFingerprints(pv2.transactions).length === 0,
  `${new Set(pv2.transactions.map((t) => t.sourceFingerprint)).size}개 유일`);

// 기존 463건의 **재생 결과**가 변하지 않았는가 — 증분이 과거를 건드리지 않았다는 확인.
const h1 = replayFinalHoldings(pv1.transactions);
const only463 = pv2.transactions.filter((t) => fp1.has(t.id));
check("기존 463건 replay 결과 불변",
  JSON.stringify(replayFinalHoldings(only463)) === JSON.stringify(h1),
  "v2 에서 기존 463건만 재생 = v1 재생");

// ── B. v2 자체 정합성 (앱과 같은 게이트) ─────────────────────────────────────

const appChecks = verifyDataset(pv2);
for (const c of appChecks) check(`[app] ${c.name}`, c.ok, c.detail);

// ── C. production 체크포인트 ────────────────────────────────────────────────

const pension = replayFinalHoldings(pv2.transactions).pension ?? {};
const snapTickers = new Set([...Object.keys(PROD_ROW_QUANTITIES_SNAP_2026_10_02), ...Object.keys(pension)]);
const snapMismatch = [...snapTickers].filter(
  (tk) => (pension[tk] ?? 0) !== (PROD_ROW_QUANTITIES_SNAP_2026_10_02[tk] ?? 0),
);
check("production rowQuantitiesSnap(2026-10-02) 일치", snapMismatch.length === 0,
  snapMismatch.length
    ? snapMismatch.map((tk) => `${tk}: 재생 ${pension[tk] ?? 0} ≠ snap ${PROD_ROW_QUANTITIES_SNAP_2026_10_02[tk] ?? 0}`).join(" | ")
    : "360750=297 / 0167A0=0 / 0181B0=0 / 367380=81 mismatch 0");

// 일중 순서 무관 — 신규 6건의 720개 순열을 전부 재생한다.
const base = pv2.transactions.filter((t) => fp1.has(t.id));
const six = pv2.transactions.filter((t) => !fp1.has(t.id));
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const want = JSON.stringify(pension);
let negAny = 0;
const allSame = perms(six).every((p) => {
  const txs = [...base, ...p];
  negAny += resolveEvents({ transactions: txs }).flatMap((e) => e.lines).filter((l) => l.afterQuantity < 0).length;
  return JSON.stringify(replayFinalHoldings(txs).pension ?? {}) === want;
});
check("일중 순서 무관 (6! = 720 순열)", allSame && negAny === 0,
  `720 순열 전부 동일, 음수 보유수량 ${negAny}건`);

// postQuantity 대조 가능 건수가 늘지 않았는가 (신규 6건은 전부 null 이어야 한다).
const cmp = (d) => resolveEvents({ transactions: d }).flatMap((e) => e.lines)
  .filter((l) => l.postQuantityMismatch !== null);
const mis = (d) => cmp(d).filter((l) => l.postQuantityMismatch === true);
check("postQuantity mismatch 증가 없음",
  mis(pv2.transactions).length === mis(pv1.transactions).length,
  `v1 ${mis(pv1.transactions).length}건 → v2 ${mis(pv2.transactions).length}건 `
  + `(대조 가능 ${cmp(pv1.transactions).length} → ${cmp(pv2.transactions).length})`);
check("신규 6건 postQuantity 전부 null", six.every((t) => t.postQuantity === null), "6/6");

// 비용 보존
check("신규 6건 fee 기록 / tax=0",
  six.every((t) => typeof t.fee === "number" && t.fee > 0 && t.tax === 0),
  `fee 합 ${six.reduce((s, t) => s + t.fee, 0)} (캡처 매수 240 + 매도 223 = 463)`);

// 이벤트
const ev2026 = pv2.events.filter((e) => e.accountId === "pension" && e.eventDate === "2026-10-02");
check("신규 이벤트는 pension 2026-10-02 1개",
  ev2026.length === 1 && pv2.events.length === pv1.events.length + 1,
  `${pv1.events.length} → ${pv2.events.length}`);

// 예수금 — 이번 patch 와 분리된 사실 확인용
check("cashBalance 차액 = 예탁금이용료",
  CAPTURE_CASH_BALANCE_20261008 - PROD_PENSION_CASH_BALANCE === DEPOSIT_INTEREST_20261008,
  `캡처 ${CAPTURE_CASH_BALANCE_20261008} − production ${PROD_PENSION_CASH_BALANCE} = ${DEPOSIT_INTEREST_20261008} (10/08 예탁금이용료). production 갱신은 이번 patch 와 분리한다.`);

// ── 출력 ────────────────────────────────────────────────────────────────────
console.log(formatChecks(out));
const failed = out.filter((c) => !c.ok);
console.log(`\n${failed.length ? `✗ ${failed.length}건 실패` : `✓ 전부 통과 (${out.length}건)`}`);
process.exit(failed.length ? 1 : 0);
