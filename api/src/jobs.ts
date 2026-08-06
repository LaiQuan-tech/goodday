// 追蹤排程:全部單發、冪等(只在成功寄信後寫入時間戳)
import { createClient } from "@supabase/supabase-js";

function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "好日子 Good Days <onboarding@resend.dev>";
  if (!apiKey) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return res.ok;
}

const SITE = () => process.env.SITE_URL ?? "http://localhost:3000";

export async function runFollowupJobs() {
  const supabase = db();
  if (!supabase) return { ok: false, reason: "supabase env missing" };

  const results = {
    expiredQuotes: 0,
    quoteReminders: 0,
    orderReminders: 0,
    pointsExpired: 0,
    courseSeatsReleased: 0,
  };
  const now = new Date();

  // 1. 過期報價:已寄出但超過有效期 → expired
  const { data: expired } = await supabase
    .from("quotes")
    .update({ status: "expired" })
    .in("status", ["sent", "viewed"])
    .lt("valid_until", now.toISOString().slice(0, 10))
    .select("id");
  results.expiredQuotes = expired?.length ?? 0;

  // 2. 報價追蹤:寄出 N 天未接受且未提醒過 → 提醒一次
  const followupDays = Number(process.env.QUOTE_FOLLOWUP_DAYS ?? 3);
  const cutoff = new Date(now.getTime() - followupDays * 86400000).toISOString();
  const { data: staleQuotes } = await supabase
    .from("quotes")
    .select("id, quote_no, contact_email, contact_name, public_token, note")
    .in("status", ["sent", "viewed"])
    .lt("sent_at", cutoff)
    .not("contact_email", "eq", "")
    .is("accepted_at", null);

  for (const q of staleQuotes ?? []) {
    // note 欄位夾帶 reminded 標記,避免加欄位;已提醒過就跳過
    if (q.note?.includes("[reminded]")) continue;
    const ok = await sendEmail(
      q.contact_email,
      `【好日子】報價單 ${q.quote_no} 提醒`,
      `<p>${q.contact_name || "您好"},提醒您先前的報價單仍在有效期內:</p>
       <p><a href="${SITE()}/quote/${q.public_token}">查看報價單 ${q.quote_no}</a></p>`
    );
    if (ok) {
      await supabase
        .from("quotes")
        .update({ note: `${q.note ?? ""}[reminded]` })
        .eq("id", q.id);
      results.quoteReminders++;
    }
  }

  // 3. 未付款訂單提醒:pending 超過 N 天且未提醒過(轉帳訂單文案帶繳費期限,讀 settings.shipping.deadline_days)
  const { data: shippingSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();
  const deadlineDays =
    typeof (shippingSetting?.value as { deadline_days?: number } | undefined)?.deadline_days ===
    "number"
      ? (shippingSetting!.value as { deadline_days: number }).deadline_days
      : 3;

  const { data: staleOrders } = await supabase
    .from("orders")
    .select("id, order_no, contact_email, contact_name, public_token, note, created_at, payment_method")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .not("contact_email", "eq", "");

  for (const o of staleOrders ?? []) {
    if (o.note?.includes("[reminded]")) continue;
    const deadlineText =
      o.payment_method === "bank_transfer"
        ? (() => {
            const d = new Date(o.created_at);
            d.setDate(d.getDate() + deadlineDays);
            return `<p>請於 ${d.toLocaleDateString("zh-TW")} 前完成匯款,逾期訂單可能會被取消。</p>`;
          })()
        : "";
    const ok = await sendEmail(
      o.contact_email,
      `【好日子】訂單 ${o.order_no} 付款提醒`,
      `<p>${o.contact_name || "您好"},您的訂單尚未完成付款:</p>
       ${deadlineText}
       <p><a href="${SITE()}/orders/${o.public_token}">查看訂單 ${o.order_no}</a></p>`
    );
    if (ok) {
      await supabase
        .from("orders")
        .update({ note: `${o.note ?? ""}[reminded]` })
        .eq("id", o.id);
      results.orderReminders++;
    }
  }

  // 4. 點數到期:earn 已過期且尚未沖銷者 → 寫入對應 expire 負項(冪等:source_ref_id=原 earn id)
  //    v_expirable_earn_points 已排除先前已沖銷過的紀錄,避免每次全表掃描
  const { data: expirable } = await supabase
    .from("v_expirable_earn_points")
    .select("id, user_id, delta");

  for (const earn of expirable ?? []) {
    const { error } = await supabase.from("points_ledger").insert({
      user_id: earn.user_id,
      delta: -earn.delta,
      source: "expire",
      source_ref_id: earn.id,
      note: "點數到期",
    });
    // unique violation(23505)代表已被其他來源(如訂單取消)沖銷過,略過即可(冪等)
    if (!error) results.pointsExpired++;
  }

  // 5. 課程保留位到期回收:付費報名在建單時先佔位(reserved + expires_at),逾期未付款
  //    由 expire_course_reservations() 轉 cancelled 並把名額還回 course_details.seats_taken。
  //    名額一律經該 function 異動(內含 FOR UPDATE 列鎖),這裡不自己碰 seats_taken。
  const { data: releasedSeats } = await supabase.rpc("expire_course_reservations");
  results.courseSeatsReleased = typeof releasedSeats === "number" ? releasedSeats : 0;

  return { ok: true, ...results, ranAt: now.toISOString() };
}
