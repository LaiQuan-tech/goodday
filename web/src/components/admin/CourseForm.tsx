"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { archiveCourse, upsertCourse } from "@/app/admin/actions";
import type { CourseDetail, CourseKind, EnrollmentType, Product } from "@/lib/types";

// DB 存的是 UTC 瞬間,<input type="datetime-local"> 要的是台北牆上時間。
// 這裡不用 getFullYear() 等「本地時區」方法:client component 也會先在伺服器(UTC)
// 預先渲染,兩邊算出不同字串會 hydration 不一致,故固定用 +8 位移。
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function toLocalInput(value: string | null | undefined) {
  if (!value) return "";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t + TAIPEI_OFFSET_MS).toISOString().slice(0, 16);
}

export default function CourseForm({
  product,
  detail,
}: {
  product: Product | null;
  detail: CourseDetail | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<CourseKind>(detail?.course_kind ?? "live");
  const [enrollmentType, setEnrollmentType] = useState<EnrollmentType>(
    detail?.enrollment_type ?? "paid"
  );

  // 預錄課程沒有免費報名、名額、地點與上課時段的概念(DB 也有對應 CHECK)
  const isRecorded = kind === "recorded";

  function handleKindChange(next: CourseKind) {
    setKind(next);
    if (next === "recorded") setEnrollmentType("paid");
  }

  async function handleSubmit(formData: FormData) {
    setSaving(true);
    setError("");
    try {
      await upsertCourse(formData);
      router.push("/admin/courses");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
      setSaving(false);
    }
  }

  return (
    <form action={handleSubmit} className="iv-card space-y-4">
      {product && <input type="hidden" name="id" value={product.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="iv-label">課程名稱 *</label>
          <input name="name" required className="iv-input" defaultValue={product?.name ?? ""} />
        </div>
        <div>
          <label className="iv-label">網址代稱(slug)*</label>
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            title="小寫英數與連字號"
            className="iv-input"
            defaultValue={product?.slug ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">售價(TWD)*</label>
          <input
            name="price"
            required
            type="number"
            min={0}
            className="iv-input"
            defaultValue={product?.price ?? 0}
          />
        </div>
        <div>
          <label className="iv-label">課程類型 *</label>
          <select
            name="course_kind"
            className="iv-input"
            value={kind}
            onChange={(e) => handleKindChange(e.target.value as CourseKind)}
          >
            <option value="live">實體/線上直播(報名制)</option>
            <option value="recorded">線上預錄課程</option>
          </select>
        </div>
        <div>
          <label className="iv-label">報名方式 *</label>
          <select
            name="enrollment_type"
            className="iv-input"
            value={enrollmentType}
            disabled={isRecorded}
            onChange={(e) => setEnrollmentType(e.target.value as EnrollmentType)}
          >
            <option value="paid">付費報名</option>
            <option value="free">免費報名</option>
          </select>
          {isRecorded && (
            <p className="mt-1 text-xs text-ink-soft">預錄課程一律為付費購買。</p>
          )}
        </div>
        <div>
          <label className="iv-label">講師</label>
          <input
            name="instructor"
            className="iv-input"
            defaultValue={detail?.instructor ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">名額(留白 = 不限)</label>
          <input
            name="capacity"
            type="number"
            min={1}
            className="iv-input"
            disabled={isRecorded}
            defaultValue={detail?.capacity ?? ""}
          />
          {isRecorded ? (
            <p className="mt-1 text-xs text-ink-soft">預錄課程不限名額。</p>
          ) : (
            detail && (
              <p className="mt-1 text-xs text-ink-soft">目前已報名 {detail.seats_taken} 人</p>
            )
          )}
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">上課地點</label>
          <input
            name="location"
            className="iv-input"
            disabled={isRecorded}
            placeholder="例:小時光書店(華山1914 西7-3館)"
            defaultValue={detail?.location ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">開始時間</label>
          <input
            name="starts_at"
            type="datetime-local"
            className="iv-input"
            disabled={isRecorded}
            defaultValue={toLocalInput(detail?.starts_at)}
          />
        </div>
        <div>
          <label className="iv-label">結束時間</label>
          <input
            name="ends_at"
            type="datetime-local"
            className="iv-input"
            disabled={isRecorded}
            defaultValue={toLocalInput(detail?.ends_at)}
          />
        </div>
        <div>
          <label className="iv-label">報名截止</label>
          <input
            name="enroll_deadline"
            type="datetime-local"
            className="iv-input"
            defaultValue={toLocalInput(detail?.enroll_deadline)}
          />
        </div>
        <div>
          <label className="iv-label">狀態</label>
          <select name="status" className="iv-input" defaultValue={product?.status ?? "draft"}>
            <option value="draft">草稿</option>
            <option value="active">上架</option>
            <option value="archived">下架</option>
          </select>
        </div>
        <div>
          <label className="iv-label">排序(數字小的排前面)</label>
          <input
            name="sort_order"
            type="number"
            className="iv-input"
            defaultValue={product?.sort_order ?? 0}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">課程簡介</label>
          <textarea
            name="description"
            rows={4}
            className="iv-input min-h-24"
            defaultValue={product?.description ?? ""}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">課程大綱</label>
          <textarea
            name="outline"
            rows={6}
            className="iv-input min-h-32"
            placeholder="一行一個單元或重點"
            defaultValue={detail?.outline ?? ""}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">圖片網址(一行一個)</label>
          <textarea
            name="images"
            rows={3}
            className="iv-input min-h-20"
            placeholder="https://…"
            defaultValue={(product?.images ?? []).map((i) => i.url).join("\n")}
          />
          <p className="mt-1 text-xs text-ink-soft">
            可使用 Supabase Storage 或任何圖床網址。
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="featured"
            defaultChecked={product?.featured ?? false}
            className="h-4 w-4 accent-[#2742f5]"
          />
          設為精選(顯示於首頁)
        </label>
      </div>

      {error && (
        <p className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={saving} className="iv-btn-primary">
          {saving ? "儲存中…" : "儲存"}
        </button>
        {product && product.status !== "archived" && (
          <button
            type="button"
            className="iv-btn-danger"
            onClick={async () => {
              if (!confirm("確定要下架此課程嗎?已報名的紀錄會保留。")) return;
              await archiveCourse(product.id);
              router.push("/admin/courses");
            }}
          >
            下架課程
          </button>
        )}
      </div>
    </form>
  );
}
