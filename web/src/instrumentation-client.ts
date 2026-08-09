// Sentry(web / 瀏覽器端)— 內容移植自 Realreal:apps/web/sentry.client.config.ts。
// 檔名刻意用 instrumentation-client.ts 而非 sentry.client.config.ts:
// @sentry/nextjs v9+ 已對後者發出 deprecation 警告,且在 Turbopack 下不會生效。
import * as Sentry from "@sentry/nextjs";

// 這支會被打進瀏覽器 bundle,所以只能用 NEXT_PUBLIC_ 前綴的公開 DSN。
// 任何 server 端專用的 key 都不准出現在這個檔案裡。
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 1.0,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
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

// App Router 的頁面切換 instrumentation(navigation span)。
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
