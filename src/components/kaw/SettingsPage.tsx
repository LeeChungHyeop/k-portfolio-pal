import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  PROFILE_LABELS, ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS,
  ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, type ProfileKey, type AccountId, type AssetKey,
} from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, type HistoryEntry, type AccountState } from "@/lib/kaw/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { RotateCcw, Download, Upload, FileSpreadsheet, Trash2, KeyRound, Shield, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import {
  type FamilyData,
  verifyPin, updatePin, verifyMasterCode, updateMasterCode,
} from "@/lib/kaw/auth";

const ASSET_NAME_MAP: Record<string, AssetKey> = {
  "미국 (UH)": "us", "미국(UH)": "us", "한국": "kr",
  "중국 (UH)": "cn", "중국(UH)": "cn", "인도 (UH)": "in", "인도(UH)": "in",
  "금 (UH)": "gold", "금(UH)": "gold",
  "미국채 10년 (UH)": "ust10", "미국채 30년 (H)": "ust30",
  "국고채 30년": "ktb30", "현금성자산": "cash",
};

const SHEET_TO_ACCOUNT: Record<string, AccountId> = {
  "퇴직연금": "retirement", "ISA": "isa", "연금저축": "pension", "IRP": "irp",
};

function parseNum(v: unknown): number {
  return parseFloat(String(v ?? "").replace(/[\s,₩]/g, "")) || 0;
}

function excelDateToISO(serial: number): string {
  return new Date((serial - 25569) * 86400 * 1000).toISOString().slice(0, 10);
}

function parseExcelWorkbook(wb: XLSX.WorkBook): Record<AccountId, AccountState> {
  const result: Partial<Record<AccountId, AccountState>> = {};

  for (const sheetName of wb.SheetNames) {
    const accountId = SHEET_TO_ACCOUNT[sheetName];
    if (!accountId) continue;

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

    // 날짜 컬럼 추출 (row 0, col 4부터 2칸 간격)
    const dateRow = rows[0] as unknown[];
    const dateCols: { col: number; date: string }[] = [];
    for (let c = 4; c < dateRow.length; c += 2) {
      const v = dateRow[c];
      if (v && typeof v === "number") {
        dateCols.push({ col: c, date: excelDateToISO(v) });
      }
    }
    if (dateCols.length === 0) continue;

    // 날짜별 데이터 초기화
    const perDate: Record<string, {
      baseAmount: number; totalValue: number; deposit: number;
      holdings: Partial<Record<AssetKey, number>>;
      etfNames: Partial<Record<AssetKey, string>>;
    }> = {};
    dateCols.forEach(({ date }) => {
      perDate[date] = { baseAmount: 0, totalValue: 0, deposit: 0, holdings: {}, etfNames: {} };
    });

    for (const row of rows) {
      const r = row as unknown[];
      const assetLabel = String(r[1] ?? "").trim();
      const assetKey = ASSET_NAME_MAP[assetLabel];

      if (assetKey) {
        // ETF 이름 (첫 줄만 사용)
        const etfRaw = String(r[2] ?? "").split("\n")[0].trim();
        dateCols.forEach(({ col, date }) => {
          const v = parseNum(r[col]);
          if (v > 0) {
            perDate[date].holdings[assetKey] = v;
            if (etfRaw) perDate[date].etfNames[assetKey] = etfRaw;
          }
        });
        continue;
      }

      // 자산합계 행
      if (String(r[0]).includes("자산합계")) {
        dateCols.forEach(({ col, date }) => {
          let tv = parseNum(r[col]);
          const ba = parseNum(r[col + 1]);
          if (tv === 0) {
            tv = Object.values(perDate[date].holdings).reduce((s, v) => s + (v ?? 0), 0);
          }
          if (tv > 0) perDate[date].totalValue = Math.round(tv);
          if (ba > 0) perDate[date].baseAmount = Math.round(ba);
        });
        continue;
      }

      // 불입액 행
      if (String(r[1]).includes("불입액")) {
        dateCols.forEach(({ col, date }) => {
          const dep = parseNum(r[col + 1]) || parseNum(r[col]);
          if (dep > 0) perDate[date].deposit = dep;
        });
      }
    }

    // 같은 날짜 중복 시 마지막 값 유지
    const seen: Record<string, typeof perDate[string]> = {};
    dateCols.forEach(({ date }) => { seen[date] = perDate[date]; });

    // HistoryEntry 생성
    const entries = Object.entries(seen).sort(([a], [b]) => a.localeCompare(b));
    const history: HistoryEntry[] = entries.map(([date, d], i) => {
      const prev = i > 0 ? entries[i - 1][1] : null;
      const returnPct = prev && prev.totalValue > 0
        ? ((d.totalValue - d.deposit) - prev.totalValue) / prev.totalValue * 100
        : null;
      return {
        id: `seed-${date}`,
        date, baseAmount: d.baseAmount, totalValue: d.totalValue,
        deposit: d.deposit, holdings: d.holdings, returnPct,
      };
    });

    // 가장 최근 스냅샷으로 현재 holdings 초기화
    const latest = entries[entries.length - 1];
    const latestHoldings = latest?.[1].holdings ?? {};
    const latestEtfNames = latest?.[1].etfNames ?? {};

    result[accountId] = {
      baseAmount: latest?.[1].baseAmount ?? 0,
      deposit: 0,
      rebalanceDate: new Date().toISOString().slice(0, 10),
      holdings: ASSET_ORDER.map((k) => ({
        assetKey: k,
        etfName: latestEtfNames[k] ?? ASSET_GROUPS[k].defaultEtf,
        value: latestHoldings[k] ?? 0,
      })),
      history,
    };
  }

  return result as Record<AccountId, AccountState>;
}

