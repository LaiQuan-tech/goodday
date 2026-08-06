import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  formatTWD,
  formatDate,
  formatDateTime,
  localizeText,
  getCourseKindLabel,
} from "@/lib/format";
import Placeholder, { gradientForId } from "@/components/Placeholder";
import CourseEnrollSection from "@/components/CourseEnrollSection";
import CourseStickyCta from "@/components/CourseStickyCta";
import { getLocale, getMessages } from "@/lib/i18n/server";
import type { CourseDetail, CourseFaqItem, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

// 課程是「活動」不是「商品」,所以獨立一頁做成宣傳頁,而不是掛在通用商品詳情頁的分支。
// /products/<slug> 對課程一律 301 轉到這裡(見 products/[slug]/page.tsx)。
//
// 全頁八個區塊,對應欄位為空的區塊「整區不渲染」——經營者只填得完前三區時,
// 頁面仍要看起來完整,不能留一排空標題。

type Course = { product: Product; detail: CourseDetail };

// PostgREST 一對一 embed 通常回物件,關聯判定不同時可能回陣列,兩種都吃
// (與 courses/page.tsx 的 pickDetail 同一處理方式)
type CourseRow = Product & { course_details: CourseDetail | CourseDetail[] | null };

async function getCourse(slug: string): Promise<Course | null> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("products")
      .select("*, course_details(*)")
      .eq("slug", slug)
      .eq("product_type", "course")
      .eq("status", "active")
      .maybeSingle();
    if (!data) return null;
    const row = data as CourseRow;
    const detail = Array.isArray(row.course_details)
      ? row.course_details[0] ?? null
      : row.course_details;
    // 沒有 course_details 就判斷不了課程類型與名額,前台一律不曝光
    if (!detail) return null;
    return { product: row as Product, detail };
  } catch {
    return null; // env 未設定
  }
}

// 一行一項(大綱、你會獲得什麼)
function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 空一行分段(痛點引入)
function toParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function serial(index: number) {
  return String(index + 1).padStart(2, "0");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getLocale();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const languages = {
    "zh-Hant-TW": `${baseUrl}/courses/${slug}`,
    en: `${baseUrl}/en/courses/${slug}`,
  };

  const course = await getCourse(slug);
  if (!course) return { alternates: { languages } };

  const { product, detail } = course;
  const title = localizeText(product.name, product.name_en, locale);
  const subtitle = localizeText(detail.subtitle, detail.subtitle_en, locale);
  const description = (subtitle || localizeText(product.description, product.description_en, locale))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  // 活動頁被分享到 LINE／FB 的機率極高,主視覺一定要給 OG 圖
  const heroImage = product.images?.[0]?.url;

  return {
    title,
    description,
    alternates: { languages },
    openGraph: {
      title,
      description,
      ...(heroImage ? { images: [heroImage] } : {}),
    },
  };
}

