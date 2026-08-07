import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailShell, sendMail, siteUrl } from "@/lib/resend";
import { grantPointsForOrder, applyMembershipPurchase } from "@/lib/points";
import { applyCoursePurchase } from "@/lib/courses";
import type { Locale } from "@/lib/i18n/config";
import type { Order } from "@/lib/types";

/**
 * 訂單標記為已付款的共用邏輯 —— 後台「標記已付款」(admin/actions.ts)與
 * PayUni webhook 都呼叫這支,確保點數核發/會員升級/付款確認信只有一套邏輯。
 *
 * 冪等:訂單已是 paid 或更後面的狀態(processing/shipped/completed)就直接視為成功跳過,
 * 不重複核發點數。用條件式 update(.eq("status","pending"))做 CAS,防止並發下(webhook
 * 重送 + 後台手動點擊同時發生)重複執行副作用。
 */
export async function markOrderPaid(
  orderId: string
): Promise<{ ok: true; alreadyPaid?: boolean } | { ok: false; error: string }> {
  const db = createAdminClient();

  const { data: order, error: loadErr } = await db
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!order) return { ok: false, error: "找不到訂單" };

  if (["paid", "processing", "shipped", "completed"].includes(order.status)) {
    return { ok: true, alreadyPaid: true };
  }
  if (order.status === "cancelled") {
    return { ok: false, error: "訂單已取消,無法標記付款" };
  }

  const patch = { status: "paid", paid_at: new Date().toISOString() };
  const { data: updated, error: updateErr } = await db
    .from("orders")
    .update(patch)
    .eq("id", orderId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (updateErr) return { ok: false, error: updateErr.message };
  if (!updated) {
    // 條件式更新沒有命中:代表在我們讀取之後、寫入之前,已經有另一個請求(webhook 重送
    // 或後台重複點擊)搶先把它標成 paid 了 —— 視為冪等成功,不重複執行下面的副作用。
    return { ok: true, alreadyPaid: true };
  }

  const updatedOrder = { ...order, ...patch } as Order;
  await grantPointsForOrder(updatedOrder);
  await applyMembershipPurchase(updatedOrder);
  // 課程:把保留位轉確認 + 開通觀看權。applyCoursePurchase 內部整段包 try/catch 且不 rethrow,
  // 座位確認失敗(如客人拖過保留期、位子被回收)只會 console.error + notifyAdmin,
  // 訂單照樣標成 paid、點數照發、信照寄 —— fail-closed 於「開通」,不是於「收款」。
  await applyCoursePurchase(updatedOrder);

  if (order.contact_email) {
    // Phase F2:依訂單買家 locale 分支中英文(取不到就 zh,與現行行為相同)
    const orderLocale: Locale = order.locale === "en" ? "en" : "zh";
    if (orderLocale === "en") {
      await sendMail({
        to: order.contact_email,
        subject: `[Good Days] Payment Received — ${order.order_no}`,
        html: emailShell(
          "Payment Received",
          `<p>Dear ${order.contact_name},</p><p>We've confirmed your payment and will prepare your order for shipping shortly.</p>
         <p><a href="${siteUrl()}/orders/${order.public_token}">View Order ${order.order_no}</a></p>`,
          "en"
        ),
      });
    } else {
      await sendMail({
        to: order.contact_email,
        subject: `【好日子】已收到您的款項 ${order.order_no}`,
        html: emailShell(
          "已收到您的款項",
          `<p>${order.contact_name} 您好,</p><p>我們已確認收到款項,將盡快為您安排出貨。</p>
         <p><a href="${siteUrl()}/orders/${order.public_token}">查看訂單 ${order.order_no}</a></p>`
        ),
      });
    }
  }

  try {
    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderId}`);
  } catch {
    // webhook route handler context 下 revalidatePath 仍可用,但保守起見不讓它炸掉主流程
  }

  return { ok: true };
}
