"use client";

// 課程活動頁的行動裝置常駐報名列。
//
// ⚠️ 這裡只放一顆 <a href="#enroll"> 錨點,絕對不要在這裡再渲染一次 CourseEnrollSection。
// 那個元件自己帶 useState(submitting / succeeded / checkingOut),同時掛兩份就是兩份
// 各自獨立的狀態:客人在頁面中段按了「免費報名」成功後,底下這條 bar 仍會顯示「免費報名」
// 可以再按一次,反之亦然。報名入口全站只能有一個,這條 bar 的職責只是把人送過去。
import { useEffect, useState } from "react";

export default function CourseStickyCta({
  name,
  dateText,
  priceText,
  ctaLabel,
}: {
  name: string;
  dateText: string;
  priceText: string;
  ctaLabel: string;
}) {
  // 報名區進入視窗時把 bar 滑出畫面:真正的報名按鈕已經在眼前,
  // 這條 bar 再擋在下面只是遮住內容(手機上尤其明顯)。
  const [atEnroll, setAtEnroll] = useState(false);

  useEffect(() => {
    const target = document.getElementById("enroll");
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => setAtEnroll(entries[0]?.isIntersecting ?? false),
      { rootMargin: "0px 0px -25% 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform duration-300 ${
        atEnroll ? "translate-y-full" : "translate-y-0"
      }`}
    >
      {/* 右側留白讓開 ChatWidget 的浮動按鈕(fixed bottom-5 right-5,56px 見方,
          右緣到視窗邊界共 76px);不留就會被圓鈕壓住按不到。 */}
      <div className="lm-container flex items-center justify-between gap-4 py-3 pr-20 sm:pr-24">
        <div className="min-w-0">
          <div className="hidden truncate font-serif text-[15px] text-ink sm:block">{name}</div>
          {dateText && (
            <div className="hidden text-[12.5px] text-muted-2 sm:block">{dateText}</div>
          )}
          <div className="font-serif text-[17px] text-ink sm:mt-0.5 sm:text-[15px]">
            {priceText}
          </div>
        </div>
        <a href="#enroll" className="iv-btn-primary shrink-0 !px-6">
          {ctaLabel}
        </a>
      </div>
    </div>
  );
}
