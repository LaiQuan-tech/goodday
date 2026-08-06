"use client";

// 課程詳情頁的報名區塊。狀態優先序(由上而下,先命中先渲染):
//   未登入 → 已報名 → 額滿 → 報名截止 → 免費報名(可按)→ 付費報名(加入購物車 → 結帳)
// 免費報名一律經 Server Action enrollFreeCourse();付費報名則走既有金流:加入購物車後
// 導向 /checkout,座位由 api/orders 在建單當下呼叫 reserve_course_seat() 佔位。
// 名額一律由 DB function 序列化控管;本元件的 full/closed 只是把明顯不可報名的狀態
// 先擋在前端,真正的把關永遠在 server 端重查一次。
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { enrollFreeCourse } from "@/lib/enrollments";
import { addToCart } from "@/lib/cart";
import { useTranslations } from "@/lib/i18n/context";
import { localeHref } from "@/lib/i18n/href";
import type { EnrollmentType } from "@/lib/types";

export default function CourseEnrollSection({
  productId,
  slug,
  name,
  nameEn,
  price,
  enrollmentType,
  capacity,
  seatsTaken,
  closed,
  loggedIn,
  enrolled,
}: {
  productId: string;
  slug: string;
  // 加入購物車需要商品快照(價格仍以 DB 為準,api/orders 會重查一次,不信任這裡的值)
  name: string;
  nameEn: string | null;
  price: number;
  enrollmentType: EnrollmentType;
  capacity: number | null;   // null = 不限名額
  seatsTaken: number;
  // 由 server 端算好傳進來,不在 render 期間讀時鐘:
  // client component 在 SSR 與 hydration 兩個時間點各算一次,
  // 剛好跨過截止時間就會 hydration mismatch。
  closed: boolean;
  loggedIn: boolean;
  enrolled: boolean;
}) {
  const router = useRouter();
  const { locale, messages } = useTranslations();
  const t = messages.courses;
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState("");

  const full = capacity !== null && seatsTaken >= capacity;

  async function enroll() {
    if (submitting || succeeded) return;
    setError("");
    setSubmitting(true);
    const result = await enrollFreeCourse(productId, locale);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSucceeded(true);
    // 讓 server component 重新查一次名額與報名狀態(seats_taken / enrolled 會一起更新)
    router.refresh();
  }

  // 付費報名:購物車是 localStorage(lib/cart.ts),這裡只放入品項再導向結帳頁;
  // 座位不在這裡佔 —— 要等 /api/orders 真的建單時才由 reserve_course_seat() 佔位,
  // 否則只是把商品丟進購物車就會鎖住別人的名額。
  function enrollPaid() {
    if (checkingOut) return;
    setCheckingOut(true);
    addToCart(
      {
        productId,
        slug,
        name,
        name_en: nameEn,
        price,
        mode: "course",
      },
      1
    );
    router.push(localeHref("/checkout", locale));
  }

  // 報名成功後就不再顯示按鈕:router.refresh() 回來的 enrolled 也會是 true,
  // 但成功訊息要留著讓客人看到明確回饋。
  if (succeeded) {
    return (
      <p className="rounded-lg bg-ok-soft p-3 text-sm text-ok">{t.enrollSuccess}</p>
    );
  }

  let body;
  if (!loggedIn) {
    body = (
      <Link
        href={localeHref(`/login?redirect=/products/${slug}`, locale)}
        className="iv-btn-primary w-full sm:w-auto"
      >
        {t.loginToEnroll}
      </Link>
    );
  } else if (enrolled) {
    body = (
      <p className="rounded-lg bg-ok-soft p-3 text-sm text-ok">{t.enrolledNote}</p>
    );
  } else if (full) {
    body = (
      <button type="button" disabled className="iv-btn-primary w-full sm:w-auto">
        {t.enrollFullLabel}
      </button>
    );
  } else if (closed) {
    body = (
      <button type="button" disabled className="iv-btn-primary w-full sm:w-auto">
        {t.enrollClosedLabel}
      </button>
    );
  } else if (enrollmentType === "free") {
    body = (
      <button
        type="button"
        onClick={enroll}
        disabled={submitting}
        className="iv-btn-primary w-full sm:w-auto"
      >
        {submitting ? t.enrolling : t.enrollFree}
      </button>
    );
  } else {
    // 付費報名:加入購物車 → 結帳。未登入已在最上面的分支擋掉(course_access 綁 user_id,
    // /api/orders 也會再擋一次 400)。
    body = (
      <div>
        <button
          type="button"
          onClick={enrollPaid}
          disabled={checkingOut}
          className="iv-btn-primary w-full sm:w-auto"
        >
          {checkingOut ? t.enrollingPaid : t.enrollPaid}
        </button>
        <p className="mt-2 text-[13px] text-muted-2">{t.paidNote}</p>
      </div>
    );
  }

  return (
    <div>
      {body}
      {error && (
        <p className="mt-3 rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>
      )}
    </div>
  );
}
