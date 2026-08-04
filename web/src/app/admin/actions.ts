"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendQuoteToCustomer, computeTotals } from "@/lib/quote";
import { getQuoteConfig } from "@/lib/settings";
import { emailShell, sendMail, siteUrl } from "@/lib/resend";
import { adjustPoints, refundPointsForOrder } from "@/lib/points";
import { markOrderPaid } from "@/lib/orders";
import type { Locale } from "@/lib/i18n/config";
import type { Order, QuoteLineItem } from "@/lib/types";

// 每個 action 都先驗證 admin 身分,再用 service role 寫入
async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("未登入");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "admin") throw new Error("權限不足");
  return user;
}

// ---------- 商品 ----------
export async function upsertProduct(formData: FormData) {
  await requireAdmin();
  const db = createAdminClient();

  const id = String(formData.get("id") ?? "");
  const imagesRaw = String(formData.get("images") ?? "").trim();
  const images = imagesRaw
    ? imagesRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((url) => ({ url }))
    : [];

  // 英文欄位選填,留空一律存 null(渲染端 localizeText 靠 null 判斷「尚未翻譯,fallback 中文」)。
  const nameEnRaw = String(formData.get("name_en") ?? "").trim();
  const descriptionEnRaw = String(formData.get("description_en") ?? "").trim();

  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    slug: String(formData.get("slug") ?? "").trim().toLowerCase(),
    description: String(formData.get("description") ?? ""),
    name_en: nameEnRaw || null,
    description_en: descriptionEnRaw || null,
    price: Math.max(0, parseInt(String(formData.get("price") ?? "0"), 10) || 0),
    compare_at_price:
      parseInt(String(formData.get("compare_at_price") ?? ""), 10) || null,
    category: String(formData.get("category") ?? "").trim(),
    stock: Math.max(0, parseInt(String(formData.get("stock") ?? "0"), 10) || 0),
    status: ["draft", "active", "archived"].includes(String(formData.get("status")))
      ? String(formData.get("status"))
      : "draft",
    featured: formData.get("featured") === "on",
    images,
  };

  if (!payload.name || !payload.slug) throw new Error("名稱與網址代稱必填");

  if (id) {
    const { error } = await db.from("products").update(payload).eq("id", id);
    if (error) throw new Error(`儲存失敗:${error.message}`);
  } else {
    const { error } = await db.from("products").insert(payload);
    if (error) throw new Error(`建立失敗:${error.message}`);
  }
  revalidatePath("/admin/products");
  revalidatePath("/products");
}

export async function archiveProduct(id: string) {
  await requireAdmin();
  const db = createAdminClient();
  await db.from("products").update({ status: "archived" }).eq("id", id);
  revalidatePath("/admin/products");
  revalidatePath("/products");
}

// ---------- 課程 ----------
// <input type="datetime-local"> 送出的是沒有時區的牆上時間(2026-08-05T14:30)。
// server action 跑在 UTC,直接 new Date() 會被當成 UTC 而整整差 8 小時
// (之後 enroll_deadline < now() 之類的判斷就會全錯),故一律以台北時區解讀。
function toTimestamptz(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null; // 沒填 = null,不能塞空字串進 timestamptz
  return `${raw.length === 16 ? `${raw}:00` : raw}+08:00`;
}

