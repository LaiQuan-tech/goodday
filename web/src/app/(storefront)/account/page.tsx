import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPointsBalance, getPointsLedger, getMemberTier } from "@/lib/points";
import {
  formatDate,
  formatDateTime,
  formatTWD,
  formatPoints,
  localizeText,
  getOrderStatusLabel,
  getQuoteStatusLabel,
  getEnrollmentStatusLabel,
} from "@/lib/format";
import ProfileForm from "@/components/ProfileForm";
import LogoutButton from "@/components/LogoutButton";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { localeHref } from "@/lib/i18n/href";
import type { CourseEnrollment, Order, Profile, Quote } from "@/lib/types";

// PostgREST 的 products embed 通常回物件,關聯判定不同時可能回陣列,兩種都吃
type EnrolledProduct = { slug: string; name: string; name_en: string | null };
type EnrollmentRow = CourseEnrollment & {
  products: EnrolledProduct | EnrolledProduct[] | null;
};

function pickProduct(row: EnrollmentRow): EnrolledProduct | null {
  const p = row.products;
  if (!p) return null;
  return Array.isArray(p) ? p[0] ?? null : p;
}

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const messages = getMessages(await getLocale());
  return { title: messages.account.title };
}

export default async function AccountPage() {
  const locale = await getLocale();
  const messages = getMessages(locale);
  const t = messages.account;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/account");

  const admin = createAdminClient();
  const [
    { data: profile },
    { data: orders },
    { data: quotes },
    { data: enrollments },
    points,
    ledger,
    tier,
  ] = await Promise.all([
    admin.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    admin
      .from("orders")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
    admin
      .from("quotes")
      .select("*")
      .eq("user_id", user.id)
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(10),
    admin
      .from("course_enrollments")
      .select("*, products(slug, name, name_en)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
    getPointsBalance(user.id),
    getPointsLedger(user.id, { limit: 8 }),
    getMemberTier(user.id),
  ]);

  const typedProfile = profile as Profile | null;
  const typedOrders = (orders ?? []) as Order[];
  const typedQuotes = (quotes ?? []) as Quote[];
  const typedEnrollments = (enrollments ?? []) as EnrollmentRow[];

  // 開課日期在 course_details(products 之下再一層),另外查一次比巢狀 embed 穩
  const courseStartsAt = new Map<string, string | null>();
  if (typedEnrollments.length > 0) {
    const { data: details } = await admin
      .from("course_details")
      .select("product_id, starts_at")
      .in(
        "product_id",
        typedEnrollments.map((e) => e.product_id)
      );
    for (const d of (details ?? []) as { product_id: string; starts_at: string | null }[]) {
      courseStartsAt.set(d.product_id, d.starts_at);
    }
  }

  return (
    <div className="lm-container max-w-190 py-10 sm:py-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-normal text-ink sm:text-[32px]">{t.title}</h1>
          <p className="mt-1 text-sm text-ink-soft">{user.email}</p>
        </div>
        <LogoutButton locale={locale} />
      </div>

      {/* 會員等級與點數 */}
      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="border border-gold bg-ink-deep p-6 text-panel">
          <div className="lm-caption text-[12px]">Membership</div>
          <div className="mt-2 font-serif text-[24px]">{tier?.name ?? t.notMember}</div>
          {tier ? (
            <p className="mt-2 text-[13px] text-cream-soft">
              {t.tierRatePrefix}{tier.rebate_rate}{t.tierRateSuffix}
            </p>
          ) : (
            <Link href={localeHref("/membership", locale)} className="mt-3 inline-block text-[13px] tracking-[0.06em] text-gold-bright border-b border-gold pb-0.5">
              {t.learnMembership}
            </Link>
          )}
        </div>
        <div className="border border-line bg-card p-6">
          <div className="lm-caption text-[12px]">Points Balance</div>
          <div className="mt-2 font-cormorant text-[34px] text-gold">
            {points.balance.toLocaleString(locale === "en" ? "en-US" : "zh-TW")}
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">
            {points.expiringSoon > 0
              ? `${t.pointsExpiringPrefix}${formatPoints(points.expiringSoon, locale)}${t.pointsExpiringSuffix}`
              : t.pointsNoneExpiring}
          </p>
        </div>
      </section>

      {/* 點數明細 */}
      {ledger.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-serif text-lg text-ink">{t.pointsHistoryTitle}</h2>
          <div className="iv-card divide-y divide-line !p-0">
            {ledger.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
                <div>
                  <div className="text-ink">
                    {t.pointsSource[entry.source as keyof typeof t.pointsSource] ?? entry.source}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-2">{formatDateTime(entry.created_at, locale)}</div>
                </div>
                <div className={`font-cormorant text-[17px] ${entry.delta >= 0 ? "text-accent" : "text-ink-soft"}`}>
                  {entry.delta >= 0 ? "+" : ""}
                  {entry.delta.toLocaleString(locale === "en" ? "en-US" : "zh-TW")}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 訂單 */}
      <section className="mt-8">
        <h2 className="mb-3 font-serif text-lg text-ink">{t.ordersTitle}</h2>
        {typedOrders.length === 0 ? (
          <div className="iv-card flex items-center justify-between text-sm text-ink-soft">
            <span>{t.ordersEmpty}</span>
            <Link href={localeHref("/gallery", locale)} className="font-semibold text-accent">
              {t.goBrowse}
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {typedOrders.map((o) => (
              <Link
                key={o.id}
                href={localeHref(`/orders/${o.public_token}`, locale)}
                className="iv-card flex items-center justify-between gap-3 !p-4 transition-colors hover:border-gold"
              >
                <div>
                  <div className="font-semibold text-ink">{o.order_no}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">{formatDate(o.created_at, locale)}</div>
                </div>
                <div className="text-right">
                  <div className="font-serif text-ink">{formatTWD(o.total, locale)}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {getOrderStatusLabel(o.status, locale)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 課程 */}
      <section className="mt-8">
        <h2 className="mb-3 font-serif text-lg text-ink">{t.coursesTitle}</h2>
        {typedEnrollments.length === 0 ? (
          <div className="iv-card flex items-center justify-between text-sm text-ink-soft">
            <span>{t.coursesEmpty}</span>
            <Link href={localeHref("/courses", locale)} className="font-semibold text-accent">
              {t.goCourses}
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {typedEnrollments.map((e) => {
              const p = pickProduct(e);
              if (!p) return null;
              const startsAt = courseStartsAt.get(e.product_id) ?? null;
              return (
                <Link
                  key={e.id}
                  href={localeHref(`/products/${p.slug}`, locale)}
                  className="iv-card flex items-center justify-between gap-3 !p-4 transition-colors hover:border-gold"
                >
                  <div>
                    <div className="font-semibold text-ink">
                      {localizeText(p.name, p.name_en, locale)}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-soft">
                      {startsAt ? formatDate(startsAt, locale) : t.courseDateTba}
                    </div>
                  </div>
                  <div className="text-right text-xs text-ink-soft">
                    {getEnrollmentStatusLabel(e.status, locale)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* 報價 */}
      {typedQuotes.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-serif text-lg text-ink">{t.quotesTitle}</h2>
          <div className="space-y-3">
            {typedQuotes.map((q) => (
              <Link
                key={q.id}
                href={localeHref(`/quote/${q.public_token}`, locale)}
                className="iv-card flex items-center justify-between gap-3 !p-4 transition-colors hover:border-gold"
              >
                <div>
                  <div className="font-semibold text-ink">{q.quote_no}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">{formatDate(q.created_at, locale)}</div>
                </div>
                <div className="text-right">
                  <div className="font-serif text-ink">{formatTWD(q.total, locale)}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {getQuoteStatusLabel(q.status, locale)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 個人資料 */}
      <section className="mt-8">
        <h2 className="mb-3 font-serif text-lg text-ink">{t.profileTitle}</h2>
        <ProfileForm
          initial={{
            name: typedProfile?.name ?? "",
            phone: typedProfile?.phone ?? "",
            line_id: typedProfile?.line_id ?? "",
          }}
        />
      </section>
    </div>
  );
}
