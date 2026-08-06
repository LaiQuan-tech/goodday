import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  formatTWD,
  formatPoints,
  formatDateTime,
  localizeText,
  localizeList,
  getCategoryLabel,
  getCourseKindLabel,
} from "@/lib/format";
import Placeholder, { gradientForId } from "@/components/Placeholder";
import ArtworkPurchaseSection from "@/components/ArtworkPurchaseSection";
import CourseEnrollSection from "@/components/CourseEnrollSection";
import QuickAddButton from "@/components/QuickAddButton";
import OpenChatButton from "@/components/OpenChatButton";
import { getLocale, getMessages } from "@/lib/i18n/server";
import type { CourseDetail, MembershipTier, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

// product.name/description 是 DB 內容,D phase 才翻譯;這裡只加 hreflang,
// 刻意不覆寫 title/description,zh 站沿用 root layout 的預設值,逐字不變。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return {
    alternates: {
      languages: {
        "zh-Hant-TW": `${baseUrl}/products/${slug}`,
        en: `${baseUrl}/en/products/${slug}`,
      },
    },
  };
}

// 課程資訊列(講師 / 時間 / 地點 / 截止 / 名額)共用排版
function CourseInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted-2">{label}</span>
      <span className="text-ink-soft">{value}</span>
    </div>
  );
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const locale = await getLocale();
  const messages = getMessages(locale);

  let product: Product | null = null;
  let tier: MembershipTier | null = null;
  let courseDetail: CourseDetail | null = null;
  let loggedIn = false;
  let enrolled = false;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle();
    product = data as Product | null;

    if (product?.product_type === "membership") {
      const tierSlug = (product.metadata as { tier_slug?: string })?.tier_slug;
      if (tierSlug) {
        const { data: tierData } = await supabase
          .from("membership_tiers")
          .select("*")
          .eq("slug", tierSlug)
          .maybeSingle();
        tier = tierData as MembershipTier | null;
      }
    }

    if (product?.product_type === "course") {
      const { data: detailData } = await supabase
        .from("course_details")
        .select("*")
        .eq("product_id", product.id)
        .maybeSingle();
      courseDetail = detailData as CourseDetail | null;

      // createClient() 只用來取登入身分,報名紀錄仍走 service role 查
      const authClient = await createClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      loggedIn = user != null;
      if (user) {
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
    }
  } catch {
    /* env 未設定 */
  }

  if (!product) notFound();

  const metadata = product.metadata as {
    tag?: string;
    medium?: string;
    gradient?: [string, string];
    duration?: string;
    duration_en?: string;
  };
  const gradient = metadata?.gradient ?? gradientForId(product.id);
  const displayName = localizeText(product.name, product.name_en, locale);
  const displayDescription = localizeText(product.description, product.description_en, locale);
  const displayDuration = localizeText(metadata?.duration ?? "", metadata?.duration_en, locale);

  // capacity 為 null 代表不限名額;有上限時顯示剩餘數(無插值機制,前後綴自行串接)
  const courseSeatsText = !courseDetail
    ? ""
    : courseDetail.capacity === null
      ? messages.courses.seatsUnlimited
      : courseDetail.seats_taken >= courseDetail.capacity
        ? messages.courses.seatsFull
        : `${messages.courses.seatsLeftPrefix}${courseDetail.capacity - courseDetail.seats_taken}${messages.courses.seatsLeftSuffix}`;
  const courseScheduleText = !courseDetail?.starts_at
    ? messages.courses.dateTba
    : courseDetail.ends_at
      ? `${formatDateTime(courseDetail.starts_at, locale)} – ${formatDateTime(courseDetail.ends_at, locale)}`
      : formatDateTime(courseDetail.starts_at, locale);

  return (
    <div className="lm-container py-12 sm:py-16">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-14">
        <Placeholder
          src={product.images?.[0]?.url}
          alt={displayName}
          gradient={gradient}
          label={metadata?.tag}
          sizes="(max-width: 1024px) 100vw, 50vw"
          priority
          className="aspect-square w-full"
        />

        <div className="flex flex-col">
          {product.category && (
            <span className="lm-caption text-[12px]">{getCategoryLabel(product.category, locale)}</span>
          )}
          <h1 className="mt-2 mb-1 font-serif text-[28px] font-normal text-ink sm:text-[34px]">
            {displayName}
          </h1>
          {metadata?.medium && (
            <span className="font-cormorant text-[15px] text-accent">{metadata.medium}</span>
          )}

          <p className="mt-6 whitespace-pre-wrap text-[15px] leading-[1.9] text-ink-soft">
            {displayDescription || messages.product.noDescription}
          </p>

          <div className="mt-8">
            {product.product_type === "artwork" && (
              <ArtworkPurchaseSection product={product} />
            )}

            {product.product_type === "journey" && (
              <div>
                {displayDuration && (
                  <div className="mb-1 text-[13px] text-muted-2">{displayDuration}</div>
                )}
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="font-cormorant text-[15px] text-accent">{messages.product.fromLabel}</span>
                  <span className="font-serif text-[28px] text-ink">{formatTWD(product.price, locale)}</span>
                </div>
                {product.points_price != null && (
                  <div className="mb-6 text-[13px] text-muted-2">
                    {messages.product.orPointsPrefix}{formatPoints(product.points_price, locale)}
                  </div>
                )}
                <QuickAddButton
                  product={product}
                  mode="journey"
                  unitPrice={product.price}
                  label={messages.product.journeyAddToCart}
                  addedLabel={messages.product.addedToCart}
                  className="iv-btn-primary w-full sm:w-auto"
                />
              </div>
            )}

            {product.product_type === "membership" && (
              <div>
                <div className="mb-5 font-serif text-[28px] text-ink">
                  {formatTWD(product.price, locale)}
                  <span className="text-[14px] text-muted-2">{messages.product.perYear}</span>
                </div>
                {tier && tier.perks.length > 0 && (
                  <div className="mb-6 flex flex-col gap-2.5 text-[14px] leading-[1.6] text-ink-soft">
                    {localizeList(tier.perks, tier.perks_en, locale).map((perk) => (
                      <div key={perk}>· {perk}</div>
                    ))}
                  </div>
                )}
                <QuickAddButton
                  product={product}
                  mode="membership"
                  unitPrice={product.price}
                  label={messages.product.membershipJoin}
                  addedLabel={messages.product.addedToCart}
                  className="iv-btn-primary w-full sm:w-auto"
                />
              </div>
            )}

            {product.product_type === "course" && courseDetail && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <span className="border border-line-2 bg-panel px-2.5 py-1 text-[11px] tracking-[0.1em] text-accent">
                    {getCourseKindLabel(courseDetail.course_kind, locale)}
                  </span>
                </div>
                <div className="mb-5 font-serif text-[28px] text-ink">
                  {courseDetail.enrollment_type === "free"
                    ? messages.courses.freeLabel
                    : formatTWD(product.price, locale)}
                </div>

                <div className="mb-6 flex flex-col gap-2 text-[14px] leading-[1.7]">
                  {courseDetail.instructor && (
                    <CourseInfoRow
                      label={messages.courses.instructorLabel}
                      value={courseDetail.instructor}
                    />
                  )}
                  {courseDetail.course_kind === "live" && (
                    <>
                      <CourseInfoRow
                        label={messages.courses.scheduleTitle}
                        value={courseScheduleText}
                      />
                      {courseDetail.location && (
                        <CourseInfoRow
                          label={messages.courses.locationLabel}
                          value={courseDetail.location}
                        />
                      )}
                      <CourseInfoRow
                        label={messages.courses.seatsTitle}
                        value={courseSeatsText}
                      />
                    </>
                  )}
                  {courseDetail.enroll_deadline && (
                    <CourseInfoRow
                      label={messages.courses.deadlineLabel}
                      value={formatDateTime(courseDetail.enroll_deadline, locale)}
                    />
                  )}
                </div>

                {courseDetail.outline && (
                  <div className="mb-6">
                    <h2 className="mb-2 font-serif text-[17px] text-ink">
                      {messages.courses.outlineTitle}
                    </h2>
                    <p className="whitespace-pre-wrap text-[14px] leading-[1.9] text-ink-soft">
                      {courseDetail.outline}
                    </p>
                  </div>
                )}

                <CourseEnrollSection
                  productId={product.id}
                  slug={product.slug}
                  name={product.name}
                  nameEn={product.name_en}
                  price={product.price}
                  enrollmentType={courseDetail.enrollment_type}
                  capacity={courseDetail.capacity}
                  seatsTaken={courseDetail.seats_taken}
                  closed={
                    courseDetail.enroll_deadline != null &&
                    new Date(courseDetail.enroll_deadline).getTime() < Date.now()
                  }
                  loggedIn={loggedIn}
                  enrolled={enrolled}
                />
              </div>
            )}
          </div>

          <div className="mt-8 border border-line bg-panel p-5 text-sm leading-[1.8] text-ink-soft">
            {messages.product.customNeedsPrefix}
            <span className="mx-1 font-semibold text-accent">{messages.product.aiAdvisor}</span>
            {messages.product.customNeedsSuffix}
            <div className="mt-3">
              <OpenChatButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
