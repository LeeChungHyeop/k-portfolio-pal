export const SECRET_QUESTIONS = [
  { question: "내가 가장 오래 자란 도시는?",       answer: "대전" },
  { question: "점심시간에 하는 운동은?",            answer: "러닝" },
  { question: "우리집 도로명 주소는 OO로?",         answer: "진현" },
  { question: "소예가 태어난 시간은 몇시?",         answer: "12시" },
  { question: "지금 가장 갖고 싶은건?",             answer: "맥북" },
] as const;

export type SQIndex = 0 | 1 | 2 | 3 | 4;

export function pickRandomSQIndex(): SQIndex {
  return Math.floor(Math.random() * SECRET_QUESTIONS.length) as SQIndex;
}

export function verifySQAnswer(idx: SQIndex, answer: string): boolean {
  return answer.trim() === SECRET_QUESTIONS[idx].answer;
}
