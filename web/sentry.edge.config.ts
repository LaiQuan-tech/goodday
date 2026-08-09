// Sentry(web / Next.js edge runtime,middleware.ts 走這裡)
// 移植自 Realreal:apps/web/sentry.edge.config.ts,由 src/instrumentation.ts 載入。
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  tracesSampleRate: 0.1,
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
