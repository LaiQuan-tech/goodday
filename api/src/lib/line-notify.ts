/**
 * 把一行訊息推到 LINE Notify。
 *
 * 移植自 Realreal:apps/api/src/lib/line-notify.ts(同一套「Sentry 事件鏡射到 LINE」做法)。
 * 兩處刻意的差異:
 *  1. Realreal 用 axios;goodday 的 api 沒有 axios 依賴,改用 Node 20 內建 fetch,行為相同。
 *  2. Realreal 的 token 可以從 app_settings 資料表覆寫;goodday 只讀環境變數。
 *     告警路徑不該再依賴資料庫 —— 資料庫掛掉正是最需要收到告警的時候。
 *
 * - 沒設定 token 就靜默 no-op(dev / staging 不會一直噴警告)。
 * - 5 秒 timeout、失敗不致命。LINE 掛掉絕對不能反過來弄壞排程或 Sentry 管線。
 */
export async function sendLineNotify(message: string): Promise<void> {
  try {
    const token = process.env.LINE_NOTIFY_TOKEN;
    if (!token) return; // 未設定就跳過

    const res = await fetch("https://notify-api.line.me/api/notify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ message }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[line-notify] HTTP ${res.status}`);
    }
  } catch (err) {
    // 非致命:記錄後繼續。
    console.warn("[line-notify] failed:", err);
  }
}

/**
 * 排程/系統層級告警的統一出口。
 *
 * 目前只走 LINE Notify(與 Realreal 一致);Sentry 事件本身由 sentry.ts 的
 * beforeSend 鏡射,這支則給「不是例外、但需要有人看到」的狀況用
 * (例如:排程太久沒有成功跑完)。永遠不 throw。
 */
export async function sendAlert(title: string, detail: string): Promise<void> {
  const body = `🚨 ${title}\n${detail}`.slice(0, 950); // LINE Notify 單則上限 1000 字
  console.error(`[alert] ${title} — ${detail}`);
  await sendLineNotify(body);
}
