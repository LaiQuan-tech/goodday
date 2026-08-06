// 付費課程與金流的接點(階段 3)。
//
// ⚠️ 本檔絕不自己 insert/update course_enrollments,也絕不自己動 course_details.seats_taken。
// 名額一律經 migration 20260723000001_courses.sql 內的四支 SQL function 異動,那幾支
// 對 course_details 該列下 FOR UPDATE 列鎖把併發序列化,不可能超賣;繞過它們寫入
// 會讓計數失準。本檔只負責:呼叫 RPC、依結果決定觀看權(course_access)、回報錯誤。
//
// 這不是 "use server" 檔案 —— 只是內部 helper,由 route handler / server action 呼叫。
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyAdmin, emailShell, siteUrl } from "@/lib/resend";
import { getShippingConfig } from "@/lib/settings";
import type { Order } from "@/lib/types";

// 建單時要佔位的課程品項(來源:orders/route.ts 已解析好的 lineItems)
export type CourseLine = {
  product_id: string;
  name: string;
};

export type ReserveSeatsResult =
  | { ok: true; reserved: number }
  | { ok: false; error: string; productId: string; productName: string; reason: string };

type ReserveOrder = Pick<
  Order,
  "id" | "user_id" | "contact_name" | "contact_email" | "contact_phone"
>;

// 保留期沿用既有的「銀行轉帳繳費期限」設定(settings.shipping.deadline_days,預設 3 天)——
// 刻意不新增設定鍵:客人付款的期限與座位保留的期限本來就該是同一個數字,
// 分兩個鍵只會讓兩者失同步(繳費期限 5 天但座位 3 天就過期 → 客人準時匯款卻沒位子)。
async function reservationExpiresAt(): Promise<string> {
  const { deadline_days } = await getShippingConfig();
  const days = Number.isFinite(deadline_days) && deadline_days > 0 ? deadline_days : 3;
  return new Date(Date.now() + days * 86400000).toISOString();
}

/**
 * 建單時對每個課程品項佔位(reserved,未確認)。全有或全無:任何一堂失敗就把這張訂單
 * 已經搶到的位子全部釋放後回報失敗,不留孤兒保留。
 *
 * ⚠️ 呼叫時機:必須在「建立 order_items 之後、扣點數與扣庫存之前」。扣點數會寫進
 * points_ledger,若先扣點再發現額滿就得回滾點數帳本;排在前面則失敗路徑完全不碰點數。
 */
export async function reserveSeatsForOrder(
  order: ReserveOrder,
  courseLines: CourseLine[]
): Promise<ReserveSeatsResult> {
  if (courseLines.length === 0) return { ok: true, reserved: 0 };

  // 課程觀看權綁 user_id,訪客無從歸戶 —— 呼叫端(orders/route.ts)已擋一次,這裡再擋一次。
  if (!order.user_id) {
    return {
      ok: false,
      error: "購買課程請先登入會員",
      productId: courseLines[0].product_id,
      productName: courseLines[0].name,
      reason: "no_user",
    };
  }

  const db = createAdminClient();
  const expiresAt = await reservationExpiresAt();
  let reserved = 0;

  for (const line of courseLines) {
    let result: string | null = null;
    let rpcError: string | null = null;

    const { data, error } = await db.rpc("reserve_course_seat", {
      p_product_id: line.product_id,
      p_user_id: order.user_id,
      p_order_id: order.id,
      p_confirmed: false,
      p_expires_at: expiresAt,
      p_name: order.contact_name ?? "",
      p_email: order.contact_email ?? "",
      p_phone: order.contact_phone ?? "",
    });
    if (error) {
      console.error("[courses] reserve_course_seat failed:", error);
      rpcError = error.message;
    } else {
      result = typeof data === "string" ? data : null;
    }

    if (result === "ok") {
      reserved++;
      continue;
    }

    // 失敗:先把這張訂單已搶到的位子全部退掉,再回報(全有或全無)
    if (reserved > 0) {
      const { error: releaseError } = await db.rpc("release_course_seats_for_order", {
        p_order_id: order.id,
      });
      if (releaseError) {
        console.error("[courses] rollback release_course_seats_for_order failed:", releaseError);
      }
    }

    const reason = rpcError ? "rpc_error" : result ?? "unknown";
    return {
      ok: false,
      error: reserveErrorMessage(line.name, reason),
      productId: line.product_id,
      productName: line.name,
      reason,
    };
  }

  return { ok: true, reserved };
}

function reserveErrorMessage(productName: string, reason: string): string {
  switch (reason) {
    case "full":
      return `「${productName}」名額已滿,請移除後再結帳`;
    case "already_enrolled":
      return `你已經報名過「${productName}」了,請移除後再結帳`;
    case "not_course":
      return `「${productName}」尚未完成課程設定,暫時無法報名`;
    default:
      return `「${productName}」報名失敗,請稍後再試`;
  }
}

// 取這張訂單的課程品項(與 lib/points.ts 的 applyMembershipPurchase 用 'membership' 同構)
async function courseProductIdsForOrder(
  db: ReturnType<typeof createAdminClient>,
  orderId: string
): Promise<string[]> {
  const { data, error } = await db
    .from("order_items")
    .select("product_id")
    .eq("order_id", orderId)
    .eq("purchase_mode", "course")
    .not("product_id", "is", null);
  if (error) {
    console.error("[courses] load course order_items failed:", error);
    return [];
  }
  return [...new Set((data ?? []).map((i) => i.product_id as string))];
}

