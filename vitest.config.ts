// 단위 테스트 전용 설정. vite.config.ts 를 재사용하지 않는다 —
// 거기엔 TanStack Start / Cloudflare 플러그인이 들어 있어 테스트 런타임에 불필요하고,
// 중복 로딩 시 앱 빌드가 깨질 수 있다(vite.config.ts 상단 주석 참고).
//
// 대상은 **순수 계산 로직**(cashflow / performance / snapshot)이고, 화면 컴포넌트는 `*.test.tsx` 에서
// 파일 상단 `// @vitest-environment jsdom` 주석으로 jsdom 을 켜서 실제로 렌더링·상호작용한다.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
