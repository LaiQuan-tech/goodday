import type { Locale } from "@/lib/i18n/config";

export function formatTWD(amount: number, locale: Locale = "zh") {
  return `NT$ ${amount.toLocaleString(locale === "en" ? "en-US" : "zh-TW")}`;
}

export function formatDate(
  value: string | Date | null | undefined,
  locale: Locale = "zh",
) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString(locale === "en" ? "en-US" : "zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatDateTime(
  value: string | Date | null | undefined,
  locale: Locale = "zh",
) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString(locale === "en" ? "en-US" : "zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 存取器:locale === "en" 回英文 map 值,否則(含未知 locale)一律回中文。
// admin 呼叫點永遠不傳 locale(或傳 "zh")→ 保證後台永遠中文。
function label<T extends string>(
  zhMap: Record<T, string>,
  enMap: Record<T, string>,
  key: T,
  locale: Locale = "zh",
): string {
  return locale === "en" ? (enMap[key] ?? zhMap[key]) : zhMap[key];
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待付款",
  paid: "已付款",
  processing: "備貨中",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
};

export const ORDER_STATUS_LABEL_EN: Record<string, string> = {
  pending: "Pending Payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function getOrderStatusLabel(key: string, locale: Locale = "zh") {
  return label(ORDER_STATUS_LABEL, ORDER_STATUS_LABEL_EN, key, locale);
}

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "AI 草稿",
  sent: "已寄出",
  viewed: "已查看",
  accepted: "已接受",
  declined: "已婉拒",
  expired: "已過期",
  converted: "已轉訂單",
};

export const QUOTE_STATUS_LABEL_EN: Record<string, string> = {
  draft: "AI Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  converted: "Converted to Order",
};

export function getQuoteStatusLabel(key: string, locale: Locale = "zh") {
  return label(QUOTE_STATUS_LABEL, QUOTE_STATUS_LABEL_EN, key, locale);
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  bank_transfer: "銀行轉帳",
  cod: "貨到付款",
  card: "信用卡",
  other: "其他",
};

export const PAYMENT_METHOD_LABEL_EN: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cod: "Cash on Delivery",
  card: "Credit Card",
  other: "Other",
};

export function getPaymentMethodLabel(key: string, locale: Locale = "zh") {
  return label(PAYMENT_METHOD_LABEL, PAYMENT_METHOD_LABEL_EN, key, locale);
}

export const PURCHASE_MODE_LABEL: Record<string, string> = {
  buyout: "買斷",
  rental: "月租",
  journey: "私人旅程",
  membership: "會員方案",
  course: "課程",
};

export const PURCHASE_MODE_LABEL_EN: Record<string, string> = {
  buyout: "Buyout",
  rental: "Monthly Rental",
  journey: "Private Journey",
  membership: "Membership",
  course: "Course",
};

export function getPurchaseModeLabel(key: string, locale: Locale = "zh") {
  return label(PURCHASE_MODE_LABEL, PURCHASE_MODE_LABEL_EN, key, locale);
}

export const SHIPPING_METHOD_LABEL: Record<string, string> = {
  home: "宅配到府",
  pickup: "門市自取",
  none: "無需配送",
};

export const SHIPPING_METHOD_LABEL_EN: Record<string, string> = {
  home: "Home Delivery",
  pickup: "Store Pickup",
  none: "No Shipping Required",
};

export function getShippingMethodLabel(key: string, locale: Locale = "zh") {
  return label(SHIPPING_METHOD_LABEL, SHIPPING_METHOD_LABEL_EN, key, locale);
}

export const INVOICE_TYPE_LABEL: Record<string, string> = {
  personal: "個人(雲端發票)",
  company: "公司(統編發票)",
};

export const INVOICE_TYPE_LABEL_EN: Record<string, string> = {
  personal: "Individual (E-Invoice)",
  company: "Company (Tax ID Invoice)",
};

export function getInvoiceTypeLabel(key: string, locale: Locale = "zh") {
  return label(INVOICE_TYPE_LABEL, INVOICE_TYPE_LABEL_EN, key, locale);
}

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  new: "待處理",
  confirmed: "已確認",
  done: "已完成",
  cancelled: "已取消",
};

