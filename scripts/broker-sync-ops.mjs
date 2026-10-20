// 계좌 상태 동기화(broker_sync) 운영 도우미 — 반영 전 백업 · 반영 후 일관성 검사 · 복구 SQL 생성
//
//   node scripts/broker-sync-ops.mjs backup                  운영 DB 를 SELECT 로만 읽어 백업 파일을 만든다 (쓰기 없음)
//   node scripts/broker-sync-ops.mjs verify  <백업.json>      반영 후 상태를 백업과 대조한다 (SELECT 만)
//   node scripts/broker-sync-ops.mjs restore-sql <백업.json>  백업 문서로 되돌리는 SQL 을 출력한다 (실행하지 않는다)
//
// 백업 파일은 git 저장소 밖(`k-allweather/backups/`)에 만든다 — 재무 데이터가 저장소에 들어가지 않게 한다.
// 비밀값(.dev.vars)은 읽기만 하고 출력하지 않는다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = path.resolve(APP, "..", "backups");
const MUTABLE = ["liveQuantities", "rowHoldings", "cashBalance", "cashBalanceObservation", "brokerSyncs"];

const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const sha = (v) => crypto.createHash("sha256").update(canon(v)).digest("hex");

/** 백업 문서 → 복구 SQL. 키 손실 허용 플래그를 켜는 것은 '동기화가 더한 키(brokerSyncs 등)를 지우기' 위해서다 */
export function restoreSql(backup, currentRevision) {
  const rows = JSON.stringify([{ account_type: "pension", data: backup.doc, expected_revision: currentRevision }]);
  const tag = "bsync_restore";
  if (rows.includes(`$${tag}$`)) throw new Error("백업 문서에 달러 인용 태그가 들어 있어 SQL 을 만들 수 없습니다");
  return [
    "-- 계좌 상태 동기화 복구: 백업 시점의 pension 문서로 되돌린다 (revision CAS · 감사 행은 지우지 않는다)",
    `-- 백업 revision ${backup.revision}, 문서 지문 ${backup.docSha256}`,
    "-- 현재 revision 이 아래 값과 다르면 'conflict' 가 반환되고 아무것도 쓰지 않는다.",
    `select public.kaw_data_save_guarded(`,
    `  ${sqlText(backup.familyCode)}, ${sqlText(backup.profile)},`,
    `  $${tag}$${rows}$${tag}$::jsonb,`,
    `  false,  -- p_allow_history_shrink: 이력은 줄지 않는다`,
    `  true    -- p_allow_key_loss: 동기화가 더한 brokerSyncs · cashBalanceObservation 키를 되돌리려면 필요`,
    `);`,
  ].join("\n");
}
const sqlText = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** 반영 후 상태 대조 — 순수 함수. 문제 목록(빈 배열이면 일관됨)을 돌려준다 */
export function verifyAgainstBackup(backup, now) {
  const problems = [];
  const before = backup.doc, after = now.doc;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (MUTABLE.includes(k)) continue;
    if (canon(before[k]) !== canon(after[k])) problems.push(`허용되지 않은 키가 바뀌었습니다: ${k}`);
  }
  const syncsBefore = Array.isArray(before.brokerSyncs) ? before.brokerSyncs : [];
  const syncsAfter = Array.isArray(after.brokerSyncs) ? after.brokerSyncs : [];
  const applied = syncsAfter.length === syncsBefore.length + 1;
  if (!applied && syncsAfter.length !== syncsBefore.length) problems.push(`brokerSyncs 건수가 이상합니다 (${syncsBefore.length} → ${syncsAfter.length})`);
  if (canon(syncsAfter.slice(0, syncsBefore.length)) !== canon(syncsBefore)) problems.push("기존 동기화 기록이 바뀌었습니다");
  if (now.ledgerCount !== backup.ledgerCount) problems.push(`거래원장 건수가 바뀌었습니다 (${backup.ledgerCount} → ${now.ledgerCount})`);
  if (now.snapshotCount < backup.snapshotCount) problems.push(`일별 스냅샷이 줄었습니다 (${backup.snapshotCount} → ${now.snapshotCount})`);
  if ((before.history?.length ?? 0) !== (after.history?.length ?? 0)) problems.push("이력(history) 건수가 바뀌었습니다");
  if (applied) {
    const rec = syncsAfter.at(-1);
    if (rec.kind !== "broker_sync" || rec.notRebalance !== true || rec.createsCashflow !== false || rec.createsTrade !== false || rec.changesBaseAmount !== false) problems.push("동기화 기록의 표식이 올바르지 않습니다");
    if (canon(after.liveQuantities) !== canon(rec.quantities)) problems.push("현재 수량이 기록의 수량과 다릅니다");
    if (after.cashBalance !== rec.cash?.amount) problems.push("예수금이 기록의 관측값과 다릅니다");
    if (now.revision !== backup.revision + 1) problems.push(`revision 이 +1 이 아닙니다 (${backup.revision} → ${now.revision})`);
    if (now.syncAuditCount !== backup.syncAuditCount + 1) problems.push(`승인 감사가 +1 건이 아닙니다 (${backup.syncAuditCount} → ${now.syncAuditCount})`);
    if (rec.principal?.amount !== undefined && now.principal !== backup.principal) problems.push("누적 납입원금이 바뀌었습니다");
  } else if (now.revision !== backup.revision) {
    problems.push("반영되지 않았는데 revision 이 바뀌었습니다");
  }
  return { applied, problems };
}

