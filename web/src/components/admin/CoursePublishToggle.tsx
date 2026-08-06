"use client";

// 課程列表頁的一鍵上架／下架。
// 狀態欄位本來就在編輯表單裡,但那是一個 282 行表單中段的下拉選單,
// 要上架得「點編輯 → 往下捲 → 改下拉 → 存檔」四步,實務上等於找不到。
// 這裡把最常用的那個動作提到列表頁,一鍵完成。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { setCourseStatus } from "@/app/admin/actions";

export default function CoursePublishToggle({
  courseId,
  status,
}: {
  courseId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const isActive = status === "active";
  const next = isActive ? "draft" : "active";
  const label = isActive ? "下架" : "上架";

  async function toggle() {
    if (busy) return;
    // 上架 = 對外公開,下架 = 客人立刻看不到,兩邊都值得再確認一次
    if (!confirm(isActive ? "確定將這堂課下架?前台會立刻看不到。" : "確定將這堂課上架?前台會立刻公開。")) {
      return;
    }
    setBusy(true);
    try {
      await setCourseStatus(courseId, next);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "操作失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className={isActive ? "iv-btn-ghost" : "iv-btn-primary"}
    >
      {busy ? "處理中…" : label}
    </button>
  );
}
