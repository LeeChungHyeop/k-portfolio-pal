// 한국투자 체결내역 미리보기 mock 화면 — 운영 DB·증권사·.env 와 완전히 분리돼 있다.
//   · 요청은 전부 가짜(kis-execution-mock.ts)로 간다. fetch 를 호출하지 않는다
//   · 종목·수량·금액·주문번호는 실증된 응답 구조를 흉내 낸 값이다
// 실행: npm run mock:exec → http://localhost:5182
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { KisExecutionImportPanel } from "@/components/kaw/KisExecutionImportPanel";
import { EXEC_MOCK_SCENARIO_TEXT, MOCK_KIS, MOCK_TODAY, createMockExecRequest, type ExecMockScenario } from "@/lib/kaw/kis-execution-mock";

function App() {
  const [scenario, setScenario] = useState<ExecMockScenario>("ok_with_residual");
  const [dark, setDark] = useState(true);
  const [run, setRun] = useState(0);
  const api = useMemo(() => createMockExecRequest(scenario, 400), [scenario, run]);
  document.documentElement.classList.toggle("dark", dark);

  return (
    <div className="min-h-screen p-4 space-y-4">
      <div className="rounded-md border-2 border-dashed border-amber-500 bg-amber-500/10 p-3 text-xs space-y-1" data-testid="mock-banner">
        <p className="font-semibold">MOCK 화면 — 운영 DB·증권사·.env 와 연결되지 않습니다</p>
        <p>모든 응답은 가짜입니다. 이 화면은 원장·장부에 아무것도 쓰지 않습니다.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <label className="flex items-center gap-1 min-w-0 max-w-full">
          시나리오
          <select className="min-w-0 max-w-full rounded border bg-background px-2 py-1" value={scenario}
            onChange={(e) => { setScenario(e.target.value as ExecMockScenario); setRun((r) => r + 1); }}>
            {Object.entries(EXEC_MOCK_SCENARIO_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> 다크
        </label>
      </div>
      <KisExecutionImportPanel key={`${scenario}-${run}`} registry={[MOCK_KIS]} today={MOCK_TODAY} request={api.request} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
