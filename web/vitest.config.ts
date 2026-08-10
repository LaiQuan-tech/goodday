import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Next.js 的 `@/*` → `./src/*`(見 tsconfig.json paths)。vitest 不讀 tsconfig paths,
    // 這裡必須自己對上,否則 route.ts 的 `@/lib/...` import 會解析失敗。
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // ⚠️ 兩個根目錄都要列。Realreal 的 apps/api 曾因為 include 只寫了 "src/**/*.test.ts"
    // 而靜默跳過 test/ 底下 4 支檔案(65 個 case)—— vitest 對「沒對到任何檔案的 glob」
    // 不會報錯,exit code 照樣是 0,所以是無聲漏掉。新增測試目錄時記得同步補這裡,
    // 並用 `Test Files N passed` 的檔數對一次磁碟上的檔數。
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    // 測試一律 hermetic:supabase / resend / 金流全部 vi.mock 假掉,不連任何 DB、
    // Redis 或外部 API。這裡的假 env 只是為了讓「萬一有模組在 import 期讀 env」時
    // 不會炸,不代表任何真實服務存在(URL 指向不存在的 localhost port)。
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      RESEND_API_KEY: "test-resend-key",
    },
  },
});