// ── 운영 DB 읽기 (SELECT 만) ─────────────────────────────────────────────────
async function snapshotState() {
  const vars = {};
  for (const l of fs.readFileSync(path.join(APP, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const familyCode = vars.ACCESS_CODE, profile = "hyeobi";
  const one = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
  const row = await one(sb.from("kaw_data").select("data, revision").eq("family_code", familyCode).eq("profile", profile).eq("account_type", "pension").maybeSingle());
  const cnt = async (table, f) => { const { count, error } = await f(sb.from(table).select("*", { count: "exact", head: true }).eq("family_code", familyCode).eq("profile", profile)); if (error) throw new Error(error.message); return count ?? 0; };
  const doc = row.data;
  return {
    familyCode, profile, revision: row.revision, doc, docSha256: sha(doc),
    ledgerCount: await cnt("kaw_transaction_ledger", (q) => q.eq("account_type", "pension")),
    snapshotCount: await cnt("kaw_daily_portfolio_snapshots", (q) => q.eq("account_type", "pension")),
    auditCount: await cnt("kaw_ledger_audit", (q) => q),
    syncAuditCount: await cnt("kaw_ledger_audit", (q) => q.eq("action", "broker_sync_apply")),
    principal: (Array.isArray(doc.cashflows) ? doc.cashflows : []).reduce((s, c) => s + (Number(c.amount) || 0), 0),
  };
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "backup") {
    const s = await snapshotState();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const out = path.join(BACKUP_DIR, `broker-sync-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(out, JSON.stringify({ takenAt: new Date().toISOString(), ...s }, null, 2), { flag: "wx" });
    console.log(`백업 완료: ${out}`);
    console.log(`revision ${s.revision} · 문서 지문 ${s.docSha256} · 원장 ${s.ledgerCount}행 · 스냅샷 ${s.snapshotCount}행 · 동기화 감사 ${s.syncAuditCount}건 · 누적 원금 ${s.principal}`);
    return;
  }
  if (cmd === "verify" || cmd === "restore-sql") {
    if (!file) throw new Error("백업 파일 경로가 필요합니다");
    const backup = JSON.parse(fs.readFileSync(file, "utf8"));
    if (sha(backup.doc) !== backup.docSha256) throw new Error("백업 파일의 문서 지문이 맞지 않습니다 — 손상됐을 수 있습니다");
    const now = await snapshotState();
    if (cmd === "restore-sql") { console.log(restoreSql(backup, now.revision)); return; }
    const r = verifyAgainstBackup(backup, now);
    console.log(r.applied ? "동기화가 반영된 상태입니다." : "동기화가 아직 반영되지 않았습니다(백업과 같은 상태).");
    console.log(`revision ${backup.revision} → ${now.revision} · 원장 ${backup.ledgerCount} → ${now.ledgerCount} · 스냅샷 ${backup.snapshotCount} → ${now.snapshotCount}`);
    if (r.problems.length) { console.log("문제:"); for (const p of r.problems) console.log(` - ${p}`); process.exitCode = 1; }
    else console.log("일관성 검사 통과: 허용된 5개 키 밖은 그대로이고 원장·이력·원금이 보존됐습니다.");
    return;
  }
  console.log("사용법: backup | verify <백업.json> | restore-sql <백업.json>");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
}