interface SettingsProps {
  familyData: FamilyData;
  onFamilyUpdate: (fd: FamilyData) => void;
}

export function SettingsPage({ familyData, onFamilyUpdate }: SettingsProps) {
  const { state, setProfile, setAllocation, resetAllocation, resetAll, importJson, currentUser, familyCode } = usePortfolioStore();
  const profile = state.profile;
  const alloc = state.allocations[profile];
  const total = ASSET_ORDER.reduce((s, k) => s + (alloc[k] || 0), 0);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const xlsxFileRef = useRef<HTMLInputElement>(null);

  const isAdmin = familyData.profiles.find((p) => p.id === currentUser)?.is_admin ?? false;

  // PIN change state
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinNew, setPinNew] = useState("");
  const [pinNewConfirm, setPinNewConfirm] = useState("");
  const [pinMsg, setPinMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  // Master code change state
  const [mcCurrent, setMcCurrent] = useState("");
  const [mcNew, setMcNew] = useState("");
  const [mcNewConfirm, setMcNewConfirm] = useState("");
  const [mcMsg, setMcMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [mcLoading, setMcLoading] = useState(false);

  async function handlePinChange(e: React.FormEvent) {
    e.preventDefault();
    if (!familyCode || !currentUser) return;
    if (pinNew.length !== 4 || !/^\d{4}$/.test(pinNew)) { setPinMsg({ type: "err", text: "새 비밀번호는 숫자 4자리여야 합니다." }); return; }
    if (pinNew !== pinNewConfirm) { setPinMsg({ type: "err", text: "새 비밀번호가 일치하지 않습니다." }); return; }
    setPinLoading(true);
    const ok = await verifyPin(familyCode, currentUser, pinCurrent, familyData);
    if (!ok) { setPinMsg({ type: "err", text: "현재 비밀번호가 틀렸습니다." }); setPinLoading(false); return; }
    try {
      const updated = await updatePin(familyCode, currentUser, pinNew, familyData);
      onFamilyUpdate(updated);
      setPinMsg({ type: "ok", text: "비밀번호가 변경되었습니다." });
      setPinCurrent(""); setPinNew(""); setPinNewConfirm("");
    } catch {
      setPinMsg({ type: "err", text: "저장 중 오류가 발생했습니다." });
    }
    setPinLoading(false);
  }

  async function handleMcChange(e: React.FormEvent) {
    e.preventDefault();
    if (!familyCode) return;
    if (!mcNew.trim()) { setMcMsg({ type: "err", text: "새 마스터 코드를 입력해주세요." }); return; }
    if (mcNew !== mcNewConfirm) { setMcMsg({ type: "err", text: "새 마스터 코드가 일치하지 않습니다." }); return; }
    setMcLoading(true);
    const ok = await verifyMasterCode(mcCurrent, familyData, familyCode);
    if (!ok) { setMcMsg({ type: "err", text: "현재 마스터 코드가 틀렸습니다." }); setMcLoading(false); return; }
    try {
      const updated = await updateMasterCode(mcNew, familyData, familyCode);
      onFamilyUpdate(updated);
      setMcMsg({ type: "ok", text: "마스터 코드가 변경되었습니다." });
      setMcCurrent(""); setMcNew(""); setMcNewConfirm("");
    } catch {
      setMcMsg({ type: "err", text: "저장 중 오류가 발생했습니다." });
    }
    setMcLoading(false);
  }

  const chartData = ASSET_ORDER
    .filter((k) => alloc[k] > 0)
    .map((k) => ({ name: ASSET_GROUPS[k].label, value: alloc[k], group: ASSET_GROUPS[k].group }));

  // JSON export/import
  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kaw-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function onImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    f.text().then((t) => { try { importJson(JSON.parse(t)); } catch { alert("잘못된 JSON 파일입니다."); } });
    e.target.value = "";
  }

  // Excel export (with formulas)
  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const NUM_FMT = '#,##0';
    const PCT_FMT = '0.0%';

    ACCOUNT_IDS.forEach((id) => {
      const acc = state.accounts[id];
      const allocForProfile = state.allocations[state.profile];
      const history = acc.history;
      if (history.length === 0) return;

      const nDates = history.length;

      // 행/열 인덱스 (0-based JS, Excel 수식은 1-based)
      const ROW = {
        dateHeader: 0,
        subHeader:  1,
        assetStart: 2,
        assetEnd:   2 + ASSET_ORDER.length - 1,          // 10
        deposit:    2 + ASSET_ORDER.length,               // 11
        total:      2 + ASSET_ORDER.length + 1,           // 12
        returnRow:  2 + ASSET_ORDER.length + 2,           // 13
        note:       2 + ASSET_ORDER.length + 3,           // 14
      };
      const COL = {
        group:     0,
        asset:     1,
        etf:       2,
        weight:    3,
        dataStart: 4,
        rebalance: 4 + nDates * 2 + 1,
      };

      const ws: XLSX.WorkSheet = {};
      const a   = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
      const col = (c: number) => XLSX.utils.encode_col(c);
      const str = (r: number, c: number, v: string) => { if (v !== '') ws[a(r,c)] = { t:'s', v }; };
      const num = (r: number, c: number, v: number, z?: string) => { ws[a(r,c)] = z ? { t:'n', v, z } : { t:'n', v }; };
      const fml = (r: number, c: number, f: string, z?: string) => { ws[a(r,c)] = z ? { t:'n', f, z } : { t:'n', f }; };

      // ── 행 0: 날짜 헤더
      str(ROW.dateHeader, COL.group,  '구분');
      str(ROW.dateHeader, COL.asset,  '투자 대상');
      str(ROW.dateHeader, COL.etf,    'ETF');
      str(ROW.dateHeader, COL.weight, '배분');
      str(ROW.dateHeader, COL.rebalance, '추가매수');
      history.forEach((h, i) => str(ROW.dateHeader, COL.dataStart + i*2, h.date));

      // ── 행 1: 서브헤더
      history.forEach((_, i) => {
        str(ROW.subHeader, COL.dataStart + i*2,     '평가 금액');
        str(ROW.subHeader, COL.dataStart + i*2 + 1, '기준 금액');
      });

      // ── 행 2~10: 자산별 행
      ASSET_ORDER.forEach((k, ai) => {
        const r    = ROW.assetStart + ai;
        const exR  = r + 1; // Excel 1-based
        const pct  = allocForProfile[k] || 0;
        const ag   = ASSET_GROUPS[k];
        const hold = acc.holdings.find(h => h.assetKey === k);

        str(r, COL.group,  ag.group);
        str(r, COL.asset,  ag.label);
        str(r, COL.etf,    hold?.etfName ?? ag.defaultEtf);
        str(r, COL.weight, `${pct}%`);

        history.forEach((h, i) => {
          const evalCol = COL.dataStart + i*2;
          const baseCol = COL.dataStart + i*2 + 1;
          const evalVal = h.holdings?.[k];
          if (evalVal != null && evalVal > 0) num(r, evalCol, evalVal, NUM_FMT);
          // 기준금액 = 자산합계기준금액 × 배분비중 (수식)
          fml(r, baseCol, `${col(evalCol)}${exR}/${pct/100}*${pct/100}`, NUM_FMT);
          // 더 정확하게: 저장된 값이 있으면 그 값 사용, 없으면 0
          const baseVal = evalVal != null ? Math.round((h.baseAmount * pct) / 100) : 0;
          if (baseVal > 0) num(r, baseCol, baseVal, NUM_FMT); // 값으로 덮어쓰기
        });

        // 추가매수 수식: 마지막날 기준금액 − 마지막날 평가금액
        const lastEvalCol = COL.dataStart + (nDates-1)*2;
        const lastBaseCol = COL.dataStart + (nDates-1)*2 + 1;
        fml(r, COL.rebalance, `${col(lastBaseCol)}${exR}-${col(lastEvalCol)}${exR}`, NUM_FMT);
      });

      // ── 불입액 행
      str(ROW.deposit, COL.group,  '기타');
      str(ROW.deposit, COL.asset,  '월 불입액');
      history.forEach((h, i) => {
        if (h.deposit > 0) num(ROW.deposit, COL.dataStart + i*2 + 1, h.deposit, NUM_FMT);
      });

      // ── 자산합계 행 (SUM 수식)
      str(ROW.total, COL.group,  '자산합계');
      str(ROW.total, COL.weight, '100%');
      const r1 = ROW.assetStart + 1; // Excel 1-based
      const r2 = ROW.assetEnd   + 1;
      history.forEach((_, i) => {
        const ec = col(COL.dataStart + i*2);
        const bc = col(COL.dataStart + i*2 + 1);
        fml(ROW.total, COL.dataStart + i*2,     `SUM(${ec}${r1}:${ec}${r2})`, NUM_FMT);
        fml(ROW.total, COL.dataStart + i*2 + 1, `SUM(${bc}${r1}:${bc}${r2})`, NUM_FMT);
      });

      // ── 상승률 행 (수식: (현재평가 − 불입액 − 이전평가) / 이전평가)
      str(ROW.returnRow, COL.group, '상승');
      const totR = ROW.total   + 1; // Excel 1-based
      const depR = ROW.deposit + 1;
      history.forEach((_, i) => {
        if (i === 0) return;
        const curEvalC  = col(COL.dataStart + i*2);
        const curDepC   = col(COL.dataStart + i*2 + 1);
        const prevEvalC = col(COL.dataStart + (i-1)*2);
        fml(
          ROW.returnRow,
          COL.dataStart + i*2,
          `(${curEvalC}${totR}-${curDepC}${depR}-${prevEvalC}${totR})/${prevEvalC}${totR}`,
          PCT_FMT,
        );
      });

      // ── 주석 행
      str(ROW.note, COL.group, 'UH : 환노출형  H : 환헤지형');

      // 시트 범위 설정
      ws['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:ROW.note, c:COL.rebalance} });

      // 열 너비
      ws['!cols'] = [
        { wch: 10 }, { wch: 16 }, { wch: 28 }, { wch: 6 },
        ...Array.from({ length: nDates * 2 }, () => ({ wch: 14 })),
        { wch: 4  }, { wch: 14 },
      ];

      XLSX.utils.book_append_sheet(wb, ws, ACCOUNT_LABELS_SHORT[id]);
    });

    XLSX.writeFile(wb, `kaw-portfolio-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // Excel import
  function onImportExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const parsed = parseExcelWorkbook(wb);
        const importedAccounts = Object.keys(parsed);
        if (importedAccounts.length === 0) {
          alert("인식된 계좌 시트가 없습니다.\n시트명이 퇴직연금 / ISA / 연금저축 / IRP 인지 확인해주세요.");
          return;
        }
        const newState = {
          ...state,
          accounts: { ...state.accounts, ...parsed },
        };
        importJson(newState);
        alert(`가져오기 완료!\n적용된 계좌: ${importedAccounts.map(id => ACCOUNT_LABELS_SHORT[id as AccountId]).join(", ")}`);
      } catch (err) {
        alert(`엑셀 파일 읽기 실패: ${err}`);
      }
    };
    reader.readAsArrayBuffer(f);
    e.target.value = "";
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold">설정</h2>
        <p className="text-sm text-muted-foreground mt-1">투자 성향 및 데이터 관리</p>
      </div>

      {/* 투자 성향 */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="font-semibold">투자 성향</h3>
            <p className="text-sm text-muted-foreground">자산 배분 비중 프리셋 (수정 가능)</p>
          </div>
          <div className="flex gap-1 bg-muted p-1 rounded-lg">
            {(Object.keys(PROFILE_LABELS) as ProfileKey[]).map((p) => (
              <button key={p} onClick={() => setProfile(p)}
                className={`px-3 py-1.5 text-sm rounded-md transition ${
                  profile === p ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {PROFILE_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            {ASSET_ORDER.map((k) => (
              <div key={k} className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GROUP_COLORS[ASSET_GROUPS[k].group] }} />
                <span className="flex-1 truncate">{ASSET_GROUPS[k].label}</span>
                <Input type="number" step="0.5" value={alloc[k]}
                  onChange={(e) => setAllocation(profile, k, parseFloat(e.target.value) || 0)}
                  className="w-20 h-8 text-right" />
                <span className="text-muted-foreground w-4">%</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2 border-t mt-2">
              <span className={`text-sm font-medium ${Math.abs(total - 100) > 0.01 ? "text-destructive" : ""}`}>
                합계: {total.toFixed(1)}%
              </span>
              <Button variant="ghost" size="sm" onClick={() => resetAllocation(profile)}>
                <RotateCcw className="w-3.5 h-3.5 mr-1" /> 기본값
              </Button>
            </div>
          </div>
          <div className="h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={GROUP_COLORS[d.group]} fillOpacity={0.65 + (i % 3) * 0.12} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => `${v}%`}
                  contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      {/* 데이터 관리 */}
      <Card className="p-6 space-y-4">
        <h3 className="font-semibold">데이터 관리</h3>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ACCOUNT_IDS.map((id) => {
            const acc = state.accounts[id];
            const last = acc.history.length > 0 ? acc.history[acc.history.length - 1] : null;
            return (
              <div key={id} className="p-3 rounded-lg bg-muted/40 text-sm">
                <p className="font-medium">{ACCOUNT_LABELS_SHORT[id]}</p>
                <p className="text-muted-foreground text-xs mt-0.5">{last ? `${last.date} 기준` : "데이터 없음"}</p>
                <p className="font-semibold tabular-nums mt-1">{formatKRW(last?.totalValue ?? 0)} 원</p>
                <p className="text-xs text-muted-foreground">
                  히스토리 {acc.history.length}건 ·
                  종목데이터 {acc.history.filter(h => h.holdings && Object.keys(h.holdings).length > 0).length}건
                </p>
              </div>
            );
          })}
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium">JSON (전체 데이터 백업/복원)</p>
          <div className="flex gap-2 flex-wrap">
            <input ref={jsonFileRef} type="file" accept="application/json" hidden onChange={onImportJson} />
            <Button variant="outline" size="sm" onClick={() => jsonFileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-1.5" /> JSON 가져오기
            </Button>
            <Button variant="outline" size="sm" onClick={exportJson}>
              <Download className="w-4 h-4 mr-1.5" /> JSON 내보내기
            </Button>
          </div>
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium">엑셀 (계좌별 시트 형식)</p>
          <p className="text-xs text-muted-foreground">
            가져오기: 퇴직연금·ISA·연금저축·IRP 시트명이 있는 파일만 가능 (현재 파일 형식 기준)
          </p>
          <div className="flex gap-2 flex-wrap">
            <input ref={xlsxFileRef} type="file" accept=".xlsx,.xls" hidden onChange={onImportExcel} />
            <Button variant="outline" size="sm" onClick={() => xlsxFileRef.current?.click()}>
              <FileSpreadsheet className="w-4 h-4 mr-1.5" /> 엑셀 가져오기
            </Button>
            <Button variant="outline" size="sm" onClick={exportExcel}>
              <FileSpreadsheet className="w-4 h-4 mr-1.5" /> 엑셀 내보내기
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">UH: 환노출 · H: 환헤지 · 모든 데이터는 브라우저 localStorage에만 저장됩니다.</p>
        </div>

        <div className="border-t pt-4">
          <Button variant="destructive" size="sm"
            onClick={() => { if (confirm("모든 데이터를 초기화할까요?\n엑셀 원본 히스토리 데이터는 자동 복원됩니다.")) resetAll(); }}>
            <Trash2 className="w-4 h-4 mr-1.5" /> 전체 초기화
          </Button>
        </div>
      </Card>

      {/* 비밀번호 변경 */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-violet-500" />
          <h3 className="font-semibold">프로필 비밀번호 변경</h3>
        </div>
        <form onSubmit={handlePinChange} className="space-y-3 max-w-sm">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">현재 비밀번호</label>
            <input type="password" inputMode="numeric" maxLength={4} value={pinCurrent}
              onChange={(e) => { setPinCurrent(e.target.value.replace(/\D/g, "")); setPinMsg(null); }}
              placeholder="••••" className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.4em]" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">새 비밀번호 (숫자 4자리)</label>
            <input type="password" inputMode="numeric" maxLength={4} value={pinNew}
              onChange={(e) => { setPinNew(e.target.value.replace(/\D/g, "")); setPinMsg(null); }}
              placeholder="••••" className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.4em]" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">새 비밀번호 확인</label>
            <input type="password" inputMode="numeric" maxLength={4} value={pinNewConfirm}
              onChange={(e) => { setPinNewConfirm(e.target.value.replace(/\D/g, "")); setPinMsg(null); }}
              placeholder="••••" className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.4em]" />
          </div>
          {pinMsg && (
            <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${pinMsg.type === "ok" ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"}`}>
              {pinMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
              {pinMsg.text}
            </div>
          )}
          <Button type="submit" size="sm" disabled={pinLoading || pinCurrent.length !== 4 || pinNew.length !== 4 || pinNewConfirm.length !== 4}>
            {pinLoading ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <KeyRound className="w-3.5 h-3.5 mr-1" />}
            비밀번호 변경
          </Button>
        </form>
      </Card>

      {/* 마스터 코드 변경 (관리자 전용) */}
      {isAdmin && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-amber-500" />
            <div>
              <h3 className="font-semibold">마스터 코드 변경</h3>
              <p className="text-xs text-muted-foreground">관리자 프로필에서만 변경 가능합니다.</p>
            </div>
          </div>
          <form onSubmit={handleMcChange} className="space-y-3 max-w-sm">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">현재 마스터 코드</label>
              <input type="password" value={mcCurrent}
                onChange={(e) => { setMcCurrent(e.target.value); setMcMsg(null); }}
                placeholder="현재 코드"
                className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">새 마스터 코드</label>
              <input type="password" value={mcNew}
                onChange={(e) => { setMcNew(e.target.value); setMcMsg(null); }}
                placeholder="새 코드"
                className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">새 마스터 코드 확인</label>
              <input type="password" value={mcNewConfirm}
                onChange={(e) => { setMcNewConfirm(e.target.value); setMcMsg(null); }}
                placeholder="새 코드 확인"
                className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all" />
            </div>
            {mcMsg && (
              <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${mcMsg.type === "ok" ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"}`}>
                {mcMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                {mcMsg.text}
              </div>
            )}
            <Button type="submit" size="sm" variant="outline" disabled={mcLoading || !mcCurrent || !mcNew}>
              {mcLoading ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Shield className="w-3.5 h-3.5 mr-1" />}
              마스터 코드 변경
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
