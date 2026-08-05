"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "@/lib/i18n/context";
import { localeHref, stripLocalePrefix } from "@/lib/i18n/href";
import type { Messages } from "@/lib/i18n/messages";

// label 改成 nav messages 的 key(labelKey),實際文字由 render 端依目前語系從
// messages.nav 取——Header(桌機)與 MobileNav(手機)共用同一份 NAV_ITEMS,
// 兩端都會自動吃到正確語系,不需要各自維護一份文字。
export const NAV_ITEMS: {
  href: string;
  labelKey: keyof Messages["nav"];
  match: (p: string) => boolean;
}[] = [
  { href: "/", labelKey: "home", match: (p: string) => p === "/" },
  { href: "/gallery", labelKey: "gallery", match: (p: string) => p.startsWith("/gallery") || p.startsWith("/products") },
  { href: "/journeys", labelKey: "journeys", match: (p: string) => p.startsWith("/journeys") },
  { href: "/rental", labelKey: "rental", match: (p: string) => p.startsWith("/rental") },
  { href: "/courses", labelKey: "courses", match: (p: string) => p.startsWith("/courses") },
  { href: "/membership", labelKey: "membership", match: (p: string) => p.startsWith("/membership") },
];

export default function NavLinks({ className = "" }: { className?: string }) {
  const pathname = usePathname() ?? "/";
  const { locale, messages } = useTranslations();
  // NAV_ITEMS.match() 全部寫死不帶前綴的路徑,/en 站下 usePathname() 回傳的是
  // "/en/gallery" 之類——比對前先去掉前綴,不然 active 高亮在英文站永遠失效。
  const cleanPathname = stripLocalePrefix(pathname);

  return (
    <>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={localeHref(item.href, locale)}
          data-active={item.match(cleanPathname)}
          className={`lm-nav-link ${className}`}
        >
          {messages.nav[item.labelKey]}
        </Link>
      ))}
    </>
  );
}
