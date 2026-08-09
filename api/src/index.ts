// ⚠️ 這行必須是整個檔案的第一個 import:Sentry 要在其他模組(http/undici/supabase)
// 被載入前完成 init,自動 instrumentation 才掛得上去。
import "./sentry.js";

// little-moments-api — 部署於 Railway 的背景服務(好日子 Good Days)
// 職責:
//  1. /health 健康檢查(含排程狀態摘要)
//  2. 內建排程:報價追蹤/過期、訂單提醒、點數到期沖銷、課程釋位
//     每小時一輪、單發不重複、單支失敗不影響其他支;見 scheduler.ts
//  3. /jobs/run 手動觸發排程(需 JOB_SECRET)
//  4. /jobs/status 排程健康度;排程太久沒成功會回 503(給外部監控輪詢用)
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import { getSchedulerState, runScheduledJobs, startScheduler, INTERVAL_MS } from "./scheduler.js";

const app = new Hono();

// 未被 route 處理的例外一律送 Sentry(Hono 會自己攔截 handler 內的 throw,
// 不掛這支的話錯誤只會變成 500 然後消失)。
app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  Sentry.captureException(err, {
    level: "error",
    tags: { source: "hono" },
    extra: { path: c.req.path, method: c.req.method },
  });
  return c.json({ error: "internal server error" }, 500);
});

app.get("/", (c) => c.json({ service: "little-moments-api", ok: true }));

app.get("/health", (c) => {
  const s = getSchedulerState();
  return c.json({
    ok: true,
    ts: new Date().toISOString(),
    jobs: {
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      consecutiveFailures: s.consecutiveFailures,
      totalRuns: s.totalRuns,
      staleForMinutes: s.staleFor === null ? null : Math.round(s.staleFor / 60000),
    },
  });
});

/**
 * 排程健康度。刻意跟 /health 分開:Railway 的 healthcheckPath 指向 /health,
 * 如果讓 /health 因為排程 stale 就回非 200,會變成「排程漏跑 → 容器被重啟」的
 * 錯誤連鎖。這支只給外部監控(UptimeRobot 之類)輪詢,stale 時回 503。
 */
app.get("/jobs/status", (c) => {
  const s = getSchedulerState();
  const staleThresholdMs = INTERVAL_MS * 2 + 15 * 60 * 1000;
  const stale = s.staleFor !== null && s.staleFor > staleThresholdMs;
  return c.json(
    {
      ok: !stale && s.consecutiveFailures === 0,
      stale,
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
      totalRuns: s.totalRuns,
      running: s.running,
      staleForMinutes: s.staleFor === null ? null : Math.round(s.staleFor / 60000),
      staleThresholdMinutes: Math.round(staleThresholdMs / 60000),
    },
    stale ? 503 : 200
  );
});

app.post("/jobs/run", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const secret = process.env.JOB_SECRET ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  // 走與排程相同的路徑,手動觸發也會有重試、Sentry check-in 與失敗告警。
  const result = await runScheduledJobs("manual");
  return c.json(result);
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`little-moments-api listening on :${info.port}`);
});

// 每小時跑一次追蹤排程(避免依賴外部 cron)。
// 重試、失敗告警、漏跑偵測(Sentry Cron Monitor + watchdog)都在 scheduler.ts。
startScheduler();