// 一次寫 products(product_type='course')與 course_details 兩張表。
// ⚠️ payload 永遠不含「已報名人數」欄位:那一欄只能由 migration 內的 SQL function 異動。
export async function upsertCourse(formData: FormData) {
  await requireAdmin();
  const db = createAdminClient();

  const id = String(formData.get("id") ?? "");
  const imagesRaw = String(formData.get("images") ?? "").trim();
  const images = imagesRaw
    ? imagesRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((url) => ({ url }))
    : [];

  const courseKind = String(formData.get("course_kind")) === "recorded" ? "recorded" : "live";

  // 對齊 DB 的兩個跨欄位 CHECK:預錄課程沒有免費報名與名額的概念。
  // 在這裡先擋掉,避免使用者撞到 constraint 錯誤訊息。
  const enrollmentType =
    courseKind === "recorded"
      ? "paid"
      : String(formData.get("enrollment_type")) === "free"
        ? "free"
        : "paid";

  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  const capacityNum = parseInt(capacityRaw, 10);
  const capacity =
    courseKind === "recorded" || !capacityRaw || !Number.isFinite(capacityNum) || capacityNum <= 0
      ? null // null = 不限名額
      : capacityNum;

  // productPayload 放在 enrollmentType 之後才組:免費報名的課一律把價格歸零。
  // 否則前台會顯示金額、實際卻不收錢(免費報名不建訂單),等於掛錯價目。
  const productPayload = {
    name: String(formData.get("name") ?? "").trim(),
    slug: String(formData.get("slug") ?? "").trim().toLowerCase(),
    description: String(formData.get("description") ?? ""),
    price:
      enrollmentType === "free"
        ? 0
        : Math.max(0, parseInt(String(formData.get("price") ?? "0"), 10) || 0),
    status: ["draft", "active", "archived"].includes(String(formData.get("status")))
      ? String(formData.get("status"))
      : "draft",
    featured: formData.get("featured") === "on",
    sort_order: parseInt(String(formData.get("sort_order") ?? "0"), 10) || 0,
    images,
    product_type: "course", // 寫死,不接受表單傳入
    stock: 0,               // 課程不走庫存,名額由 course_details.capacity 控管
  };

  if (!productPayload.name || !productPayload.slug) throw new Error("名稱與網址代稱必填");

  // 付費課程沒有價格會變成 0 元訂單,結帳流程會走得很怪,直接擋在這裡
  if (enrollmentType === "paid" && productPayload.price <= 0) {
    throw new Error("付費課程的價格必須大於 0");
  }

  const detailPayload = {
    course_kind: courseKind,
    enrollment_type: enrollmentType,
    instructor: String(formData.get("instructor") ?? "").trim(),
    outline: String(formData.get("outline") ?? ""),
    location: courseKind === "recorded" ? "" : String(formData.get("location") ?? "").trim(),
    starts_at: courseKind === "recorded" ? null : toTimestamptz(formData.get("starts_at")),
    ends_at: courseKind === "recorded" ? null : toTimestamptz(formData.get("ends_at")),
    enroll_deadline: toTimestamptz(formData.get("enroll_deadline")),
    capacity,
  };

  if (id) {
    const { error } = await db.from("products").update(productPayload).eq("id", id);
    if (error) throw new Error(`儲存失敗:${error.message}`);

    // 用 update 而非 upsert:upsert 會整列覆寫,可能把已報名人數打回預設值
    const { data: updated, error: detailError } = await db
      .from("course_details")
      .update(detailPayload)
      .eq("product_id", id)
      .select("product_id");
    if (detailError) throw new Error(`儲存失敗:${detailError.message}`);
    // 舊資料沒有對應的 course_details 時補建一筆
    if (!updated || updated.length === 0) {
      const { error: insertError } = await db
        .from("course_details")
        .insert({ ...detailPayload, product_id: id });
      if (insertError) throw new Error(`儲存失敗:${insertError.message}`);
    }
  } else {
    const { data: created, error } = await db
      .from("products")
      .insert(productPayload)
      .select("id")
      .single();
    if (error || !created) throw new Error(`建立失敗:${error?.message ?? "未知錯誤"}`);

    const { error: detailError } = await db
      .from("course_details")
      .insert({ ...detailPayload, product_id: created.id });
    if (detailError) {
      // 避免留下沒有課程細節的孤兒商品(列表頁會缺資料)
      await db.from("products").delete().eq("id", created.id);
      throw new Error(`建立失敗:${detailError.message}`);
    }
  }

  revalidatePath("/admin/courses");
  revalidatePath("/products");
}