export const BOOKING_STATUS_LABEL_EN: Record<string, string> = {
  new: "Pending",
  confirmed: "Confirmed",
  done: "Completed",
  cancelled: "Cancelled",
};

export function getBookingStatusLabel(key: string, locale: Locale = "zh") {
  return label(BOOKING_STATUS_LABEL, BOOKING_STATUS_LABEL_EN, key, locale);
}

export const COURSE_KIND_LABEL: Record<string, string> = {
  live: "報名課程",
  recorded: "線上預錄",
};

export const COURSE_KIND_LABEL_EN: Record<string, string> = {
  live: "Scheduled Class",
  recorded: "On-Demand",
};

export function getCourseKindLabel(key: string, locale: Locale = "zh") {
  return label(COURSE_KIND_LABEL, COURSE_KIND_LABEL_EN, key, locale);
}

export const ENROLLMENT_TYPE_LABEL: Record<string, string> = {
  free: "免費報名",
  paid: "付費報名",
};

export const ENROLLMENT_TYPE_LABEL_EN: Record<string, string> = {
  free: "Free",
  paid: "Paid",
};

export function getEnrollmentTypeLabel(key: string, locale: Locale = "zh") {
  return label(ENROLLMENT_TYPE_LABEL, ENROLLMENT_TYPE_LABEL_EN, key, locale);
}

// reserved = 付費報名已佔位但尚未付款,逾期會被排程回收
export const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  reserved: "保留中",
  confirmed: "已確認",
  cancelled: "已取消",
};

export const ENROLLMENT_STATUS_LABEL_EN: Record<string, string> = {
  reserved: "Reserved",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

export function getEnrollmentStatusLabel(key: string, locale: Locale = "zh") {
  return label(ENROLLMENT_STATUS_LABEL, ENROLLMENT_STATUS_LABEL_EN, key, locale);
}

export function formatPoints(points: number, locale: Locale = "zh") {
  return locale === "en"
    ? `${points.toLocaleString("en-US")} pts`
    : `${points.toLocaleString("zh-TW")} 點`;
}

// ---------- Phase D:商品內容(DB 欄位,非靜態 map)的 locale 存取器 ----------
// 與上面 label() 系列(靜態中英 map)不同,商品名稱/描述/會員權益是逐筆存在 DB 的內容,
// 且英文欄位由 AI 翻譯腳本(scripts/translate-products.mjs)陸續補上、可能還是 null。
// 規則不變:locale !== "en" 一律回中文(admin 呼叫點不傳 locale 或傳 "zh" 就保證後台永遠中文);
// locale === "en" 時優先回英文,尚未翻譯(en 為 null/undefined/空字串)則 fallback 回中文——
// 這是「未翻譯自動退回中文」的唯一事實來源,D3 各頁面都呼叫這裡,不要在頁面各自重寫三元判斷。
export function localizeText(
  zh: string,
  en: string | null | undefined,
  locale: Locale = "zh",
): string {
  if (locale !== "en") return zh;
  return en && en.trim() ? en : zh;
}

// 陣列版本(會員權益 perks):en 陣列存在且非空才使用,否則整份 fallback 中文陣列
// (不逐項 fallback——避免中英文權益混雜同一個清單,語意會很奇怪)。
export function localizeList(
  zh: string[],
  en: string[] | null | undefined,
  locale: Locale = "zh",
): string[] {
  if (locale !== "en") return zh;
  return en && en.length > 0 ? en : zh;
}

// ---------- Phase G:商品 category 的英文對照 ----------
// category 是 admin 手動輸入的自由文字(見 admin/ProductForm.tsx 的 <input name="category">),
// 不是像其他狀態那樣的固定 code,所以用「中文值 → 英文值」直接對照,而非上面 label()
// 系列的 key→value 模式。查無對照(未收錄的自訂分類)→ locale=en 時仍 fallback 回中文原值,
// 不留白也不亂猜英文。
const CATEGORY_LABEL_EN: Record<string, string> = {
  風景: "Landscape",
  抽象: "Abstract",
  靜物: "Still Life",
  植物: "Botanical",
  私人旅程: "Private Journey",
  會員方案: "Membership",
};

export function getCategoryLabel(category: string, locale: Locale = "zh"): string {
  if (locale !== "en") return category;
  return CATEGORY_LABEL_EN[category] ?? category;
}
