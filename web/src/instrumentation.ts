// Next.js instrumentation hook — server / edge runtime 的 Sentry 進入點。
// 沒有這個檔案的話 sentry.server.config.ts / sentry.edge.config.ts 不會被載入,
// server 端的例外就不會送出去(withSentryConfig 只處理 build 期的事)。
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Next.js 15 的 error hook:Server Component、Route Handler、middleware 裡
// 沒被接住的例外都會經過這裡。這是「未捕捉例外會送出」在 server 端的關鍵接線。
export const onRequestError = Sentry.captureRequestError;
