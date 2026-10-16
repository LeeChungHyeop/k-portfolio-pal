// 체결내역 미리보기 UI mock 전용 Vite 설정(vite.mock.config.ts 와 같은 구조). 앱 설정을 재사용하지 않는다.
// 실행: npm run mock:exec → http://localhost:5182
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "mock/kis-exec-ui"),
  envDir: path.resolve(import.meta.dirname, "mock/kis-exec-ui"),
  envPrefix: "KAW_MOCK_ONLY_",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5182, strictPort: true, host: "127.0.0.1" },
});
