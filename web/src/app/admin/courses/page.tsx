import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import CoursePublishToggle from "@/components/admin/CoursePublishToggle";
import { formatTWD, formatDateTime } from "@/lib/format";
import type { CourseDetail, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  active: "上架中",
  archived: "已下架",
};

const KIND_LABEL: Record<string, string> = {
  live: "報名課程",
  recorded: "預錄課程",
};

const ENROLLMENT_LABEL: Record<string, string> = {
  free: "免費報名",
  paid: "付費報名",
};

// PostgREST 一對一 embed 通常回物件,關聯判定不同時可能回陣列,兩種都吃
type CourseRow = Product & { course_details: CourseDetail | CourseDetail[] | null };

function pickDetail(row: CourseRow): CourseDetail | null {
  const d = row.course_details;
  if (!d) return null;
  return Array.isArray(d) ? d[0] ?? null : d;
}

// 名額顯示:capacity 為 null 代表不限
function seatsText(detail: CourseDetail | null) {
  if (!detail) return "—";
  return detail.capacity === null
    ? `${detail.seats_taken} / 不限`
    : `${detail.seats_taken} / ${detail.capacity}`;
}

export default async function AdminCoursesPage() {
  const db = createAdminClient();
  const { data } = await db
    .from("products")
    .select("*, course_details(*)")
    .eq("product_type", "course")
    .neq("status", "archived")
    .order("sort_order")
    .order("created_at", { ascending: false });
  const courses = (data ?? []) as CourseRow[];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-bold">課程管理</h2>
        <Link href="/admin/courses/new" className="iv-btn-primary !min-h-10 !px-5">
          + 新增課程
        </Link>
      </div>

      <div className="flex flex-col gap-2.5 lg:hidden">
        {courses.map((c) => {
          const d = pickDetail(c);
          return (
            <div key={c.id} className="iv-card !p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    href={`/admin/courses/${c.id}`}
                    className="font-medium text-ink hover:text-accent break-words"
                  >
                    {c.name}
                  </Link>
                </div>
                <span
                  className={`iv-chip shrink-0 ${
                    c.status === "active" ? "bg-ok-soft text-ok" : "bg-line text-ink-soft"
                  }`}
                >
                  {STATUS_LABEL[c.status]}
                </span>
              </div>
              <div className="mt-1.5 text-[13px] text-ink-soft break-words">
                /{c.slug}
                {c.featured && " · 精選"}
              </div>
              <div className="mt-1 text-[13px] text-ink-soft">
                {d ? KIND_LABEL[d.course_kind] : "—"}
                {d && ` · ${ENROLLMENT_LABEL[d.enrollment_type]}`}
              </div>
              <div className="mt-1 text-[13px] text-ink-soft">
                開課 {d?.starts_at ? formatDateTime(d.starts_at) : "—"}
              </div>
              <div className="mt-1 text-[13px] text-ink-soft">
                {formatTWD(c.price)} · 名額 {seatsText(d)}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Link href={`/admin/courses/${c.id}`} className="iv-btn-ghost">
                  編輯
                </Link>
                <CoursePublishToggle courseId={c.id} status={c.status} />
              </div>
            </div>
          );
        })}
        {courses.length === 0 && (
          <div className="iv-card text-center text-ink-soft">
            還沒有課程,點右上角「新增課程」開始建立。
          </div>
        )}
      </div>

      <div className="iv-table-wrap hidden lg:block">
        <table className="w-full min-w-200 border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-soft">
              <th className="py-2.5 font-medium">課程</th>
              <th className="py-2.5 font-medium">類型</th>
              <th className="py-2.5 font-medium">報名方式</th>
              <th className="py-2.5 font-medium">開課時間</th>
              <th className="py-2.5 text-right font-medium">名額</th>
              <th className="py-2.5 text-right font-medium">價格</th>
              <th className="py-2.5 text-right font-medium">狀態</th>
              <th className="py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {courses.map((c) => {
              const d = pickDetail(c);
              return (
                <tr key={c.id} className="border-b border-line/60 hover:bg-card">
                  <td className="py-3">
                    <Link
                      href={`/admin/courses/${c.id}`}
                      className="font-medium hover:text-accent"
                    >
                      {c.name}
                    </Link>
                    <span className="block text-xs text-ink-soft">
                      /{c.slug}
                      {c.featured && " · 精選"}
                    </span>
                  </td>
                  <td className="py-3">{d ? KIND_LABEL[d.course_kind] : "—"}</td>
                  <td className="py-3">{d ? ENROLLMENT_LABEL[d.enrollment_type] : "—"}</td>
                  <td className="py-3 text-ink-soft">
                    {d?.starts_at ? formatDateTime(d.starts_at) : "—"}
                  </td>
                  <td className="py-3 text-right">{seatsText(d)}</td>
                  <td className="py-3 text-right">{formatTWD(c.price)}</td>
                  <td className="py-3 text-right">
                    <span
                      className={`iv-chip ${
                        c.status === "active"
                          ? "bg-ok-soft text-ok"
                          : "bg-line text-ink-soft"
                      }`}
                    >
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <CoursePublishToggle courseId={c.id} status={c.status} />
                  </td>
                </tr>
              );
            })}
            {courses.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-ink-soft">
                  還沒有課程,點右上角「新增課程」開始建立。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
