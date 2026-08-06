"use server";

// 課程免費報名的 Server Action。
//
// ⚠️ 名額(course_details.seats_taken)只能由 migration 內的 reserve_course_seat()
// 異動:那支 function 對 course_details 該列下 FOR UPDATE 列鎖,把同一堂課的併發
// 報名序列化,不可能超賣。本檔絕不自己 insert course_enrollments、也絕不自己
// update seats_taken —— 那會讓計數失準且會超賣。
//
// 注意:"use server" 檔案只能 export async function(純常數/非 async 匯出會讓 action
// 在部署環境 500),型別匯出則因編譯期即被抹除而安全(同 lib/bookings.ts 慣例)。
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { tryCreateAdminClient } from "@/lib/supabase/admin";
import { getMessages } from "@/lib/i18n/server";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";

export type EnrollResult = { ok: true } | { ok: false; error: string };

// locale 預設 DEFAULT_LOCALE("zh"):維持 enrollFreeCourse(productId) 的單參數呼叫可用,
// 同時讓英文站拿到英文錯誤訊息(與 lib/bookings.ts 的 createBooking 完全同形)。
export async function enrollFreeCourse(
  productId: string,
  locale: Locale = DEFAULT_LOCALE
): Promise<EnrollResult> {
  const t = getMessages(locale).courses.errors;

  // createClient() 只用來確認登入身分;所有資料查詢一律走 service role。
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: t.notLoggedIn };

  const db = tryCreateAdminClient();
  if (!db) return { ok: false, error: t.notReady };

  // 報名資格一律由伺服器重查 DB 認定,不信任 client 傳來的任何狀態。
  const { data: product } = await db
    .from("products")
    .select("id, slug, status, product_type")
    .eq("id", productId)
    .maybeSingle();
  if (!product || product.status !== "active" || product.product_type !== "course") {
    return { ok: false, error: t.notFound };
  }

  const { data: detail } = await db
    .from("course_details")
    .select("enrollment_type, enroll_deadline")
    .eq("product_id", productId)
    .maybeSingle();
  if (!detail) return { ok: false, error: t.notFound };
  // 付費課程的結帳流程是階段 3,這裡一律擋掉——免得走免費路徑白拿付費課。
  if (detail.enrollment_type !== "free") return { ok: false, error: t.notFree };
  if (detail.enroll_deadline && new Date(detail.enroll_deadline).getTime() < Date.now()) {
    return { ok: false, error: t.closed };
  }

  // 聯絡資訊取自會員資料(表單不另外收),profiles 沒填就留空字串交給 RPC 的 coalesce。
  const { data: profile } = await db
    .from("profiles")
    .select("name, email, phone")
    .eq("id", user.id)
    .maybeSingle();

  // 免費報名:不建訂單、建立即確認,所以 order_id/expires_at 一律 null、confirmed 為 true。
  const { data: rpcResult, error: rpcError } = await db.rpc("reserve_course_seat", {
    p_product_id: productId,
    p_user_id: user.id,
    p_order_id: null,
    p_confirmed: true,
    p_expires_at: null,
    p_name: profile?.name ?? "",
    p_email: profile?.email ?? user.email ?? "",
    p_phone: profile?.phone ?? "",
  });
  if (rpcError) {
    console.error("[enrollments] reserve_course_seat failed:", rpcError);
    return { ok: false, error: t.failed };
  }

  switch (rpcResult) {
    case "ok":
      break;
    case "full":
      return { ok: false, error: t.full };
    case "already_enrolled":
      return { ok: false, error: t.alreadyEnrolled };
    case "not_course":
      return { ok: false, error: t.notFound };
    default:
      console.error("[enrollments] unexpected reserve_course_seat result:", rpcResult);
      return { ok: false, error: t.failed };
  }

  // 觀看權:同一人同一堂課唯一(course_access_user_product_uniq),重報要把先前的
  // revoked_at 清掉。這一步失敗不回滾報名(名額已扣、報名已成立),只記 log 讓後台補。
  const { error: accessError } = await db.from("course_access").upsert(
    {
      user_id: user.id,
      product_id: productId,
      source: "enrollment",
      revoked_at: null,
    },
    { onConflict: "user_id,product_id" }
  );
  if (accessError) {
    console.error("[enrollments] course_access upsert failed:", accessError);
  }

  revalidatePath("/courses");
  // 課程詳情頁已改為 /courses/<slug>(/products/<slug> 只剩 301 轉址)
  revalidatePath(`/courses/${product.slug}`);
  revalidatePath("/account");

  return { ok: true };
}
