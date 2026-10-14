// 주문 승인 UI mock 화면 전용 Vite 설정. 앱 설정(vite.config.ts)을 재사용하지 않는다 —
// TanStack Start·Cloudflare·Supabase 와 무관하게 컴포넌트만 띄운다.
//
//   · envDir 을 mock 폴더로, envPrefix 를 쓰지 않는 접두어로 둔다 → 저장소의 .env(VITE_SUPABASE_* 등)가
//     번들에 들어가지 않는다
//   · 화면은 가짜 API 만 쓴다(mock/order-ui/main.tsx)
// 실행: npm run mock:order → http://localhost:5181
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "mock/order-ui"),
  envDir: path.resolve(import.meta.dirname, "mock/order-ui"),
  envPrefix: "KAW_MOCK_ONLY_",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: { port: 5181, strictPort: true, host: "127.0.0.1" },
});
