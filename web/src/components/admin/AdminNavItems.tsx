export type AdminBadgeKey = "orders" | "quotes";

export type AdminNavItem = {
  href: string;
  label: string;
  /** SVG path d 屬性(24x24 viewBox, stroke 樣式) */
  icon: string;
  badge?: AdminBadgeKey;
  /** true = 顯示在手機底部分頁列;false = 收進「更多」 */
  primary?: boolean;
};

export const ADMIN_NAV: AdminNavItem[] = [
  { href: "/admin", label: "總覽", icon: "M3 12h7V3H3v9Zm11 9h7v-9h-7v9ZM3 21h7v-6H3v6Zm11-12h7V3h-7v6Z" },
  { href: "/admin/orders", label: "訂單", icon: "M6 2h9l5 5v15H6V2Zm9 0v5h5M9 13h8M9 17h5", badge: "orders", primary: true },
  { href: "/admin/quotes", label: "報價", icon: "M5 3h10l4 4v14H5V3Zm10 0v4h4M9 12h6M9 16h4", badge: "quotes", primary: true },
  { href: "/admin/products", label: "商品", icon: "M3 6h18v13H3V6Zm0 0 3-3h12l3 3M9 11a3 3 0 0 0 6 0", primary: true },
  { href: "/admin/courses", label: "課程", icon: "M4 4h5a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4V4Zm16 0h-5a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h5V4Z", primary: true },
  { href: "/admin/members", label: "會員", icon: "M16 20v-1a4 4 0 0 0-8 0v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" },
  { href: "/admin/bookings", label: "預約", icon: "M4 5h16v16H4V5Zm0 5h16M9 3v4M15 3v4" },
  { href: "/admin/settings", label: "設定", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a8 8 0 0 1-2 1.2l-.4 2.6h-4l-.4-2.6a8 8 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6A8 8 0 0 1 4 12a8 8 0 0 1 .1-1.2l-2-1.6 2-3.4 2.4 1a8 8 0 0 1 2-1.2L8.9 3h4l.4 2.6a8 8 0 0 1 2 1.2l2.4-1 2 3.4-2 1.6A8 8 0 0 1 20 12Z" },
];

/** 目前路徑是否命中該項目。/admin 需完全相符,否則所有子頁都會讓它亮起。 */
export function isAdminNavActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNavIcon({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
