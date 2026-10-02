// 단위 테스트 전용 설정. vite.config.ts 를 재사용하지 않는다 —
// 거기엔 TanStack Start / Cloudflare 플러그인이 들어 있어 테스트 런타임에 불필요하고,
// 중복 로딩 시 앱 빌드가 깨질 수 있다(vite.config.ts 상단 주석 참고).
//
// 대상은 React 렌더링이 아닌 **순수 계산 로직**이다 (cashflow / performance / snapshot).
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
