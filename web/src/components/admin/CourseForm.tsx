"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { archiveCourse, upsertCourse } from "@/app/admin/actions";
import ImageUploader from "@/components/admin/ImageUploader";
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

// FAQ 在 DB 是 jsonb 陣列,後台用 textarea 編輯:一行一組、以 | 分隔(問題|答案)。
// 這是「陣列 → 文字」的反向轉換,server action 的 parseFaqField() 是正向。
// 英文版一筆都還沒翻譯時回空字串(不要顯示一排孤零零的「|」);
// 只翻了一部分時,未翻譯的那幾行留空行 —— 索引才對得回中文那一筆。
function faqToText(items: CourseDetail["faq"] | null | undefined, en: boolean) {
  const list = items ?? [];
  if (!en) return list.map((item) => `${item.q}|${item.a}`).join("\n");
  if (!list.some((item) => item.q_en || item.a_en)) return "";
  return list
    .map((item) => (item.q_en || item.a_en ? `${item.q_en ?? ""}|${item.a_en ?? ""}` : ""))
    .join("\n");
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
        <div className="sm:col-span-2">
          <label className="iv-label">副標語(顯示在課程頁主視覺的大標下方)</label>
          <input
            name="subtitle"
            className="iv-input"
            placeholder="例:一個下午,學會把季節插進家裡"
            defaultValue={detail?.subtitle ?? ""}
          />
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
        <div>
          <label className="iv-label">狀態</label>
          <select name="status" className="iv-input" defaultValue={product?.status ?? "draft"}>
            <option value="draft">草稿</option>
            <option value="active">上架</option>
            <option value="archived">下架</option>
          </select>
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
          <label className="iv-label">排序(數字小的排前面)</label>
          <input
            name="sort_order"
            type="number"
            className="iv-input"
            defaultValue={product?.sort_order ?? 0}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">費用補充說明</label>
          <textarea
            name="fee_note"
            rows={2}
            className="iv-input min-h-16"
            placeholder="例:費用含全部花材與工具,現場可寄放作品"
            defaultValue={detail?.fee_note ?? ""}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="iv-label">痛點引入(課程頁第二區,空一行分段)</label>
          <textarea
            name="pain_points"
            rows={5}
            className="iv-input min-h-28"
            placeholder={"每次買了花，三天後就爛在瓶子裡。\n\n不是你不會照顧，是沒有人告訴過你順序。"}
            defaultValue={detail?.pain_points ?? ""}
          />
          <p className="mt-1 text-xs text-ink-soft">留白則課程頁不顯示這一區。</p>
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
          <label className="iv-label">你會獲得什麼(一行一項)</label>
          <textarea
            name="benefits"
            rows={5}
            className="iv-input min-h-28"
            placeholder={"看懂花材的季節與個性\n三種日常花器的配置比例\n把作品帶回家的保鮮方法"}
            defaultValue={detail?.benefits ?? ""}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">課程大綱(一行一個單元)</label>
          <textarea
            name="outline"
            rows={6}
            className="iv-input min-h-32"
            placeholder="一行一個單元或重點"
            defaultValue={detail?.outline ?? ""}
          />
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
          <label className="iv-label">講師頭銜</label>
          <input
            name="instructor_title"
            className="iv-input"
            placeholder="例:花藝師 / 小時光書店主理人"
            defaultValue={detail?.instructor_title ?? ""}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">講師介紹</label>
          <textarea
            name="instructor_bio"
            rows={5}
            className="iv-input min-h-28"
            placeholder="講師的經歷與風格,課程頁會以深色區塊呈現"
            defaultValue={detail?.instructor_bio ?? ""}
          />
        </div>
        <div className="sm:col-span-2">
          {/* ImageUploader 內建標題寫死「商品圖片」,這裡在上面補一行標明用途;
              max=1 是因為 DB 的 instructor_photo_url 是單一字串,不是陣列。 */}
          <div className="mb-1 text-sm font-medium text-ink">講師照片(只放一張)</div>
          <ImageUploader
            name="instructor_photo"
            initial={detail?.instructor_photo_url ? [{ url: detail.instructor_photo_url }] : []}
            max={1}
            hint="建議直式人像(課程頁以 3:4 呈現)。沒有照片時,講師區塊會改成純文字滿版。"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="iv-label">常見問答(一行一組,用 | 分隔:問題|答案)</label>
          <textarea
            name="faq"
            rows={5}
            className="iv-input min-h-28"
            placeholder={"需要自備工具嗎?|不用,所有花材與工具都準備好了。\n可以請假嗎?|開課前 7 天可改期一次。"}
            defaultValue={faqToText(detail?.faq, false)}
          />
          <p className="mt-1 text-xs text-ink-soft">留白則課程頁不顯示問答區。沒有 | 的那一行會被當成只有問題。</p>
        </div>

        <div className="sm:col-span-2">
          <ImageUploader initial={product?.images ?? []} hint="第一張會成為課程頁的全幅主視覺(建議橫式,長邊 2000px 以內)。" />
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

      {/*
        英文欄位全部收在原生 <details> 裡(零套件、預設收起)。
        課程頁欄位數本來就多,英文版再攤開會直接翻倍,經營者會放棄填中文以外的東西。
        留空一律 fallback 中文(server action 存 null/空字串,渲染端走 localizeText)。
      */}
      <details className="rounded-[2px] border border-line-2 bg-panel p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          英文版內容(選填,留空則英文站顯示中文)
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="iv-label">英文名稱</label>
            <input
              name="name_en"
              className="iv-input"
              defaultValue={product?.name_en ?? ""}
              placeholder="留空則英文站顯示中文名稱"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文副標語</label>
            <input
              name="subtitle_en"
              className="iv-input"
              defaultValue={detail?.subtitle_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文上課地點</label>
            <input
              name="location_en"
              className="iv-input"
              disabled={isRecorded}
              defaultValue={detail?.location_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文費用補充說明</label>
            <textarea
              name="fee_note_en"
              rows={2}
              className="iv-input min-h-16"
              defaultValue={detail?.fee_note_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文痛點引入(空一行分段)</label>
            <textarea
              name="pain_points_en"
              rows={5}
              className="iv-input min-h-28"
              defaultValue={detail?.pain_points_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文簡介</label>
            <textarea
              name="description_en"
              rows={4}
              className="iv-input min-h-24"
              defaultValue={product?.description_en ?? ""}
              placeholder="留空則英文站顯示中文簡介"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文「你會獲得什麼」(一行一項)</label>
            <textarea
              name="benefits_en"
              rows={5}
              className="iv-input min-h-28"
              defaultValue={detail?.benefits_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文課程大綱(一行一個單元)</label>
            <textarea
              name="outline_en"
              rows={6}
              className="iv-input min-h-32"
              defaultValue={detail?.outline_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文講師頭銜</label>
            <input
              name="instructor_title_en"
              className="iv-input"
              defaultValue={detail?.instructor_title_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文講師介紹</label>
            <textarea
              name="instructor_bio_en"
              rows={5}
              className="iv-input min-h-28"
              defaultValue={detail?.instructor_bio_en ?? ""}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="iv-label">英文常見問答(一行一組,問題|答案)</label>
            <textarea
              name="faq_en"
              rows={5}
              className="iv-input min-h-28"
              defaultValue={faqToText(detail?.faq, true)}
            />
            <p className="mt-1 text-xs text-ink-soft">
              請與上方中文問答「同一行序」對應;多出來的行會被忽略。
            </p>
          </div>
        </div>
      </details>

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
