export type Profile = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  line_id: string | null;
  role: "customer" | "admin";
  tier_slug: string | null;
  tier_expires_at: string | null;
  created_at: string;
};

export type ProductType = "artwork" | "journey" | "membership" | "course";

export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string;
  // Phase D:AI 翻譯的英文欄位,可能尚未翻譯(null)——渲染端一律 fallback 中文。
  name_en: string | null;
  description_en: string | null;
  price: number;
  compare_at_price: number | null;
  currency: string;
  images: { url: string; alt?: string }[];
  category: string;
  stock: number;
  status: "draft" | "active" | "archived";
  featured: boolean;
  sort_order: number;
  product_type: ProductType;
  price_rental_monthly: number | null; // 月租價(僅 artwork)
  points_price: number | null;         // 可折抵點數(journey 用)
  metadata: Record<string, unknown>;   // artwork: {tag, medium, gradient} / journey: {duration} / membership: {tier_slug}
};

export type OrderStatus =
  | "pending"
  | "paid"
  | "processing"
  | "shipped"
  | "completed"
  | "cancelled";

export type ShippingMethod = "home" | "pickup" | "none";

export type InvoiceType = "personal" | "company";

// 收欄位先存檔不開立;company 才需要 tax_id/title,personal 的 carrier 為選填手機條碼
export type Invoice = {
  type?: InvoiceType;
  carrier?: string;
  tax_id?: string;
  title?: string;
};

// 客戶於完成頁回報的匯款帳號末五碼
export type PaymentReport = {
  last5: string;
  reported_at: string;
};

export type Order = {
  id: string;
  order_no: string;
  user_id: string | null;
  quote_id: string | null;
  status: OrderStatus;
  subtotal: number;
  shipping_fee: number;
  total: number;
  points_used: number;
  points_earned: number;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  shipping_address: string;
  shipping_method: ShippingMethod;
  invoice: Invoice;
  payment_report: PaymentReport | null;
  payment_method: "bank_transfer" | "cod" | "card" | "other";
  note: string;
  public_token: string;
  idempotency_key: string | null;
  paid_at: string | null;
  created_at: string;
  // Phase F1:下單當下的買家介面語系,決定通知信 subject/body 中英文分支。
  // default 'zh',既有訂單一律 'zh'。
  locale: "zh" | "en";
};

export type PurchaseMode = "buyout" | "rental" | "journey" | "membership" | "course";

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  name: string;
  unit_price: number;
  quantity: number;
  purchase_mode: PurchaseMode;
  tier_slug: string | null;
};

export type QuoteLineItem = {
  name: string;
  unit_price: number;
  quantity: number;
  note?: string;
};

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"
  | "converted";

export type Quote = {
  id: string;
  quote_no: string;
  session_id: string | null;
  user_id: string | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  status: QuoteStatus;
  line_items: QuoteLineItem[];
  subtotal: number;
  tax: number;
  total: number;
  valid_until: string | null;
  note: string;
  created_by: "ai" | "manual";
  public_token: string;
  order_id: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  created_at: string;
  // 客戶下單當下的介面語系,決定報價/訂單通知信中英文分支。default 'zh',既有報價一律 'zh'。
  locale: "zh" | "en";
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  // 居家擺放模擬:客人空間照 / AI 合成模擬圖。
  // 新資料(2026-07-20 起)一律存 imagePath——chat-uploads bucket 內的路徑(如 rooms/<uuid>.jpg),
  // 渲染時才用 signChatImage 即時簽出短期網址(見 lib/chat-images.ts)。
  imagePath?: string;
  // 舊資料相容用:2026-07-20 之前寫入的紀錄只有這個公開網址欄位(bucket 轉私密後已失效,
  // 靠 pathFromLegacyUrl 反推路徑再簽名)。新程式碼不應再寫入此欄位,只讀取。
  imageUrl?: string;
};

