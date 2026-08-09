import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Supabase Storage 商品圖片
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

// Sentry build 期整合:注入 client/server instrumentation、包裝 route handler、
// 上傳 source map(才看得到原始碼行號而不是壓縮後的亂碼)。
// SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN 只在 build 期使用,不會進 client bundle;
// 沒設定時只是不上傳 source map,build 仍會成功。
export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  // 把 Sentry SDK 自己的 debug log 從 production bundle 裡搖掉
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
