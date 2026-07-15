import { createFileRoute } from "@tanstack/react-router";
import { App } from "@/components/kaw/App";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "K-올웨더 포트폴리오 트래커" },
      { name: "description", content: "K-올웨더 자산 배분 리밸런싱 및 수익률 관리 대시보드" },
    ],
  }),
  component: App,
});
