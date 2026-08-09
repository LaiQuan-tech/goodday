// Sentry(api / Railway)— 移植自 Realreal:apps/api/src/sentry.ts
//
// 必須在任何其他模組之前被 import(見 index.ts 第一行),否則 Sentry 的自動
// instrumentation 來不及掛上 http / undici 等模組。
import * as Sentry from "@sentry/node";
import { sendLineNotify } from "./lib/line-notify.js";

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
  // 把 error 等級以上的 Sentry 事件鏡射到 LINE Notify,營運者不必盯著 Sentry
  // 收件匣。fire-and-forget;sendLineNotify 自己吞掉傳輸錯誤。
  beforeSend(event) {
    if (event.level === "error" || event.level === "fatal") {
      const msg =
        `🚨 線上錯誤(goodday api)\n` +
        `${event.exception?.values?.[0]?.value ?? event.message ?? "unknown"}`;
      sendLineNotify(msg).catch(() => {});
    }
    return event;
  },
});

export const sentryEnabled = Boolean(dsn);
export { Sentry };
