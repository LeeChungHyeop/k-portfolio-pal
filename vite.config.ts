// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { execSync } from "node:child_process";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// 빌드 시점의 커밋 해시/일시를 baking — 사이드바 "최근배포일" 표시가 실제 빌드된 커밋과
// 정확히 일치하도록 한다 (커밋 시점에 훅으로 스탬프하면 그 커밋 자신의 해시를 알 수 없어 부정확했음).
function safeExec(cmd: string): string {
  try {
    return execSync(cmd).toString().trim();
  } catch {
    return "unknown";
  }
}
// KST 고정. 예전에는 `env TZ='Asia/Seoul' date`를 썼는데 Windows/배포 셸에 따라 TZ가
// 무시되어 UTC가 그대로 박혔다. Intl로 직접 조립해 실행 환경의 TZ에 의존하지 않는다.
function getKstBuildTime(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}`;
}

const COMMIT_HASH = safeExec("git rev-parse --short HEAD");
const BUILD_TIME = getKstBuildTime();

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    // Supabase는 이제 서버(Cloudflare Worker)에서만 접속하므로 클라이언트에 baking하지 않는다.
    define: {
      "import.meta.env.VITE_ACCESS_CODE":
        JSON.stringify(process.env.VITE_ACCESS_CODE ?? "soye"),
      "import.meta.env.VITE_COMMIT_HASH": JSON.stringify(COMMIT_HASH),
      "import.meta.env.VITE_BUILD_TIME": JSON.stringify(BUILD_TIME),
    },
    server: {
      watch: { usePolling: true, interval: 300 },
    },
  },
});