export type RateCardItem = {
  name: string;
  unit_price: number;
  unit?: string;
  min_quantity?: number;
  note?: string;
};

// ---------- 好日子:會員等級 / 點數 / 預約參訪 ----------
export type MembershipTier = {
  slug: string;
  name: string;
  price_yearly: number;
  rebate_rate: number; // 每消費 NT$100 累點數(%)
  perks: string[];
  sort: number;
  // Phase D:AI 翻譯的英文欄位,可能尚未翻譯(null)——渲染端一律 fallback 中文。
  name_en: string | null;
  perks_en: string[] | null;
};

export type PointsSource = "earn" | "redeem" | "expire" | "refund" | "manual_adjust" | "promo";

export type PointsLedgerEntry = {
  id: string;
  user_id: string;
  delta: number;
  source: PointsSource;
  source_ref_id: string | null;
  note: string | null;
  expires_at: string | null;
  created_at: string;
};

export type BookingStatus = "new" | "confirmed" | "done" | "cancelled";

export type Booking = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  visit_date: string | null;
  purpose: string | null;
  message: string | null;
  status: BookingStatus;
  created_at: string;
};

// ---------- 課程 ----------
// live = 報名型(有日期、可設名額、可免費);recorded = 線上預錄(一律付費、無名額)
export type CourseKind = "live" | "recorded";

export type EnrollmentType = "free" | "paid";

// 課程活動頁的常見問答。DB 存 jsonb 陣列(course_details.faq),
// CHECK 只保證「是陣列」,逐筆形狀由 server action 清洗後才寫入。
// q_en/a_en 未填 → 英文站 fallback 中文(localizeText 慣例)。
export type CourseFaqItem = {
  q: string;
  a: string;
  q_en?: string;
  a_en?: string;
};

// 與 products 一對一(product_id 同時是 PK 與 FK)
// ⚠️ migration 20260806000001_course_landing 新增的活動頁欄位一律 `text not null default ''`,
// 所以型別是 string(不是 string | null)——「沒填」是空字串,渲染端一律以 truthy 判斷是否整區不渲染。
export type CourseDetail = {
  product_id: string;
  course_kind: CourseKind;
  enrollment_type: EnrollmentType;
  instructor: string;
  outline: string;
  location: string;
  starts_at: string | null;
  ends_at: string | null;
  enroll_deadline: string | null;
  capacity: number | null; // null = 不限名額
  seats_taken: number;     // 唯讀:只能由 migration 內的 SQL function 異動
  created_at: string;
  updated_at: string;
  // ---- 活動宣傳頁欄位 ----
  subtitle: string;              // hero 副標語
  subtitle_en: string;
  pain_points: string;           // 痛點引入段落,以 \n\n 分段
  pain_points_en: string;
  benefits: string;              // 你會獲得什麼,一行一項
  benefits_en: string;
  outline_en: string;            // 課程大綱英文版
  location_en: string;
  instructor_title: string;      // 講師頭銜
  instructor_title_en: string;
  instructor_bio: string;        // 講師長介紹
  instructor_bio_en: string;
  instructor_photo_url: string;  // 單一網址,不是陣列
  fee_note: string;              // 費用補充說明
  fee_note_en: string;
  faq: CourseFaqItem[];
};

export type CourseLesson = {
  id: string;
  product_id: string;
  title: string;
  description: string;
  youtube_video_id: string; // 只存 11 碼 id,不存完整網址
  duration_seconds: number | null;
  is_preview: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type CourseEnrollment = {
  id: string;
  product_id: string;
  user_id: string;
  order_id: string | null;
  status: "reserved" | "confirmed" | "cancelled";
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  note: string;
  expires_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

export type CourseAccess = {
  id: string;
  user_id: string;
  product_id: string;
  source: "purchase" | "enrollment" | "manual";
  source_ref_id: string | null;
  note: string;
  granted_at: string;
  revoked_at: string | null;
};
