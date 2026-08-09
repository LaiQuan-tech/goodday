// 排程器 — 取代原本 index.ts 裡的裸 setInterval。
//
// 原本的寫法是:
//   setInterval(() => { runFollowupJobs().catch(err => console.error(...)) }, HOUR)
// 問題有三個:
//   1. 失敗只進 stdout,沒有人會看到(Railway log 沒人盯)。
//   2. 沒有重試,一次暫時性的網路抖動就整整一小時不處理。
//   3. 「這一輪根本沒跑」跟「跑了但沒事做」在外部看起來一模一樣 —— 點數到期
//      這種會計性質的 job 漏跑會直接變成客訴/帳務問題。
//
// 這裡用三層來讓「漏跑」變成可偵測的事件:
//   (a) Sentry Cron Monitor check-in(in_progress → ok/error)。這是唯一一個
//       「程序整個死掉」時還能發現的機制 —— 判斷發生在 Sentry 伺服器端,
//       約定時間內沒收到 check-in 就是 missed check-in 並開 issue。
//   (b) 行程內 watchdog:距離上次「成功」超過門檻就送 error 事件 + LINE 告警。
//       抓的是「程序還活著,但每輪都失敗/卡住」。
//   (c) /health 與 /jobs/status 把 lastSuccessAt、consecutiveFailures 曝出來,
//       給外部監控(或人工)直接查。
import * as Sentry from "@sentry/node";
import { runFollowupJobs, type FollowupJobsResult } from "./jobs.js";
import { sendAlert } from "./lib/line-notify.js";

const HOUR_MS = 60 * 60 * 1000;

/** 排程間隔(每小時一次,與舊行為相同)。 */
export const INTERVAL_MS = HOUR_MS;
/** Sentry Cron Monitor 的 slug;第一次 check-in 時自動建立 monitor。 */
const MONITOR_SLUG = "goodday-followup-jobs";
/** 單輪內的重試次數(含第一次)。job 全部冪等,重試安全。 */
const MAX_ATTEMPTS = 3;
/** 重試退避基數:30s → 60s。 */
const RETRY_BASE_MS = 30_000;
/** 啟動後多久跑第一輪(讓服務先起來、環境變數就緒)。 */
const FIRST_RUN_DELAY_MS = 30_000;
/** watchdog 檢查頻率。 */
const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;
/** 超過這個時間沒有任何一輪成功 → 視為漏跑並告警(兩輪 + 15 分鐘寬限)。 */
const STALE_AFTER_MS = INTERVAL_MS * 2 + 15 * 60 * 1000;

export type SchedulerState = {
  startedAt: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastResult: FollowupJobsResult | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalRuns: number;
  running: boolean;
  staleAlerted: boolean;
};

const state: SchedulerState = {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastError: null,
  consecutiveFailures: 0,
  totalRuns: 0,
  running: false,
  staleAlerted: false,
};

