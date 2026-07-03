// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

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
    },
    server: {
      watch: { usePolling: true, interval: 300 },
    },
  },
});
