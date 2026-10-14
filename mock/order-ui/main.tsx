// 주문 승인 UI mock 화면 — 운영 DB·증권사·.env 와 완전히 분리돼 있다.
//   · 요청은 전부 가짜 API(order-mock-api.ts)로 간다. fetch 를 호출하지 않는다
//   · 계좌·가격·주문번호는 가상값이다
//   · 의도 id 저장소도 메모리다(브라우저 localStorage 를 쓰지 않는다)
// 실행: npm run mock:order → http://localhost:5181
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { OrderApprovalPanel, type IntentIdStorage } from "@/components/kaw/OrderApprovalPanel";
import {
  MOCK_INSTANCE, MOCK_LINKABLE_ORDER_NO, MOCK_SCENARIO_TEXT, createMockOrderApi, type MockScenario,
} from "@/lib/kaw/order-mock-api";

function memoryStorage(): IntentIdStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

function App() {
  const [scenario, setScenario] = useState<MockScenario>("accept_then_fill");
  const [dayClosed, setDayClosed] = useState(false);
  const [dismissOn, setDismissOn] = useState(false);
  const [width, setWidth] = useState<"pc" | "mobile">("pc");
  const [dark, setDark] = useState(true);
  const [run, setRun] = useState(0);
  const [, force] = useState(0);

  const dayRef = useMemo(() => ({ v: false, d: false }), []);
  dayRef.v = dayClosed;
  dayRef.d = dismissOn;
  // run 이 바뀌면 API·저장소·패널을 새로 만든다(= 새로고침 모사는 "패널만 다시 그리기")
  const api = useMemo(() => createMockOrderApi(scenario, { delayMs: 500, dayClosed: () => dayRef.v, dismissEnabled: () => dayRef.d }), [scenario, run, dayRef]);
  const storage = useMemo(() => memoryStorage(), [scenario, run]);
  const [panelKey, setPanelKey] = useState(0);

  document.documentElement.classList.toggle("dark", dark);

  return (
    <div className="min-h-screen p-4 space-y-4">
      <div className="rounded-md border-2 border-dashed border-amber-500 bg-amber-500/10 p-3 text-xs space-y-1" data-testid="mock-banner">
        <p className="font-semibold">MOCK 화면 — 운영 DB·증권사·.env 와 연결되지 않습니다</p>
        <p>모든 응답은 가짜이고 계좌·가격·주문번호는 가상값입니다. 수동 연결 테스트용 주문번호: {MOCK_LINKABLE_ORDER_NO}</p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <label className="flex items-center gap-1 min-w-0 max-w-full">
          시나리오
          <select className="min-w-0 max-w-full rounded border bg-background px-2 py-1" value={scenario}
            onChange={(e) => { setScenario(e.target.value as MockScenario); setRun((r) => r + 1); }}>
            {Object.entries(MOCK_SCENARIO_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={dayClosed} onChange={(e) => setDayClosed(e.target.checked)} />
          주문일 장 마감됨(다음 날)
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={dismissOn} onChange={(e) => setDismissOn(e.target.checked)} />
          서버 미접수 정리 허용(운영 기본 OFF)
        </label>
        <button className="rounded border px-2 py-1" onClick={() => setWidth(width === "pc" ? "mobile" : "pc")}>
          폭: {width === "pc" ? "PC" : "모바일 390px"}
        </button>
        <button className="rounded border px-2 py-1" onClick={() => setDark(!dark)}>{dark ? "다크" : "라이트"}</button>
        <button className="rounded border px-2 py-1" onClick={() => setPanelKey((k) => k + 1)}>새로고침 모사(패널 재마운트)</button>
        <button className="rounded border px-2 py-1" onClick={() => setRun((r) => r + 1)}>처음부터</button>
      </div>

      <div className={width === "mobile" ? "mx-auto w-[390px] max-w-full border rounded-lg p-2" : "max-w-3xl"} data-testid="mock-frame">
        <OrderApprovalPanel key={`${run}-${panelKey}`} instance={MOCK_INSTANCE} api={api} storage={storage} />
      </div>

      <div className="text-xs space-y-1">
        <p className="font-semibold">호출 기록 (가상 증권사 주문 {api.placedCount()}건)
          <button className="ml-2 underline" onClick={() => force((n) => n + 1)}>갱신</button></p>
        <ol className="list-decimal pl-5" data-testid="mock-calls">
          {api.calls.map((c, n) => <li key={n}>{c}</li>)}
        </ol>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