export function getSchedulerState(): SchedulerState & { staleFor: number | null } {
  const ref = state.lastSuccessAt ?? state.startedAt;
  return { ...state, staleFor: Date.now() - new Date(ref).getTime() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一輪排程。永遠不 throw —— 呼叫端(setInterval / HTTP route)不需要再包一層,
 * 而且任何一輪炸掉都不能讓排程器本身停擺。
 */
export async function runScheduledJobs(
  trigger: "interval" | "startup" | "manual"
): Promise<FollowupJobsResult | { ok: false; reason: string }> {
  if (state.running) {
    // 上一輪還沒跑完(例如信件很多)。跳過這輪而不是疊上去,避免重複寄信。
    console.warn(`[scheduler] previous run still in progress, skipping (${trigger})`);
    Sentry.captureMessage("排程上一輪尚未結束,跳過本輪", {
      level: "warning",
      tags: { job: "followup", trigger },
    });
    return { ok: false, reason: "previous run still in progress" };
  }

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  state.totalRuns++;

  // (a) Sentry Cron Monitor:開一個 in_progress check-in,收尾時結成 ok / error。
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: "in_progress" },
    {
      schedule: { type: "interval", value: 1, unit: "hour" },
      checkinMargin: 15, // 分鐘;超過就算 missed check-in
      maxRuntime: 10, // 分鐘;卡住超過這麼久算失敗
      timezone: process.env.TZ ?? "Asia/Taipei",
      failureIssueThreshold: 1, // 牽涉點數/帳務,失敗一次就開 issue
      recoveryThreshold: 1,
    }
  );

  const startedAt = Date.now();
  let lastFailure = "";
  let attempts = 0;
  let result: FollowupJobsResult | null = null;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      result = await runFollowupJobs();

      if (result.ok) {
        if (attempt > 1) {
          console.warn(`[scheduler] recovered on attempt ${attempt}`);
        }
        break;
      }

      lastFailure = result.reason ?? `失敗的 step: ${result.failedSteps.join(", ")}`;
      // supabase env 缺失重試也沒用,直接放棄這輪
      if (result.reason === "supabase env missing") break;

      if (attempt < MAX_ATTEMPTS) {
        const backoff = RETRY_BASE_MS * attempt;
        console.warn(
          `[scheduler] attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastFailure}), retrying in ${backoff}ms`
        );
        await sleep(backoff);
      }
    }

    const durationSec = Math.round((Date.now() - startedAt) / 1000);

    if (result?.ok) {
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.staleAlerted = false;
      state.lastResult = result;
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: MONITOR_SLUG,
        status: "ok",
        duration: durationSec,
      });
      console.log(
        `[scheduler] ok (${trigger}) — ` +
          `報價過期 ${result.expiredQuotes}、報價提醒 ${result.quoteReminders}、` +
          `訂單提醒 ${result.orderReminders}、點數到期 ${result.pointsExpired}、` +
          `課程釋位 ${result.courseSeatsReleased}`
      );
      return result;
    }

    // 全部嘗試都失敗
    state.lastError = lastFailure || "unknown";
    state.consecutiveFailures++;
    state.lastResult = result;
    Sentry.captureCheckIn({
      checkInId,
      monitorSlug: MONITOR_SLUG,
      status: "error",
      duration: durationSec,
    });
    // 個別 step 的例外已由 jobs.ts 送過 Sentry(帶 step tag);這裡再送一則
    // 彙總事件,讓「整輪失敗」本身也是一個可以設警報的 issue。
    Sentry.captureMessage(`排程整輪失敗(連續 ${state.consecutiveFailures} 次):${lastFailure}`, {
      level: "error",
      tags: { job: "followup", trigger },
      extra: { steps: result?.steps, consecutiveFailures: state.consecutiveFailures },
    });
    await sendAlert(
      "goodday 排程失敗",
      `${attempts} 次嘗試都失敗(連續第 ${state.consecutiveFailures} 輪)\n${lastFailure}`
    );
    return result ?? { ok: false, reason: lastFailure };
  } catch (err) {
    // 理論上到不了這裡(jobs.ts 每個 step 都自帶 try/catch),但排程器絕對不能死。
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    state.consecutiveFailures++;
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: "error" });
    Sentry.captureException(err, { level: "fatal", tags: { job: "followup", trigger } });
    await sendAlert("goodday 排程器未預期例外", message);
    return { ok: false, reason: message };
  } finally {
    state.running = false;
  }
}

/**
 * (b) watchdog:程序活著但一直沒有成功跑完時,主動把它變成一個 Sentry error
 * 事件 + LINE 告警。只在進入 stale 狀態時告警一次,恢復成功後重置。
 */
function checkStaleness(): void {
  const { staleFor } = getSchedulerState();
  if (staleFor === null || staleFor <= STALE_AFTER_MS) return;
  if (state.staleAlerted) return;

  state.staleAlerted = true;
  const minutes = Math.round(staleFor / 60000);
  const detail =
    `距離上次成功已 ${minutes} 分鐘(門檻 ${Math.round(STALE_AFTER_MS / 60000)} 分鐘)。\n` +
    `最後錯誤:${state.lastError ?? "(無 — 這輪可能根本沒被觸發)"}\n` +
    `已跑輪數:${state.totalRuns}、連續失敗:${state.consecutiveFailures}`;
  console.error(`[scheduler] STALE — ${detail}`);
  Sentry.captureMessage(`排程超過 ${minutes} 分鐘沒有成功跑完(疑似漏跑)`, {
    level: "error",
    tags: { job: "followup", reason: "stale" },
    extra: getSchedulerState(),
  });
  void sendAlert("goodday 排程疑似漏跑", detail);
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let watchdogHandle: ReturnType<typeof setInterval> | null = null;

/** 啟動排程器。重複呼叫是安全的(不會疊出第二組 timer)。 */
export function startScheduler(): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    void runScheduledJobs("interval");
  }, INTERVAL_MS);
  intervalHandle.unref?.();

  watchdogHandle = setInterval(() => {
    try {
      checkStaleness();
    } catch (err) {
      console.error("[scheduler] watchdog error:", err);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdogHandle.unref?.();

  // 啟動後先跑一輪:部署/重啟後不必等滿一小時,而且重啟迴圈也會留下 check-in。
  setTimeout(() => {
    void runScheduledJobs("startup");
  }, FIRST_RUN_DELAY_MS).unref?.();

  console.log(
    `[scheduler] started — 每 ${INTERVAL_MS / 60000} 分鐘一輪,` +
      `watchdog 每 ${WATCHDOG_INTERVAL_MS / 60000} 分鐘檢查,` +
      `stale 門檻 ${STALE_AFTER_MS / 60000} 分鐘`
  );
}
