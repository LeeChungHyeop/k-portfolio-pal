// 정답은 서버(data-server.ts)에만 존재한다 — 클라이언트 번들에는 질문 텍스트만 포함.
export const SECRET_QUESTIONS = [
  { question: "내가 가장 오래 자란 도시는?" },
  { question: "점심시간에 하는 운동은?" },
  { question: "우리집 도로명 주소는 OO로?" },
  { question: "소예가 태어난 시간은 몇시?" },
  { question: "지금 가장 갖고 싶은건?" },
] as const;

export type SQIndex = 0 | 1 | 2 | 3 | 4;

export function pickRandomSQIndex(): SQIndex {
  return Math.floor(Math.random() * SECRET_QUESTIONS.length) as SQIndex;
}

/** 서버가 "비밀 질문 인증이 꺼져 있다"고 마지막으로 알려줬는가(오답과 구별해 안내하려고) */
let sqDisabled = false;

export async function verifySQAnswer(idx: SQIndex, answer: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/verify-secret-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sqIdx: idx, answer: answer.trim() }),
    });
    const data = (await res.json()) as { ok?: boolean; disabled?: boolean };
    sqDisabled = data.disabled === true;
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

/** 실패한 뒤 사용자에게 보여줄 문구. 꺼져 있으면 오답이 아니라고 알려준다. */
export function sqFailureMessage(): string {
  return sqDisabled
    ? "비밀 질문 인증은 현재 사용할 수 없습니다. 마스터 코드나 현재 PIN 으로 인증해 주세요."
    : "정답이 맞지 않습니다. 다시 시도해주세요.";
}