export default async function CourseLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const locale = await getLocale();
  const messages = getMessages(locale);
  const t = messages.courses;

  const course = await getCourse(slug);
  if (!course) notFound();
  const { product, detail } = course;

  // 登入身分與報名狀態(照抄原商品詳情頁:createClient() 只取身分,報名紀錄走 service role)
  let loggedIn = false;
  let enrolled = false;
  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    loggedIn = user != null;
    if (user) {
      const supabase = createAdminClient();
      // 同一人同一堂課只會有一筆非 cancelled 的報名(DB 唯一索引保證)
      const { data: enrollment } = await supabase
        .from("course_enrollments")
        .select("id")
        .eq("product_id", product.id)
        .eq("user_id", user.id)
        .neq("status", "cancelled")
        .maybeSingle();
      enrolled = enrollment != null;
    }
  } catch {
    /* env 未設定 */
  }

  const isLive = detail.course_kind === "live";
  const displayName = localizeText(product.name, product.name_en, locale);
  const subtitle = localizeText(detail.subtitle, detail.subtitle_en, locale);
  const description = localizeText(product.description, product.description_en, locale);
  const painParagraphs = toParagraphs(
    localizeText(detail.pain_points, detail.pain_points_en, locale)
  );
  const benefits = toLines(localizeText(detail.benefits, detail.benefits_en, locale));
  const outline = toLines(localizeText(detail.outline, detail.outline_en, locale));
  const location = localizeText(detail.location, detail.location_en, locale);
  const instructorTitle = localizeText(
    detail.instructor_title,
    detail.instructor_title_en,
    locale
  );
  const instructorBio = localizeText(detail.instructor_bio, detail.instructor_bio_en, locale);
  const feeNote = localizeText(detail.fee_note, detail.fee_note_en, locale);
  // faq 是 jsonb,DB 的 CHECK 只保證「是陣列」,逐筆再擋一次沒有問題文字的髒資料
  const faq: CourseFaqItem[] = Array.isArray(detail.faq)
    ? detail.faq.filter((item) => item && typeof item.q === "string" && item.q.trim())
    : [];

  const priceText =
    detail.enrollment_type === "free" ? t.freeLabel : formatTWD(product.price, locale);

  // capacity 為 null 代表不限名額;有上限時顯示剩餘數(無插值機制,前後綴自行串接)
  const seatsText =
    detail.capacity === null
      ? t.seatsUnlimited
      : detail.seats_taken >= detail.capacity
        ? t.seatsFull
        : `${t.seatsLeftPrefix}${detail.capacity - detail.seats_taken}${t.seatsLeftSuffix}`;

  const scheduleText = !detail.starts_at
    ? t.dateTba
    : detail.ends_at
      ? `${formatDateTime(detail.starts_at, locale)} – ${formatDateTime(detail.ends_at, locale)}`
      : formatDateTime(detail.starts_at, locale);

  const heroSrc = product.images?.[0]?.url ?? "";
  const heroDateText = isLive
    ? detail.starts_at
      ? formatDate(detail.starts_at, locale)
      : t.dateTba
    : "";

  // 時間／地點／費用格:預錄課程沒有時間、地點與名額的概念,那三格整格不出現
  const infoCells: { label: string; value: string }[] = [];
  if (isLive) {
    infoCells.push({ label: t.scheduleTitle, value: scheduleText });
    if (location) infoCells.push({ label: t.locationLabel, value: location });
    infoCells.push({ label: t.seatsTitle, value: seatsText });
  }
  if (detail.enroll_deadline) {
    infoCells.push({
      label: t.deadlineLabel,
      value: formatDateTime(detail.enroll_deadline, locale),
    });
  }
  infoCells.push({ label: t.feeLabel, value: priceText });

  return (
    // pb-24 讓最底部的內容不被常駐報名列蓋住
    <div className="pb-24">
      {/* ===== 1. Hero 全幅主視覺 ===== */}
      <section className="relative h-[420px] overflow-hidden bg-[#e4d6bd] sm:h-[560px] lg:h-[620px]">
        <Placeholder
          src={heroSrc}
          alt={displayName}
          // 沒有主視覺時退回依 id 決定的漸層;有圖時不需要底色(圖片本身鋪滿)
          gradient={heroSrc ? null : gradientForId(product.id)}
          sizes="100vw"
          priority
          className="absolute inset-0"
        />
        {/*
          遮罩比 journeys 的兩段式多一段:那裡疊層只有一行 H1,這裡要疊
          類型 chip + 標題 + 副標 + 日期地點 + CTA,頂部也得壓暗才讀得到。
          沒有主視覺時底色是偏米白的漸層,要壓更暗才有足夠對比。

          ⚠️ 用明確停點而不是 from/via/to:Tailwind 的 via 固定落在 50%,而文字大約
          佔據 hero 的 42%~90%,標題頂端剛好落在最淡的那一段。實測高彩度插畫
          (JSJ 體驗講座那張)在 40% 暗度下完全讀不到。這裡把暗度在 62% 處就拉到
          82%,上緣仍保持通透讓主視覺看得出來。
        */}
        <div
          className={`absolute inset-0 flex flex-col justify-end px-6 py-10 sm:px-16 sm:py-15 ${
            heroSrc
              ? "bg-[linear-gradient(to_bottom,rgba(46,37,25,0.28)_0%,rgba(46,37,25,0.42)_28%,rgba(46,37,25,0.82)_62%,rgba(46,37,25,0.93)_100%)]"
              : "bg-[linear-gradient(to_bottom,rgba(46,37,25,0.45)_0%,rgba(46,37,25,0.60)_35%,rgba(46,37,25,0.85)_70%,rgba(46,37,25,0.93)_100%)]"
          }`}
        >
          <div className="lm-container !px-0">
            <span className="inline-flex border border-gold-bright/50 px-2.5 py-1 text-[11px] tracking-[0.1em] text-gold-bright">
              {getCourseKindLabel(detail.course_kind, locale)}
            </span>
            <h1 className="mt-4 max-w-180 font-serif text-[27px] font-normal leading-[1.35] tracking-[0.04em] text-cream-text [text-shadow:0_2px_18px_rgba(20,15,8,0.75)] sm:text-[44px] lg:text-[54px]">
              {displayName}
            </h1>
            {subtitle && (
              <p className="mt-4 max-w-150 text-[15px] leading-[1.9] text-cream-soft-2 [text-shadow:0_1px_12px_rgba(20,15,8,0.7)] sm:text-[17px]">
                {subtitle}
              </p>
            )}
            {(heroDateText || (isLive && location)) && (
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-cream-soft [text-shadow:0_1px_12px_rgba(20,15,8,0.7)] sm:text-[14px]">
                {heroDateText && <span>{heroDateText}</span>}
                {isLive && location && <span>{location}</span>}
              </div>
            )}
            <div className="mt-8">
              {/* 深底上的 iv-btn-primary 本身也是深色,加一條金線讓按鈕邊界讀得出來 */}
              <a href="#enroll" className="iv-btn-primary border border-gold-bright/60">
                {t.heroCta}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ===== 2. 痛點引入 ===== */}
      {painParagraphs.length > 0 && (
        <section className="bg-panel">
          <div className="lm-container-narrow py-16 sm:py-24">
            <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
              {t.painTitle}
            </h2>
            <div className="mt-8 flex max-w-160 flex-col gap-5">
              {painParagraphs.map((paragraph, index) => (
                <p
                  key={index}
                  className="whitespace-pre-wrap text-[15px] leading-[2.05] text-ink-soft sm:text-[16px]"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== 3. 課程內容 + 你會獲得什麼 ===== */}
      {(description || benefits.length > 0) && (
        <section className="lm-container py-16 sm:py-20">
          <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
            {t.contentTitle}
          </h2>
          {description && (
            <p className="mt-7 max-w-160 whitespace-pre-wrap text-[15px] leading-[2.05] text-ink-soft sm:text-[16px]">
              {description}
            </p>
          )}
          {benefits.length > 0 && (
            <>
              <div className="mt-12 lm-hairline" />
              <h3 className="mt-12 font-serif text-[21px] font-normal text-ink sm:text-[24px]">
                {t.benefitsTitle}
              </h3>
              <div className="mt-8 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
                {benefits.map((benefit, index) => (
                  <div key={index} className="border-t border-line pt-4">
                    <div className="lm-caption text-[12px]">{serial(index)}</div>
                    <p className="mt-2 text-[15px] leading-[1.9] text-ink-soft">{benefit}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ===== 4. 課程大綱 ===== */}
      {outline.length > 0 && (
        <section className="lm-container-narrow py-16 sm:py-20">
          <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
            {t.outlineTitle}
          </h2>
          <div className="mt-8 border-t border-line">
            {outline.map((item, index) => (
              <div
                key={index}
                className="grid grid-cols-[auto_1fr] gap-5 border-b border-line py-5"
              >
                <span className="font-cormorant text-[22px] leading-none text-accent">
                  {serial(index)}
                </span>
                <p className="text-[15px] leading-[1.9] text-ink-soft">{item}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ===== 5. 講師 ===== */}
      {(detail.instructor || instructorTitle || instructorBio) && (
        <section className="bg-ink-deep">
          <div className="lm-container-narrow py-16 sm:py-24">
            {/* lm-caption 本身是深金色(給淺底用),深色區塊要換成亮金才看得見。
                Tailwind v4 的 utilities layer 排在 components 之後,直接覆蓋得掉。 */}
            <div className="lm-caption text-[12px] text-gold-bright">
              {t.instructorSectionTitle}
            </div>
            {/* 沒有照片時整格不渲染,文字直接佔滿(留一個空的 280px 欄會很像圖破掉) */}
            <div
              className={`mt-8 gap-12 ${
                detail.instructor_photo_url ? "grid sm:grid-cols-[280px_1fr]" : ""
              }`}
            >
              {detail.instructor_photo_url && (
                <Placeholder
                  src={detail.instructor_photo_url}
                  alt={detail.instructor}
                  sizes="(max-width: 640px) 100vw, 280px"
                  className="aspect-[3/4] w-full"
                />
              )}
              <div>
                {detail.instructor && (
                  <h2 className="font-serif text-[26px] font-normal text-cream-text sm:text-[32px]">
                    {detail.instructor}
                  </h2>
                )}
                {instructorTitle && (
                  <div className="mt-2 font-cormorant text-[17px] text-gold-bright sm:text-[19px]">
                    {instructorTitle}
                  </div>
                )}
                {instructorBio && (
                  <p className="mt-6 max-w-160 whitespace-pre-wrap text-[15px] leading-[2.05] text-cream-soft sm:text-[16px]">
                    {instructorBio}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ===== 6. 時間 / 地點 / 費用 ===== */}
      <section className="lm-container py-16 sm:py-20">
        <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
          {t.infoTitle}
        </h2>
        {/* gap-px + 底色 = 一格一格之間只有一條髮絲線,不用逐格畫框 */}
        <div className="mt-8 grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
          {infoCells.map((cell) => (
            <div key={cell.label} className="bg-paper p-6 sm:p-8">
              <div className="lm-caption text-[12px]">{cell.label}</div>
              <div className="mt-3 font-serif text-[19px] leading-[1.6] text-ink">
                {cell.value}
              </div>
            </div>
          ))}
          {feeNote && (
            <div className="bg-paper p-6 sm:p-8">
              <div className="lm-caption text-[12px]">{t.feeNoteLabel}</div>
              {/* 補充說明通常是兩三句話,用內文級距而不是 19px 標題級距才讀得順 */}
              <p className="mt-3 whitespace-pre-wrap text-[14.5px] leading-[1.9] text-ink-soft">
                {feeNote}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ===== 7. 報名 ===== */}
      {/* scroll-mt-24:錨點跳過來時留出固定表頭的高度,不然標題會被壓在表頭下面 */}
      <section id="enroll" className="scroll-mt-24 bg-panel">
        <div className="lm-container-narrow py-16 sm:py-20">
          <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
            {t.enrollTitle}
          </h2>
          <div className="mt-4 font-serif text-[28px] text-ink">{priceText}</div>
          <div className="mt-7">
            <CourseEnrollSection
              productId={product.id}
              slug={product.slug}
              name={product.name}
              nameEn={product.name_en}
              price={product.price}
              enrollmentType={detail.enrollment_type}
              capacity={detail.capacity}
              seatsTaken={detail.seats_taken}
              closed={
                detail.enroll_deadline != null &&
                new Date(detail.enroll_deadline).getTime() < Date.now()
              }
              loggedIn={loggedIn}
              enrolled={enrolled}
            />
          </div>
        </div>
      </section>

      {/* ===== 8. 常見問答 ===== */}
      {faq.length > 0 && (
        <section className="lm-container-narrow py-16 sm:py-20">
          <h2 className="font-serif text-[26px] font-normal text-ink sm:text-[34px]">
            {t.faqTitle}
          </h2>
          {/* 原生 <details>/<summary>:零套件、鍵盤與讀屏原生可用、SSR 就是展開得開的內容 */}
          <div className="mt-8 border-t border-line">
            {faq.map((item, index) => {
              const answer = localizeText(item.a ?? "", item.a_en, locale);
              return (
                <details key={index} className="group border-b border-line py-4">
                  {/* list-none + ::-webkit-details-marker 關掉原生三角形(Safari 只認後者),
                      改用右側的 + 號當展開提示,開啟時轉 45° 變成 ×。純 CSS,零套件。 */}
                  <summary className="flex cursor-pointer list-none items-start gap-3 text-[15.5px] leading-[1.7] text-ink [&::-webkit-details-marker]:hidden">
                    <span className="font-cormorant text-[17px] text-accent">
                      {serial(index)}
                    </span>
                    <span className="flex-1">{localizeText(item.q, item.q_en, locale)}</span>
                    <span
                      aria-hidden
                      className="shrink-0 font-cormorant text-[19px] leading-none text-accent transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  {answer && (
                    <p className="mt-3 whitespace-pre-wrap pl-9 text-[15px] leading-[1.95] text-ink-soft">
                      {answer}
                    </p>
                  )}
                </details>
              );
            })}
          </div>
        </section>
      )}

      <CourseStickyCta
        name={displayName}
        dateText={heroDateText}
        priceText={priceText}
        ctaLabel={t.stickyEnroll}
      />
    </div>
  );
}
