// Sentry(api / Railway)— 移植自 Realreal:apps/api/src/sentry.ts
//
// 必須在任何其他模組之前被 import(見 index.ts 第一行),否則 Sentry 的自動
// instrumentation 來不及掛上 http / undici 等模組。
import * as Sentry from "@sentry/node";
import { sendAlert } from "./lib/alert.js";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  tracesSampleRate: 0.1,
  // Realreal 用 NODE_ENV === "production" 當開關;這裡改用「有沒有 DSN」判斷。
  // 理由:Railway 不保證注入 NODE_ENV=production,用 NODE_ENV 當閘門的話會出現
  // 「線上炸了但 Sentry 被靜默關掉」—— 正是這次要修掉的失敗模式。沒填 DSN 時
  // Sentry 本來就不會送任何東西,所以 dev 端不會誤傳。
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV ?? "development",
  // 把 error 等級以上的 Sentry 事件鏡射成一封告警信,營運者不必盯著 Sentry
  // 收件匣。fire-and-forget;sendAlert 自己吞掉傳輸錯誤,也自帶節流。
  // (Realreal 這裡走 LINE Notify,但該服務已於 2025-03-31 終止,端點是死的。)
  beforeSend(event) {
    // tags.alert === "skip":呼叫端自己已經寄過更完整的告警信了(例如排程整輪
    // 失敗的彙總信會列出所有失敗 step),這裡不再重複寄一封。
    // 這樣「一次事故 = 一封信」,而不是每個 step 各噴一封把信箱和 Resend 配額洗掉。
    if (event.tags?.alert === "skip") return event;

    if (event.level === "error" || event.level === "fatal") {
      const message = event.exception?.values?.[0]?.value ?? event.message ?? "unknown";
      const errorType = event.exception?.values?.[0]?.type;
      sendAlert(`線上錯誤(goodday api)`, errorType ? `${errorType}: ${message}` : message, {
        level: event.level,
        source: String(event.tags?.source ?? event.tags?.job ?? "api"),
        step: event.tags?.step ? String(event.tags.step) : undefined,
        extra: {
          trigger: event.tags?.trigger ? String(event.tags.trigger) : undefined,
        },
      }).catch(() => {});
    }
    return event;
  },
});

export const sentryEnabled = Boolean(dsn);
export { Sentry };