// 軟刪除:只把 products.status 設 archived,course_details 與報名紀錄都保留
export async function archiveCourse(id: string) {
  await requireAdmin();
  const db = createAdminClient();
  await db.from("products").update({ status: "archived" }).eq("id", id);
  revalidatePath("/admin/courses");
  revalidatePath("/products");
}

// ---------- 訂單 ----------
const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ["paid", "cancelled"],
  paid: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: [],
};

export async function updateOrderStatus(orderId: string, next: string) {
  await requireAdmin();
  const db = createAdminClient();

  const { data: order } = await db
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) throw new Error("找不到訂單");
  if (!ORDER_TRANSITIONS[order.status]?.includes(next)) {
    throw new Error(`不允許從 ${order.status} 變更為 ${next}`);
  }

  // →paid:委派給 markOrderPaid(與 PChomePay webhook 共用同一套「核發點數 + 會員升級 +
  // 付款確認信 + 冪等」邏輯,不在這裡重複實作)。
  if (next === "paid") {
    const result = await markOrderPaid(orderId);
    if (!result.ok) throw new Error(result.error);
    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderId}`);
    return;
  }

  const patch: Record<string, unknown> = { status: next };
  if (next === "shipped") patch.shipped_at = new Date().toISOString();

  const { error } = await db.from("orders").update(patch).eq("id", orderId);
  if (error) throw new Error(error.message);

  // 點數:→cancelled 回沖折抵/收回回饋
  const updatedOrder = { ...order, ...patch } as Order;
  if (next === "cancelled") {
    await refundPointsForOrder(updatedOrder);
  }

  // 通知客戶
  const STATUS_MAIL: Record<string, { subject: string; body: string }> = {
    shipped: {
      subject: "商品已出貨",
      body: "您的商品已出貨,請留意收件!",
    },
    completed: {
      subject: "訂單完成",
      body: "訂單已完成,感謝您的支持,期待再次為您服務!",
    },
    cancelled: {
      subject: "訂單已取消",
      body: "您的訂單已取消。若有疑問請與我們聯繫。",
    },
  };
  // Phase F2:英文版本,只給下面 orderLocale==="en" 分支用,不影響上面的 zh map
  const STATUS_MAIL_EN: Record<string, { subject: string; body: string }> = {
    shipped: {
      subject: "Order Shipped",
      body: "Your order has shipped — please look out for delivery!",
    },
    completed: {
      subject: "Order Completed",
      body: "Your order is complete. Thank you for your support — we hope to serve you again!",
    },
    cancelled: {
      subject: "Order Cancelled",
      body: "Your order has been cancelled. Please contact us if you have any questions.",
    },
  };
  // 依訂單買家 locale 分支中英文(取不到就 zh,與現行行為相同)
  const orderLocale: Locale = order.locale === "en" ? "en" : "zh";
  const mail = orderLocale === "en" ? STATUS_MAIL_EN[next] : STATUS_MAIL[next];
  if (mail && order.contact_email) {
    if (orderLocale === "en") {
      await sendMail({
        to: order.contact_email,
        subject: `[Good Days] ${mail.subject} — ${order.order_no}`,
        html: emailShell(
          `${mail.subject}`,
          `<p>Dear ${order.contact_name},</p><p>${mail.body}</p>
         <p><a href="${siteUrl()}/orders/${order.public_token}">View Order ${order.order_no}</a></p>`,
          "en"
        ),
      });
    } else {
      await sendMail({
        to: order.contact_email,
        subject: `【好日子】${mail.subject} ${order.order_no}`,
        html: emailShell(
          `${mail.subject}`,
          `<p>${order.contact_name} 您好,</p><p>${mail.body}</p>
         <p><a href="${siteUrl()}/orders/${order.public_token}">查看訂單 ${order.order_no}</a></p>`
        ),
      });
    }
  }

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
}

// ---------- 報價 ----------
export async function saveQuote(formData: FormData) {
  await requireAdmin();
  const db = createAdminClient();
  const config = await getQuoteConfig();

  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("缺少報價單 ID");

  let lineItems: QuoteLineItem[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("line_items") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error();
    lineItems = parsed
      .filter((i) => i && i.name)
      .map((i) => ({
        name: String(i.name).slice(0, 200),
        unit_price: Math.max(0, parseInt(String(i.unit_price), 10) || 0),
        quantity: Math.max(1, parseInt(String(i.quantity), 10) || 1),
        note: String(i.note ?? "").slice(0, 300),
      }));
  } catch {
    throw new Error("品項格式錯誤");
  }

  const taxEnabled = formData.get("tax_enabled") === "on";
  const totals = computeTotals(lineItems, taxEnabled ? config.tax_rate : 0);

  const { error } = await db
    .from("quotes")
    .update({
      contact_name: String(formData.get("contact_name") ?? "").slice(0, 100),
      contact_email: String(formData.get("contact_email") ?? "").slice(0, 200),
      contact_phone: String(formData.get("contact_phone") ?? "").slice(0, 50),
      note: String(formData.get("note") ?? "").slice(0, 2000),
      line_items: lineItems,
      ...totals,
    })
    .eq("id", id)
    .in("status", ["draft", "sent", "viewed"]);
  if (error) throw new Error(error.message);

  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath("/admin/quotes");
}

export async function approveAndSendQuote(quoteId: string) {
  await requireAdmin();
  const result = await sendQuoteToCustomer(quoteId);
  if (!result.ok) throw new Error(result.error ?? "寄送失敗");
  revalidatePath(`/admin/quotes/${quoteId}`);
  revalidatePath("/admin/quotes");
}

export async function deleteQuote(quoteId: string) {
  await requireAdmin();
  const db = createAdminClient();
  await db.from("quotes").delete().eq("id", quoteId).eq("status", "draft");
  revalidatePath("/admin/quotes");
}

// ---------- 會員 ----------
export async function setMemberRole(userId: string, role: "customer" | "admin") {
  const me = await requireAdmin();
  if (me.id === userId && role !== "admin") {
    throw new Error("不能移除自己的管理員權限");
  }
  const db = createAdminClient();
  await db.from("profiles").update({ role }).eq("id", userId);
  revalidatePath("/admin/members");
}

// 手動調整會員點數(正數加點、負數扣點)
export async function adjustMemberPoints(userId: string, delta: number, note: string) {
  const me = await requireAdmin();
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("調整點數須為非零整數");
  }
  await adjustPoints(userId, delta, note, me.email ?? me.id);
  revalidatePath("/admin/members");
}

// ---------- 預約參訪 ----------
const BOOKING_TRANSITIONS: Record<string, string[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export async function updateBookingStatus(bookingId: string, next: string) {
  await requireAdmin();
  const db = createAdminClient();

  const { data: booking } = await db
    .from("bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) throw new Error("找不到預約");
  if (!BOOKING_TRANSITIONS[booking.status]?.includes(next)) {
    throw new Error(`不允許從 ${booking.status} 變更為 ${next}`);
  }

  const { error } = await db.from("bookings").update({ status: next }).eq("id", bookingId);
  if (error) throw new Error(error.message);

  if (next === "confirmed" && booking.email) {
    await sendMail({
      to: booking.email,
      subject: `【好日子】您的預約已確認`,
      html: emailShell(
        "預約已確認",
        `<p>${booking.name} 您好,您預約的參訪已確認${booking.visit_date ? `,日期為 ${booking.visit_date}` : ""}。</p>
         <p>期待與您在好日子書店相會,若時間需調整歡迎直接回覆此信或致電門市。</p>`
      ),
    });
  }

  revalidatePath("/admin/bookings");
}

// ---------- 設定 ----------
export async function saveSetting(key: string, jsonValue: string) {
  await requireAdmin();
  if (!["company_profile", "rate_card", "quote_config", "shipping"].includes(key)) {
    throw new Error("不允許的設定鍵");
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonValue);
  } catch {
    throw new Error("JSON 格式錯誤");
  }
  const db = createAdminClient();
  const { error } = await db
    .from("settings")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/settings");
}
