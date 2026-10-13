// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 조회 결과 → 화면 문구 (순수)
//
// **조회하지 않았거나 실패한 값을 0 으로 쓰지 않는다.** 값이 없으면 "확인 못 함"이다.
// ─────────────────────────────────────────────────────────────────────────────

import { GATE_REASON_TEXT, type KisClientResult } from "./kis-account-client";

export interface KisResultView {
  tone: "ok" | "warn" | "error";
  title: string;
  lines: string[];
}

const won = (n: number) => `${new Intl.NumberFormat("ko-KR").format(Math.round(n))}원`;

export function describeKisResult(r: KisClientResult): KisResultView {
  switch (r.kind) {
    case "blocked":
      return { tone: "warn", title: "조회하지 않았습니다", lines: [GATE_REASON_TEXT[r.gate.reason]] };
    case "denied":
      return {
        tone: "error",
        title: "조회 권한이 없습니다",
        lines: ["이 프로필에는 한국투자 계좌 조회 권한이 없어 서버가 조회를 거부했습니다."],
      };
    case "unauthenticated":
      return { tone: "error", title: "로그인이 필요합니다", lines: ["세션이 만료됐습니다. 다시 로그인해 주세요."] };
    case "unavailable":
      return { tone: "error", title: "조회하지 못했습니다", lines: [r.message] };
    case "result": {
      const { observation: o, plan } = r;
      const lines: string[] = [];

      if (o.holdings.kind === "observed") {
        const h = o.holdings.value;
        const n = Object.keys(h.positions).length;
        if (n > 0) lines.push(`보유 ${n}종목`);
        else if (h.emptyMeaning === "confirmed_zero") lines.push("보유종목 없음 (확인됨)");
        else lines.push("보유종목 응답이 비어 있습니다 — 빈 계좌인지 확인할 수 없습니다");
      } else if (o.holdings.kind === "failed") {
        lines.push(`보유종목 조회 실패: ${o.holdings.error}`);
      } else {
        lines.push("보유종목을 조회하지 않았습니다");
      }

      if (o.cash.kind === "observed") lines.push(`예수금 ${won(o.cash.value)}`);
      else if (o.cash.kind === "failed") lines.push(`예수금 조회 실패: ${o.cash.error}`);
      else lines.push("예수금을 조회하지 않았습니다");

      for (const b of plan.blockers) lines.push(b.message);

      return {
        tone: plan.ready ? "ok" : "warn",
        title: plan.ready ? "읽기 전용 조회 성공" : "조회 결과가 완전하지 않습니다",
        lines,
      };
    }
  }
}
