import { createFileRoute } from "@tanstack/react-router";
import { App } from "@/components/kaw/App";

// 다른 사람에게 공유용 데모 프로필만 보여주는 링크 — 액세스 코드 입력·프로필 목록(실명 노출) 화면을 건너뛰고
// "테스트" 프로필의 PIN 입력 화면으로 바로 이동한다.
export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "K-올웨더 포트폴리오 트래커 (데모)" },
      { name: "description", content: "K-올웨더 데모 대시보드" },
    ],
  }),
  component: () => <App forcedDemoProfileId="test" />,
});