/**
 * 付款成功後呼叫(markOrderPaid 內):把保留位轉為確認,並開通觀看權。
 *
 * ⚠️ 這支永遠不會 throw —— 整段包在 try/catch 內且不 rethrow。收款流程(標記 paid、
 * 核發點數、寄信)絕不能因為課程開通失敗而中斷:客人的錢已經進來了。
 * fail-closed 是針對「開通」——確認不到座位就不發觀看權、寄信通知後台人工處理;
 * 不是針對「收款」。
 */
export async function applyCoursePurchase(order: Order): Promise<void> {
  try {
    if (!order.user_id) return;
    const db = createAdminClient();

    const productIds = await courseProductIdsForOrder(db, order.id);
    if (productIds.length === 0) return;

    const { data: rpcResult, error: rpcError } = await db.rpc("confirm_course_seats_for_order", {
      p_order_id: order.id,
    });
    if (rpcError) {
      console.error("[courses] confirm_course_seats_for_order failed:", rpcError);
      await notifyCourseIssue(order, `座位確認失敗(${rpcError.message})`);
    } else if (rpcResult !== "ok") {
      // 'full' = 客人拖到保留期過後才匯款,位子已被排程回收且搶不回來;'duplicate' = 撞唯一索引。
      console.error("[courses] confirm_course_seats_for_order returned:", rpcResult);
      await notifyCourseIssue(order, `座位確認結果為「${String(rpcResult)}」`);
    }

    // 觀看權只發給「真的確認到座位」的課(fail-closed 於開通):RPC 回 'full' 時
    // 有位子的那幾堂仍照發,搶不到的那堂不發,交由上面的 notifyAdmin 人工處理。
    const { data: confirmed, error: confirmedError } = await db
      .from("course_enrollments")
      .select("product_id")
      .eq("order_id", order.id)
      .eq("status", "confirmed");
    if (confirmedError) {
      console.error("[courses] load confirmed enrollments failed:", confirmedError);
      return;
    }

    const grantIds = [...new Set((confirmed ?? []).map((e) => e.product_id as string))].filter(
      (id) => productIds.includes(id)
    );
    if (grantIds.length === 0) return;

    const nowIso = new Date().toISOString();
    const { error: accessError } = await db.from("course_access").upsert(
      grantIds.map((productId) => ({
        user_id: order.user_id as string,
        product_id: productId,
        source: "purchase" as const,
        source_ref_id: order.id,
        revoked_at: null,
        granted_at: nowIso,
      })),
      { onConflict: "user_id,product_id" }
    );
    if (accessError) {
      console.error("[courses] course_access upsert failed:", accessError);
      await notifyCourseIssue(order, `觀看權開通失敗(${accessError.message})`);
    }
  } catch (err) {
    // 任何例外都吞掉:markOrderPaid 不能因此炸掉(收款流程優先)
    console.error("[courses] applyCoursePurchase failed:", err);
  }
}

async function notifyCourseIssue(order: Order, detail: string) {
  try {
    await notifyAdmin(
      `課程額滿待人工處理 ${order.order_no}`,
      emailShell(
        "課程座位需要人工處理",
        `<p>訂單 <strong>${order.order_no}</strong> 已完成付款,但課程座位無法自動確認。</p>
         <p>原因:${detail}</p>
         <p>客人:${order.contact_name} / ${order.contact_email} / ${order.contact_phone}</p>
         <p>請人工確認是否加開名額或安排退款。</p>
         <p><a href="${siteUrl()}/admin/orders/${order.id}">前往後台處理</a></p>`
      )
    );
  } catch (err) {
    console.error("[courses] notifyAdmin failed:", err);
  }
}

/**
 * 訂單取消時呼叫:退座位 + 收回觀看權。
 * 與 refundPointsForOrder 並列於後台改狀態的 cancelled 分支。
 */
export async function revokeCourseAccessForOrder(order: Order): Promise<void> {
  try {
    const db = createAdminClient();

    const { error: releaseError } = await db.rpc("release_course_seats_for_order", {
      p_order_id: order.id,
    });
    if (releaseError) {
      console.error("[courses] release_course_seats_for_order failed:", releaseError);
    }

    const { error: revokeError } = await db
      .from("course_access")
      .update({ revoked_at: new Date().toISOString() })
      .eq("source", "purchase")
      .eq("source_ref_id", order.id)
      .is("revoked_at", null);
    if (revokeError) {
      console.error("[courses] course_access revoke failed:", revokeError);
    }
  } catch (err) {
    // 訂單狀態此時已改為 cancelled、點數也已回沖,不讓這裡的例外把後台操作整個炸掉
    console.error("[courses] revokeCourseAccessForOrder failed:", err);
  }
}

// 觀看權查詢:course_access 存在且未撤銷才算有權限
export async function hasCourseAccess(userId: string, productId: string): Promise<boolean> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("course_access")
      .select("id")
      .eq("user_id", userId)
      .eq("product_id", productId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) {
      console.error("[courses] hasCourseAccess query failed:", error);
      return false;
    }
    return Boolean(data);
  } catch (err) {
    console.error("[courses] hasCourseAccess failed:", err);
    return false;
  }
}
