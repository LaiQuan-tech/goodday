// Sentry(web / Next.js server runtime)— 移植自 Realreal:apps/web/sentry.server.config.ts
// 由 src/instrumentation.ts 的 register() 載入。
import * as Sentry from "@sentry/nextjs";

// server 端專用 DSN,絕對不要加 NEXT_PUBLIC_ 前綴(那會被打進瀏覽器 bundle)。
const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  tracesSampleRate: 0.1,
  // 以「有沒有 DSN」當開關,而不是 NODE_ENV:Vercel preview / 其他環境
  // 一樣要能收到錯誤,沒填 DSN 時 Sentry 本來就不會送任何東西。
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  beforeSend(event) {
    // 送出前把 PII 洗掉
    if (event.user) {
      event.user.email = undefined;
      event.user.ip_address = undefined;
      event.user.username = undefined;
    }
    if (event.request?.headers) {
      delete event.request.headers["cookie"];
      delete event.request.headers["authorization"];
    }
    return event;
  },
});
