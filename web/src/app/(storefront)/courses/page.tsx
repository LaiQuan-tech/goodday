import Link from "next/link";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  formatTWD,
  formatDate,
  localizeText,
  getCourseKindLabel,
} from "@/lib/format";
import Placeholder, { gradientForId } from "@/components/Placeholder";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { localeHref } from "@/lib/i18n/href";
import type { Locale } from "@/lib/i18n/config";
import type { Messages } from "@/lib/i18n/messages";
import type { CourseDetail, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const messages = getMessages(await getLocale());
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return {
    title: messages.courses.title,
    description: messages.courses.metaDescription,
    alternates: {
      languages: {
        "zh-Hant-TW": `${baseUrl}/courses`,
        en: `${baseUrl}/en/courses`,
      },
    },
  };
}

// PostgREST 一對一 embed 通常回物件,關聯判定不同時可能回陣列,兩種都吃
// (與 admin/courses/page.tsx 的 pickDetail 同一處理方式)
type CourseRow = Product & { course_details: CourseDetail | CourseDetail[] | null };

type Course = { product: Product; detail: CourseDetail };

function pickDetail(row: CourseRow): CourseDetail | null {
  const d = row.course_details;
  if (!d) return null;
  return Array.isArray(d) ? d[0] ?? null : d;
}

async function getCourses(): Promise<Course[]> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("products")
      .select("*, course_details(*)")
      .eq("status", "active")
      .eq("product_type", "course")
      .order("sort_order");
    // 沒有 course_details 的課程無法判斷類型與名額,前台一律不曝光
    return ((data ?? []) as CourseRow[])
      .map((row) => ({ product: row as Product, detail: pickDetail(row) }))
      .filter((c): c is Course => c.detail !== null);
  } catch {
    return [];
  }
}

// starts_at 由近到遠;未排定日期的課排最後
function byStartsAt(a: Course, b: Course) {
  const ta = a.detail.starts_at ? new Date(a.detail.starts_at).getTime() : Infinity;
  const tb = b.detail.starts_at ? new Date(b.detail.starts_at).getTime() : Infinity;
  return ta - tb;
}

function CourseCard({
  course,
  locale,
  messages,
}: {
  course: Course;
  locale: Locale;
  messages: Messages;
}) {
  const { product, detail } = course;
  const t = messages.courses;
  const displayName = localizeText(product.name, product.name_en, locale);
  const isLive = detail.course_kind === "live";

  const seatsText =
    detail.capacity === null
      ? t.seatsUnlimited
      : detail.seats_taken >= detail.capacity
        ? t.seatsFull
        : `${t.seatsLeftPrefix}${detail.capacity - detail.seats_taken}${t.seatsLeftSuffix}`;

  return (
    <Link
      href={localeHref(`/courses/${product.slug}`, locale)}
      className="group block"
    >
      <Placeholder
        src={product.images?.[0]?.url}
        alt={displayName}
        gradient={gradientForId(product.id)}
        label={getCourseKindLabel(detail.course_kind, locale)}
        className="h-56 sm:h-64"
      />
      <div className="mt-4 flex items-center gap-2">
        <span className="border border-line-2 bg-panel px-2.5 py-1 text-[11px] tracking-[0.1em] text-accent">
          {getCourseKindLabel(detail.course_kind, locale)}
        </span>
        {isLive && (
          <span className="text-[12.5px] text-muted-2">
            {t.startsAtLabel}{" "}
            {detail.starts_at ? formatDate(detail.starts_at, locale) : t.dateTba}
          </span>
        )}
      </div>
      <h3 className="mt-2.5 font-serif text-[19px] text-ink">{displayName}</h3>
      {detail.instructor && (
        <div className="mt-1 text-[12.5px] text-muted-2">
          {t.instructorLabel} · {detail.instructor}
        </div>
      )}
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="font-serif text-[18px] text-ink">
          {detail.enrollment_type === "free" ? t.freeLabel : formatTWD(product.price, locale)}
        </span>
        {isLive && <span className="text-[12.5px] text-muted-2">{seatsText}</span>}
      </div>
    </Link>
  );
}

export default async function CoursesPage() {
  const locale = await getLocale();
  const messages = getMessages(locale);
  const t = messages.courses;
  const courses = await getCourses();

  const live = courses.filter((c) => c.detail.course_kind === "live").sort(byStartsAt);
  const recorded = courses.filter((c) => c.detail.course_kind === "recorded");

  return (
    <div>
      <div className="lm-container pt-16 pb-6 sm:pt-20">
        <div className="lm-eyebrow text-[20px]">{t.eyebrow}</div>
        <h1 className="mt-3.5 mb-4 font-serif text-[27px] font-normal tracking-[0.04em] text-ink sm:text-[52px]">
          {t.title}
        </h1>
        <p className="max-w-140 text-[15.5px] leading-[2] text-ink-soft">{t.desc}</p>
      </div>

      <div className="lm-container pb-16 sm:pb-24">
        {courses.length === 0 ? (
          <div className="iv-card mt-8 text-center text-ink-soft">{t.emptyState}</div>
        ) : (
          <>
            <section className="mt-10">
              <h2 className="font-serif text-[22px] font-normal text-ink sm:text-[28px]">
                {t.liveTitle}
              </h2>
              <p className="mt-2 text-[14px] text-ink-soft">{t.liveDesc}</p>
              {live.length === 0 ? (
                <div className="iv-card mt-6 text-center text-ink-soft">{t.liveEmpty}</div>
              ) : (
                <div className="mt-7 grid grid-cols-1 gap-x-7 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                  {live.map((c) => (
                    <CourseCard
                      key={c.product.id}
                      course={c}
                      locale={locale}
                      messages={messages}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="mt-14 sm:mt-16">
              <h2 className="font-serif text-[22px] font-normal text-ink sm:text-[28px]">
                {t.recordedTitle}
              </h2>
              <p className="mt-2 text-[14px] text-ink-soft">{t.recordedDesc}</p>
              {recorded.length === 0 ? (
                <div className="iv-card mt-6 text-center text-ink-soft">{t.recordedEmpty}</div>
              ) : (
                <div className="mt-7 grid grid-cols-1 gap-x-7 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                  {recorded.map((c) => (
                    <CourseCard
                      key={c.product.id}
                      course={c}
                      locale={locale}
                      messages={messages}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
