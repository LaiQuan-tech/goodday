import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime, getEnrollmentStatusLabel } from "@/lib/format";
import type { CourseDetail, CourseEnrollment, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
  reserved: "bg-line text-ink-soft",
  confirmed: "bg-ok-soft text-ok",
  cancelled: "bg-danger-soft text-danger",
};

// 名額顯示:capacity 為 null 代表不限
function capacityText(detail: CourseDetail | null) {
  if (!detail) return "—";
  return detail.capacity === null ? "不限" : String(detail.capacity);
}

export default async function AdminCourseEnrollmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = createAdminClient();

  const { data: productData } = await db
    .from("products")
    .select("*")
    .eq("id", id)
    .eq("product_type", "course")
    .maybeSingle();
  if (!productData) notFound();
  const product = productData as Product;

  const { data: detailData } = await db
    .from("course_details")
    .select("*")
    .eq("product_id", id)
    .maybeSingle();
  const detail = (detailData as CourseDetail | null) ?? null;

  const { data: enrollmentData } = await db
    .from("course_enrollments")
    .select("*")
    .eq("product_id", id)
    .order("created_at", { ascending: false });
  const enrollments = (enrollmentData ?? []) as CourseEnrollment[];

  // 訂單編號另外查(不用 PostgREST embed:一對一關聯判定不同時回傳形狀會不一致)
  const orderIds = [...new Set(enrollments.map((e) => e.order_id).filter(Boolean))] as string[];
  const orderNoMap = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data: orders } = await db.from("orders").select("id, order_no").in("id", orderIds);
    for (const o of orders ?? []) orderNoMap.set(o.id as string, o.order_no as string);
  }

  // ---------- 對帳:seats_taken 是唯一的權威計數(由 SQL function 加減),
  // 有效報名筆數(status <> 'cancelled')則是實際資料。兩者理應永遠相等;
  // 不相等代表有人繞過 RPC 直接改表、或某次 function 執行到一半失敗 —— 這是
  // 計數漂移的早期警報,會直接導致超賣或名額憑空消失,必須立刻人工查。
  const activeCount = enrollments.filter((e) => e.status !== "cancelled").length;
  const seatsTaken = detail?.seats_taken ?? 0;
  const drift = detail !== null && seatsTaken !== activeCount;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-bold break-words">報名名單:{product.name}</h2>
          <div className="mt-1 text-[13px] text-ink-soft">/{product.slug}</div>
        </div>
        <Link href={`/admin/courses/${product.id}`} className="iv-btn-ghost">
          ← 回課程設定
        </Link>
      </div>

      {/* 對帳數字 */}
      <div className="iv-card mb-4 !p-3.5">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="text-ink-soft">名額上限</span>
            <span className="ml-2 font-medium">{capacityText(detail)}</span>
          </div>
          <div>
            <span className="text-ink-soft">seats_taken(系統計數)</span>
            <span className={`ml-2 font-medium ${drift ? "text-danger" : ""}`}>{seatsTaken}</span>
          </div>
          <div>
            <span className="text-ink-soft">有效報名筆數</span>
            <span className={`ml-2 font-medium ${drift ? "text-danger" : ""}`}>{activeCount}</span>
          </div>
          <div>
            <span className="text-ink-soft">總筆數(含已取消)</span>
            <span className="ml-2 font-medium">{enrollments.length}</span>
          </div>
        </div>
        {drift && (
          <p className="mt-2.5 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">
            ⚠️ 計數不一致:seats_taken({seatsTaken})≠ 有效報名筆數({activeCount})。
            名額可能已漂移(會造成超賣或名額憑空消失),請勿直接改資料表,聯絡工程確認
            course_details 與 course_enrollments。
          </p>
        )}
        {!detail && (
          <p className="mt-2.5 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">
            ⚠️ 這堂課還沒有 course_details 設定,無法報名也無法結帳,請先到課程設定頁補齊。
          </p>
        )}
      </div>

      {/* 手機:卡片 */}
      <div className="flex flex-col gap-2.5 lg:hidden">
        {enrollments.map((e) => (
          <div key={e.id} className="iv-card !p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 font-medium text-ink break-words">
                {e.contact_name || "(未填姓名)"}
              </div>
              <span className={`iv-chip shrink-0 ${STATUS_CHIP[e.status] ?? "bg-line text-ink-soft"}`}>
                {getEnrollmentStatusLabel(e.status)}
              </span>
            </div>
            <div className="mt-1.5 text-[13px] text-ink-soft break-words">
              {e.contact_email || "—"}
            </div>
            <div className="mt-1 text-[13px] text-ink-soft">{e.contact_phone || "—"}</div>
            <div className="mt-1 text-[13px] text-ink-soft">
              報名時間 {formatDateTime(e.created_at)}
            </div>
            <div className="mt-1 text-[13px] text-ink-soft">
              訂單{" "}
              {e.order_id ? (
                <Link href={`/admin/orders/${e.order_id}`} className="hover:text-accent">
                  {orderNoMap.get(e.order_id) ?? e.order_id.slice(0, 8)}
                </Link>
              ) : (
                "—(免費報名)"
              )}
            </div>
            {e.status === "reserved" && e.expires_at && (
              <div className="mt-1 text-[13px] text-ink-soft">
                保留至 {formatDateTime(e.expires_at)}
              </div>
            )}
          </div>
        ))}
        {enrollments.length === 0 && (
          <div className="iv-card text-center text-ink-soft">目前還沒有人報名這堂課。</div>
        )}
      </div>

      {/* 桌機:表格 */}
      <div className="iv-table-wrap hidden lg:block">
        <table className="w-full min-w-200 border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-soft">
              <th className="py-2.5 font-medium">報名者</th>
              <th className="py-2.5 font-medium">Email</th>
              <th className="py-2.5 font-medium">電話</th>
              <th className="py-2.5 font-medium">報名時間</th>
              <th className="py-2.5 font-medium">訂單</th>
              <th className="py-2.5 text-right font-medium">狀態</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((e) => (
              <tr key={e.id} className="border-b border-line/60 hover:bg-card">
                <td className="py-3 font-medium">{e.contact_name || "(未填姓名)"}</td>
                <td className="py-3 text-ink-soft">{e.contact_email || "—"}</td>
                <td className="py-3 text-ink-soft">{e.contact_phone || "—"}</td>
                <td className="py-3 text-ink-soft">
                  {formatDateTime(e.created_at)}
                  {e.status === "reserved" && e.expires_at && (
                    <span className="block text-xs">
                      保留至 {formatDateTime(e.expires_at)}
                    </span>
                  )}
                </td>
                <td className="py-3">
                  {e.order_id ? (
                    <Link href={`/admin/orders/${e.order_id}`} className="hover:text-accent">
                      {orderNoMap.get(e.order_id) ?? e.order_id.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-ink-soft">—(免費報名)</span>
                  )}
                </td>
                <td className="py-3 text-right">
                  <span className={`iv-chip ${STATUS_CHIP[e.status] ?? "bg-line text-ink-soft"}`}>
                    {getEnrollmentStatusLabel(e.status)}
                  </span>
                </td>
              </tr>
            ))}
            {enrollments.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-ink-soft">
                  目前還沒有人報名這堂課。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
