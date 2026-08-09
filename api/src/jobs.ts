// 追蹤排程:全部單發、冪等(只在成功寄信後寫入時間戳)
//
// 每個 step 各自 try/catch:一支炸掉不會讓後面幾支不跑。失敗會 (1) console.error
// (2) 送 Sentry(帶 step tag)(3) 由 scheduler.ts 決定重試與告警。
// 特別注意「4. 點數到期」這支:漏跑是會計問題,所以底下所有 Supabase 呼叫都不再
// 靜默丟掉 error —— 舊版把 error 解構掉不看,查詢失敗會長得跟「沒資料要處理」一樣。
import { createClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** 直接沿用 db() 推導出來的 client 型別,避免 createClient 預設泛型對不上。 */
type Supabase = NonNullable<ReturnType<typeof db>>;

/** Supabase 回傳的 error 一律轉成 throw,避免查詢失敗被當成「沒資料」。 */
function assertNoError(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

type SendResult =
  | { status: "sent" }
  | { status: "skipped" } // 沒設定 RESEND_API_KEY,不是錯誤
  | { status: "failed"; reason: string };

async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "好日子 Good Days <onboarding@resend.dev>";
  if (!apiKey) return { status: "skipped" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { status: "sent" };
    return { status: "failed", reason: `Resend HTTP ${res.status}` };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

const SITE = () => process.env.SITE_URL ?? "http://localhost:3000";

export type JobStepResult = {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
};

export type FollowupJobsResult = {
  ok: boolean;
  reason?: string;
  ranAt: string;
  durationMs: number;
  steps: JobStepResult[];
  failedSteps: string[];
  // 以下維持舊版欄位名,/jobs/run 既有呼叫端不會壞
  expiredQuotes: number;
  quoteReminders: number;
  orderReminders: number;
  pointsExpired: number;
  courseSeatsReleased: number;
};

/** 跑單一 step 並把例外關在裡面。回傳成功筆數,或帶 error 的失敗結果。 */
async function runStep(name: string, fn: () => Promise<number>): Promise<JobStepResult> {
  try {
    const count = await fn();
    return { name, ok: true, count };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] step "${name}" failed:`, err);
    Sentry.captureException(err, {
      level: "error",
      // alert:"skip" —— 這則不單獨寄信;scheduler 會在整輪結束後寄一封
      // 列出所有失敗 step 的彙總告警信,避免 5 支 step 噴 5 封。
      tags: { job: "followup", step: name, alert: "skip" },
    });
    return { name, ok: false, count: 0, error: message };
  }
}

// ── 1. 過期報價:已寄出但超過有效期 → expired ─────────────────────────────
async function expireQuotes(supabase: Supabase, now: Date): Promise<number> {
  const { data, error } = await supabase
    .from("quotes")
    .update({ status: "expired" })
    .in("status", ["sent", "viewed"])
    .lt("valid_until", now.toISOString().slice(0, 10))
    .select("id");
  assertNoError(error, "更新過期報價");
  return data?.length ?? 0;
}

// ── 2. 報價追蹤:寄出 N 天未接受且未提醒過 → 提醒一次 ─────────────────────
async function remindStaleQuotes(supabase: Supabase, cutoff: string): Promise<number> {
  const { data: staleQuotes, error } = await supabase
    .from("quotes")
    .select("id, quote_no, contact_email, contact_name, public_token, note")
    .in("status", ["sent", "viewed"])
    .lt("sent_at", cutoff)
    .not("contact_email", "eq", "")
    .is("accepted_at", null);
  assertNoError(error, "查詢待追蹤報價");

  let sent = 0;
  const failures: string[] = [];
  for (const q of (staleQuotes ?? []) as Array<Record<string, string | null>>) {
    // note 欄位夾帶 reminded 標記,避免加欄位;已提醒過就跳過
    if (q.note?.includes("[reminded]")) continue;
    const result = await sendEmail(
      q.contact_email ?? "",
      `【好日子】報價單 ${q.quote_no} 提醒`,
      `<p>${q.contact_name || "您好"},提醒您先前的報價單仍在有效期內:</p>
       <p><a href="${SITE()}/quote/${q.public_token}">查看報價單 ${q.quote_no}</a></p>`
    );
    if (result.status === "skipped") break; // 沒設定 Resend,整批都不用試了
    if (result.status === "failed") {
      failures.push(`${q.quote_no}: ${result.reason}`);
      continue;
    }
    const { error: markErr } = await supabase
      .from("quotes")
      .update({ note: `${q.note ?? ""}[reminded]` })
      .eq("id", q.id!);
    assertNoError(markErr, `標記報價 ${q.quote_no} 已提醒`);
    sent++;
  }
  if (failures.length) {
    throw new Error(`${failures.length} 封報價提醒信寄送失敗 — ${failures.slice(0, 3).join("; ")}`);
  }
  return sent;
}

// ── 3. 未付款訂單提醒:pending 超過 N 天且未提醒過 ─────────────────────────
//     轉帳訂單文案帶繳費期限,讀 settings.shipping.deadline_days
async function remindUnpaidOrders(supabase: Supabase, cutoff: string): Promise<number> {
  const { data: shippingSetting, error: settingErr } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();
  assertNoError(settingErr, "讀取 settings.shipping");
  const deadlineDays =
    typeof (shippingSetting?.value as { deadline_days?: number } | undefined)?.deadline_days ===
    "number"
      ? (shippingSetting!.value as { deadline_days: number }).deadline_days
      : 3;

  const { data: staleOrders, error } = await supabase
    .from("orders")
    .select(
      "id, order_no, contact_email, contact_name, public_token, note, created_at, payment_method"
    )
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .not("contact_email", "eq", "");
  assertNoError(error, "查詢未付款訂單");

  let sent = 0;
  const failures: string[] = [];
  for (const o of (staleOrders ?? []) as Array<Record<string, string | null>>) {
    if (o.note?.includes("[reminded]")) continue;
    const deadlineText =
      o.payment_method === "bank_transfer"
        ? (() => {
            const d = new Date(o.created_at!);
            d.setDate(d.getDate() + deadlineDays);
            return `<p>請於 ${d.toLocaleDateString("zh-TW")} 前完成匯款,逾期訂單可能會被取消。</p>`;
          })()
        : "";
    const result = await sendEmail(
      o.contact_email ?? "",
      `【好日子】訂單 ${o.order_no} 付款提醒`,
      `<p>${o.contact_name || "您好"},您的訂單尚未完成付款:</p>
       ${deadlineText}
       <p><a href="${SITE()}/orders/${o.public_token}">查看訂單 ${o.order_no}</a></p>`
    );
    if (result.status === "skipped") break;
    if (result.status === "failed") {
      failures.push(`${o.order_no}: ${result.reason}`);
      continue;
    }
    const { error: markErr } = await supabase
      .from("orders")
      .update({ note: `${o.note ?? ""}[reminded]` })
      .eq("id", o.id!);
    assertNoError(markErr, `標記訂單 ${o.order_no} 已提醒`);
    sent++;
  }
  if (failures.length) {
    throw new Error(`${failures.length} 封訂單提醒信寄送失敗 — ${failures.slice(0, 3).join("; ")}`);
  }
  return sent;
}

// ── 4. 點數到期(會計相關,漏跑要有人知道)────────────────────────────────
//     earn 已過期且尚未沖銷者 → 寫入對應 expire 負項(冪等:source_ref_id=原 earn id)
//     v_expirable_earn_points 已排除先前已沖銷過的紀錄,避免每次全表掃描
async function expirePoints(supabase: Supabase): Promise<number> {
  const { data: expirable, error } = await supabase
    .from("v_expirable_earn_points")
    .select("id, user_id, delta");
  assertNoError(error, "查詢待到期點數");

  let expired = 0;
  const failures: string[] = [];
  for (const earn of (expirable ?? []) as Array<{ id: string; user_id: string; delta: number }>) {
    const { error: insertErr } = await supabase.from("points_ledger").insert({
      user_id: earn.user_id,
      delta: -earn.delta,
      source: "expire",
      source_ref_id: earn.id,
      note: "點數到期",
    });
    if (!insertErr) {
      expired++;
      continue;
    }
    // unique violation(23505)代表已被其他來源(如訂單取消)沖銷過,略過即可(冪等)
    if ((insertErr as { code?: string }).code === "23505") continue;
    // 其他錯誤要浮上來 —— 但先把剩下的跑完,不要因為一筆壞掉就少沖銷一批
    failures.push(`earn ${earn.id}: ${insertErr.message}`);
  }
  if (failures.length) {
    throw new Error(
      `${failures.length} 筆點數到期沖銷失敗(會計影響)— ${failures.slice(0, 3).join("; ")}`
    );
  }
  return expired;
}

// ── 5. 課程保留位到期回收 ─────────────────────────────────────────────────
//     付費報名在建單時先佔位(reserved + expires_at),逾期未付款由
//     expire_course_reservations() 轉 cancelled 並把名額還回 course_details.seats_taken。
//     名額一律經該 function 異動(內含 FOR UPDATE 列鎖),這裡不自己碰 seats_taken。
async function releaseCourseSeats(supabase: Supabase): Promise<number> {
  const { data, error } = await supabase.rpc("expire_course_reservations");
  assertNoError(error, "執行 expire_course_reservations()");
  return typeof data === "number" ? data : 0;
}

export async function runFollowupJobs(): Promise<FollowupJobsResult> {
  const startedAt = Date.now();
  const now = new Date();
  const empty = {
    ranAt: now.toISOString(),
    durationMs: 0,
    steps: [] as JobStepResult[],
    failedSteps: [] as string[],
    expiredQuotes: 0,
    quoteReminders: 0,
    orderReminders: 0,
    pointsExpired: 0,
    courseSeatsReleased: 0,
  };

  const supabase = db();
  if (!supabase) return { ok: false, reason: "supabase env missing", ...empty };

  const followupDays = Number(process.env.QUOTE_FOLLOWUP_DAYS ?? 3);
  const cutoff = new Date(now.getTime() - followupDays * 86400000).toISOString();

  // 依序執行;每支自帶 try/catch,前面失敗不影響後面。
  const steps: JobStepResult[] = [
    await runStep("expireQuotes", () => expireQuotes(supabase, now)),
    await runStep("quoteReminders", () => remindStaleQuotes(supabase, cutoff)),
    await runStep("orderReminders", () => remindUnpaidOrders(supabase, cutoff)),
    await runStep("pointsExpired", () => expirePoints(supabase)),
    await runStep("courseSeatsReleased", () => releaseCourseSeats(supabase)),
  ];

  const byName = (n: string) => steps.find((s) => s.name === n)?.count ?? 0;
  const failedSteps = steps.filter((s) => !s.ok).map((s) => s.name);

  return {
    ok: failedSteps.length === 0,
    ranAt: now.toISOString(),
    durationMs: Date.now() - startedAt,
    steps,
    failedSteps,
    expiredQuotes: byName("expireQuotes"),
    quoteReminders: byName("quoteReminders"),
    orderReminders: byName("orderReminders"),
    pointsExpired: byName("pointsExpired"),
    courseSeatsReleased: byName("courseSeatsReleased"),
  };
}
