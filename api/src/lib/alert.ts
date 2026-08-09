/**
 * 系統告警通道(排程失敗、線上錯誤)——走 Resend 寄信給管理者。
 *
 * 為什麼不是 LINE Notify:LINE Notify 已於 2025-03-31 正式終止服務,端點是死的。
 * Realreal 的「Sentry 事件鏡射到 LINE Notify」做法照搬過來會得到一條靜默失效的
 * 告警鏈。改走 goodday 既有的 Resend:憑證已經在跑、不需要申請任何新東西。
 *
 * 慣例沿用 web/src/lib/resend.ts:
 *  - 直接打 https://api.resend.com/emails,不用 SDK
 *  - 寄件者 RESEND_FROM,未設定則用同一組預設值
 *  - 收件者 CONTACT_NOTIFY_TO(與 web 的 notifyAdmin 同一個變數)
 *  - 沒設定 RESEND_API_KEY / CONTACT_NOTIFY_TO 就視為「告警通道停用」:
 *    只記 log、回傳 false,絕不 throw。告警管道掛掉不能反過來弄壞排程或主流程。
 */

const RESEND_URL = "https://api.resend.com/emails";

export type AlertContext = {
  /** 來源:例如 "scheduler"、"sentry"、"hono" */
  source?: string;
  /** 失敗的排程 step 名稱(若適用) */
  step?: string;
  /** 嚴重度,預設 error */
  level?: string;
  /** 其他要一起放進信裡的欄位 */
  extra?: Record<string, string | number | boolean | null | undefined>;
};

// ── 節流:同一組憑證也在寄客人的訂單/報價信,錯誤風暴不能把 Resend 配額燒光 ──
const WINDOW_MS = 60 * 60 * 1000; // 1 小時
const MAX_PER_WINDOW = 10;
const DEDUPE_MS = 15 * 60 * 1000; // 同樣內容 15 分鐘內只寄一次
let windowStartedAt = Date.now();
let sentInWindow = 0;
const recentlySent = new Map<string, number>();

function throttled(key: string): boolean {
  const now = Date.now();

  if (now - windowStartedAt > WINDOW_MS) {
    windowStartedAt = now;
    sentInWindow = 0;
  }

  const last = recentlySent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) {
    console.warn(`[alert] 重複告警,${Math.round(DEDUPE_MS / 60000)} 分鐘內已寄過,略過寄信`);
    return true;
  }

  if (sentInWindow >= MAX_PER_WINDOW) {
    console.warn(
      `[alert] 本小時已寄出 ${sentInWindow} 封告警信,超過上限 ${MAX_PER_WINDOW},略過寄信` +
        `(事件仍在 Sentry,不會遺失)`
    );
    return true;
  }

  sentInWindow++;
  recentlySent.set(key, now);
  // 清掉過期的 dedupe 紀錄,避免長跑進程慢慢長大
  for (const [k, t] of recentlySent) {
    if (now - t > DEDUPE_MS) recentlySent.delete(k);
  }
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(title: string, detail: string, ctx: AlertContext, now: Date): string {
  const taipei = now.toLocaleString("zh-TW", { timeZone: process.env.TZ ?? "Asia/Taipei" });
  const rows: Array<[string, string]> = [
    ["嚴重度", ctx.level ?? "error"],
    ["來源", ctx.source ?? "api"],
    ["Step", ctx.step ?? "—"],
    ["發生時間", `${taipei}(台北)`],
    ["UTC", now.toISOString()],
    ["環境", process.env.NODE_ENV ?? "development"],
  ];
  for (const [k, v] of Object.entries(ctx.extra ?? {})) {
    if (v !== undefined && v !== null && v !== "") rows.push([k, String(v)]);
  }

  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#8a7259;white-space:nowrap;">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 0;color:#2a2016;"><code>${escapeHtml(v)}</code></td></tr>`
    )
    .join("");

  return `
  <div style="font-family:'Noto Serif TC','Noto Sans TC','PingFang TC',sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#2a2016;">
    <div style="font-size:20px;font-weight:700;letter-spacing:.2em;margin-bottom:4px;color:#2e2519;">好日子</div>
    <div style="font-size:12px;color:#8a7259;margin-bottom:20px;">Good Days · 系統告警</div>
    <div style="border:1px solid #e2d7c4;border-left:4px solid #b4441f;border-radius:4px;padding:24px;background:#faf6ee;">
      <h2 style="margin:0 0 16px;font-size:17px;color:#b4441f;">🚨 ${escapeHtml(title)}</h2>
      <pre style="margin:0 0 20px;padding:12px;background:#fff;border:1px solid #e2d7c4;border-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:13px;color:#2a2016;">${escapeHtml(detail)}</pre>
      <table style="font-size:13px;border-collapse:collapse;">${table}</table>
    </div>
    <div style="font-size:12px;color:#8a7259;margin-top:16px;">此信件由系統自動發送,請勿直接回覆。完整堆疊與歷史請看 Sentry。</div>
  </div>`;
}

/**
 * 寄出一封告警信。永遠不 throw;回傳是否真的送出去了。
 *
 * 介面刻意與原本的 LINE 版一致(title, detail),第三個參數是選填的情境資訊,
 * 讓信件內容能直接判斷嚴重度:錯誤訊息、來源/step、時間都會列在信裡。
 */
export async function sendAlert(
  title: string,
  detail: string,
  context: AlertContext = {}
): Promise<boolean> {
  const now = new Date();
  // 不論通道是否啟用都先落一筆 log,Railway log 至少留得下痕跡
  console.error(
    `[alert] ${title} — ${detail}` +
      (context.step ? ` (step=${context.step})` : "") +
      (context.source ? ` (source=${context.source})` : "")
  );

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_NOTIFY_TO;
  if (!apiKey || !to) {
    // 告警通道停用 —— 與原本 LINE 版沒 token 時的語意一致,不吵、不炸。
    console.warn(
      "[alert] 告警通道停用(缺少 RESEND_API_KEY 或 CONTACT_NOTIFY_TO),本則告警只留在 log"
    );
    return false;
  }

  if (throttled(`${title}::${detail.slice(0, 200)}`)) return false;

  const from = process.env.RESEND_FROM ?? "好日子 Good Days <onboarding@resend.dev>";
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `【好日子告警】${title}`,
        html: buildHtml(title, detail, context, now),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error("[alert] Resend 寄送失敗:", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    // 非致命:告警寄不出去也不能讓排程或主流程掛掉。
    console.error("[alert] Resend 寄送錯誤:", err);
    return false;
  }
}
