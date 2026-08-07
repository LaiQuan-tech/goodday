"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cartSubtotal, clearCart, isPhysicalItem, readCart, type CartItem } from "@/lib/cart";
import { formatTWD, getPurchaseModeLabel, localizeText } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/context";
import { localeHref } from "@/lib/i18n/href";
import type { CompanyProfile, ShippingConfig } from "@/lib/settings";

const TAIWAN_COUNTIES = [
  "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣",
  "台中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣",
  "台南市", "高雄市", "屏東縣",
  "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣",
];

// 收件地址一律是台灣國內配送,縣市 <option value> 必須維持中文(後端運費計算、訂單、
// 出貨標籤都比對這個值,見下面 200 行左右的 order 建立邏輯)——這裡只把「顯示給使用者看」
// 的文字依 locale 換成英文,value 不變,不影響任何既有邏輯。
const TAIWAN_COUNTY_EN: Record<string, string> = {
  "台北市": "Taipei City",
  "新北市": "New Taipei City",
  "基隆市": "Keelung City",
  "桃園市": "Taoyuan City",
  "新竹市": "Hsinchu City",
  "新竹縣": "Hsinchu County",
  "苗栗縣": "Miaoli County",
  "台中市": "Taichung City",
  "彰化縣": "Changhua County",
  "南投縣": "Nantou County",
  "雲林縣": "Yunlin County",
  "嘉義市": "Chiayi City",
  "嘉義縣": "Chiayi County",
  "台南市": "Tainan City",
  "高雄市": "Kaohsiung City",
  "屏東縣": "Pingtung County",
  "宜蘭縣": "Yilan County",
  "花蓮縣": "Hualien County",
  "台東縣": "Taitung County",
  "澎湖縣": "Penghu County",
  "金門縣": "Kinmen County",
  "連江縣": "Lienchiang County",
};

const PHONE_RE = /^09\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARRIER_RE = /^\/[0-9A-Z.+-]{7}$/;
const TAX_ID_RE = /^\d{8}$/;

export default function CheckoutForm({
  isLoggedIn,
  pointsBalance,
  company,
  shippingConfig,
  cardPaymentAvailable,
}: {
  isLoggedIn: boolean;
  pointsBalance: number;
  company: CompanyProfile;
  shippingConfig: ShippingConfig;
  cardPaymentAvailable: boolean;
}) {
  const router = useRouter();
  const { locale, messages } = useTranslations();
  const t = messages.checkout;
  const [items, setItems] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pointsInput, setPointsInput] = useState("0");
  const idempotencyKeyRef = useRef<string | null>(null);

  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  const [note, setNote] = useState("");
  const [shippingMethod, setShippingMethod] = useState<"home" | "pickup">("home");
  const [address, setAddress] = useState({ county: "", district: "", postal: "", detail: "" });
  const [invoiceType, setInvoiceType] = useState<"personal" | "company">("personal");
  const [carrier, setCarrier] = useState("");
  const [taxId, setTaxId] = useState("");
  const [companyTitle, setCompanyTitle] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"bank_transfer" | "cod" | "card">(
    "bank_transfer"
  );

  useEffect(() => {
    setItems(readCart());
    setReady(true);
    // 已登入會員自動帶入資料
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("name, email, phone")
        .eq("id", data.user.id)
        .maybeSingle();
      setContact((f) => ({
        name: f.name || profile?.name || "",
        email: f.email || profile?.email || data.user?.email || "",
        phone: f.phone || profile?.phone || "",
      }));
    });
  }, []);

  const subtotal = cartSubtotal(items);
  const maxRedeemable = Math.max(0, Math.min(pointsBalance, subtotal));
  const pointsUsed = Math.max(0, Math.min(maxRedeemable, Number(pointsInput) || 0));

  // 購物車全為非實體(journey/membership)時不顯示收件區塊、不計運費
  const hasPhysical = useMemo(() => items.some(isPhysicalItem), [items]);
  const effectiveShippingMethod = hasPhysical ? shippingMethod : "none";
  const physicalSubtotal = useMemo(
    () => cartSubtotal(items.filter(isPhysicalItem)),
    [items]
  );
  const shippingFee =
    !hasPhysical || effectiveShippingMethod === "pickup"
      ? 0
      : physicalSubtotal >= shippingConfig.free_threshold_home
        ? 0
        : shippingConfig.fee_home;

  const total = Math.max(0, subtotal + shippingFee - pointsUsed);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!contact.name.trim()) e.name = t.errorName;
    if (!EMAIL_RE.test(contact.email.trim())) e.email = t.errorEmail;
    if (!PHONE_RE.test(contact.phone.trim())) e.phone = t.errorPhone;

    if (hasPhysical && effectiveShippingMethod === "home") {
      if (!address.county) e.county = t.errorCounty;
      if (!address.district.trim()) e.district = t.errorDistrict;
      if (!address.detail.trim()) e.detail = t.errorDetail;
    }

    if (invoiceType === "personal" && carrier.trim() && !CARRIER_RE.test(carrier.trim())) {
      e.carrier = t.errorCarrier;
    }
    if (invoiceType === "company") {
      if (!TAX_ID_RE.test(taxId.trim())) e.taxId = t.errorTaxId;
      if (!companyTitle.trim()) e.companyTitle = t.errorCompanyTitle;
    }
    return e;
  }

  function scrollToFirstError(errs: Record<string, string>) {
    const firstKey = Object.keys(errs)[0];
    if (!firstKey) return;
    const el = document.getElementById(firstKey);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus?.();
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      scrollToFirstError(errs);
      return;
    }
    setErrors({});
    setError("");
    setSubmitting(true);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          items: items.map((i) => ({ productId: i.productId, quantity: i.quantity, mode: i.mode })),
          contact: { name: contact.name, email: contact.email, phone: contact.phone, note },
          shipping: {
            method: effectiveShippingMethod,
            county: address.county,
            district: address.district,
            postal: address.postal,
            detail: address.detail,
          },
          invoice: {
            type: invoiceType,
            carrier: invoiceType === "personal" ? carrier.trim() : "",
            tax_id: invoiceType === "company" ? taxId.trim() : "",
            title: invoiceType === "company" ? companyTitle.trim() : "",
          },
          payment_method: paymentMethod,
          pointsUsed,
          locale,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.orderToken) {
        throw new Error(data.error ?? t.orderCreateFailed);
      }
      // PayUni 整合式支付頁(UPP)只吃「瀏覽器 Form POST」,沒有可以直接
      // location.href 過去的 redirect URL —— 所以動態建一個 hidden form 送出。
      // 購物車刻意不在這裡清空:等 checkout/confirm 頁輪詢到 paid 才清,
      // 客人中途放棄付款時購物車還在。
      const payment = data.payment as
        | { action?: string; fields?: Record<string, string> }
        | undefined;
      if (payment?.action && payment.fields) {
        const f = document.createElement("form");
        f.method = "POST";
        f.action = payment.action;
        f.style.display = "none";
        for (const [name, value] of Object.entries(payment.fields)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          f.appendChild(input);
        }
        document.body.appendChild(f);
        f.submit();
        return;
      }
      clearCart();
      router.push(localeHref(`/orders/${data.orderToken}?created=1`, locale));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.orderCreateFailed);
      setSubmitting(false);
    }
  }

  const showPoints = useMemo(() => isLoggedIn && pointsBalance > 0, [isLoggedIn, pointsBalance]);

  if (ready && items.length === 0) {
    return (
      <div className="lm-container py-14">
        <div className="iv-card flex flex-col items-center gap-4 py-14 text-center">
          <p className="text-ink-soft">{t.emptyCart}</p>
          <Link href={localeHref("/gallery", locale)} className="iv-btn-primary">
            {t.browseCollection}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="lm-container py-10 sm:py-16">
      <h1 className="font-serif text-[26px] font-normal text-ink sm:text-[32px]">{t.title}</h1>

      <form onSubmit={submit} className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <section className="iv-card">
            <h2 className="font-serif text-lg text-ink">{t.contactSection}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="iv-label" htmlFor="name">{t.nameLabel}</label>
                <input
                  id="name"
                  className="iv-input"
                  value={contact.name}
                  onChange={(e) => setContact({ ...contact, name: e.target.value })}
                />
                {errors.name && <p className="mt-1 text-xs text-danger">{errors.name}</p>}
              </div>
              <div>
                <label className="iv-label" htmlFor="phone">{t.phoneLabel}</label>
                <input
                  id="phone"
                  type="tel"
                  className="iv-input"
                  placeholder={t.phonePlaceholder}
                  value={contact.phone}
                  onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                />
                {errors.phone && <p className="mt-1 text-xs text-danger">{errors.phone}</p>}
              </div>
              <div className="sm:col-span-2">
                <label className="iv-label" htmlFor="email">{t.emailLabel}</label>
                <input
                  id="email"
                  type="email"
                  className="iv-input"
                  value={contact.email}
                  onChange={(e) => setContact({ ...contact, email: e.target.value })}
                />
                {errors.email && <p className="mt-1 text-xs text-danger">{errors.email}</p>}
              </div>
            </div>
          </section>

          {hasPhysical && (
            <section className="iv-card">
              <h2 className="font-serif text-lg text-ink">{t.shippingSection}</h2>
              <div className="mt-4 space-y-3">
                {[
                  { value: "home" as const, label: t.shippingHomeLabel, desc: t.shippingHomeDesc },
                  { value: "pickup" as const, label: t.shippingPickupLabel, desc: t.shippingPickupDesc },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-center gap-3 border p-4 ${
                      shippingMethod === opt.value ? "border-gold bg-panel" : "border-line"
                    }`}
                  >
                    <input
                      type="radio"
                      name="shippingMethod"
                      value={opt.value}
                      checked={shippingMethod === opt.value}
                      onChange={() => setShippingMethod(opt.value)}
                      className="h-4 w-4 accent-[#9a7d47]"
                    />
                    <span>
                      <span className="block font-medium text-ink">{opt.label}</span>
                      <span className="block text-xs text-ink-soft">{opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>

              {shippingMethod === "home" ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="iv-label" htmlFor="county">{t.countyLabel}</label>
                    <select
                      id="county"
                      className="iv-input"
                      value={address.county}
                      onChange={(e) => setAddress({ ...address, county: e.target.value })}
                    >
                      <option value="">{t.countyPlaceholder}</option>
                      {TAIWAN_COUNTIES.map((c) => (
                        <option key={c} value={c}>{locale === "en" ? TAIWAN_COUNTY_EN[c] : c}</option>
                      ))}
                    </select>
                    {errors.county && <p className="mt-1 text-xs text-danger">{errors.county}</p>}
                  </div>
                  <div>
                    <label className="iv-label" htmlFor="district">{t.districtLabel}</label>
                    <input
                      id="district"
                      className="iv-input"
                      value={address.district}
                      onChange={(e) => setAddress({ ...address, district: e.target.value })}
                    />
                    {errors.district && <p className="mt-1 text-xs text-danger">{errors.district}</p>}
                  </div>
                  <div>
                    <label className="iv-label" htmlFor="postal">{t.postalLabel}</label>
                    <input
                      id="postal"
                      className="iv-input"
                      value={address.postal}
                      onChange={(e) => setAddress({ ...address, postal: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="iv-label" htmlFor="detail">{t.detailLabel}</label>
                    <input
                      id="detail"
                      className="iv-input"
                      value={address.detail}
                      onChange={(e) => setAddress({ ...address, detail: e.target.value })}
                    />
                    {errors.detail && <p className="mt-1 text-xs text-danger">{errors.detail}</p>}
                  </div>
                </div>
              ) : (
                <div className="mt-4 border border-line bg-panel p-4 text-sm">
                  <p className="font-medium text-ink">{company.name}</p>
                  <p className="mt-1 text-ink-soft">{company.address || t.pickupAddressFallback}</p>
                  <p className="mt-1 text-ink-soft">{company.hours || ""}</p>
                </div>
              )}
            </section>
          )}

          <section className="iv-card">
            <h2 className="font-serif text-lg text-ink">{t.invoiceSection}</h2>
            <div className="mt-4 space-y-3">
              {[
                { value: "personal" as const, label: t.invoicePersonalLabel },
                { value: "company" as const, label: t.invoiceCompanyLabel },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-center gap-3 border p-4 ${
                    invoiceType === opt.value ? "border-gold bg-panel" : "border-line"
                  }`}
                >
                  <input
                    type="radio"
                    name="invoiceType"
                    value={opt.value}
                    checked={invoiceType === opt.value}
                    onChange={() => setInvoiceType(opt.value)}
                    className="h-4 w-4 accent-[#9a7d47]"
                  />
                  <span className="font-medium text-ink">{opt.label}</span>
                </label>
              ))}
            </div>

            {invoiceType === "personal" ? (
              <div className="mt-4">
                <label className="iv-label" htmlFor="carrier">{t.carrierLabel}</label>
                <input
                  id="carrier"
                  className="iv-input"
                  placeholder={t.carrierPlaceholder}
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                />
                {errors.carrier && <p className="mt-1 text-xs text-danger">{errors.carrier}</p>}
              </div>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="iv-label" htmlFor="taxId">{t.taxIdLabel}</label>
                  <input
                    id="taxId"
                    className="iv-input"
                    maxLength={8}
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  />
                  {errors.taxId && <p className="mt-1 text-xs text-danger">{errors.taxId}</p>}
                </div>
                <div>
                  <label className="iv-label" htmlFor="companyTitle">{t.companyTitleLabel}</label>
                  <input
                    id="companyTitle"
                    className="iv-input"
                    value={companyTitle}
                    onChange={(e) => setCompanyTitle(e.target.value)}
                  />
                  {errors.companyTitle && (
                    <p className="mt-1 text-xs text-danger">{errors.companyTitle}</p>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="iv-card">
            <h2 className="font-serif text-lg text-ink">{t.paymentSection}</h2>
            <div className="mt-4 space-y-3">
              {[
                { value: "bank_transfer" as const, label: t.paymentBankLabel, desc: t.paymentBankDesc },
                { value: "cod" as const, label: t.paymentCodLabel, desc: t.paymentCodDesc },
                ...(cardPaymentAvailable
                  ? [
                      {
                        value: "card" as const,
                        label: t.paymentCardLabel,
                        desc: t.paymentCardDesc,
                      },
                    ]
                  : []),
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-center gap-3 border p-4 ${
                    paymentMethod === opt.value ? "border-gold bg-panel" : "border-line"
                  }`}
                >
                  <input
                    type="radio"
                    name="payment"
                    value={opt.value}
                    checked={paymentMethod === opt.value}
                    onChange={() => setPaymentMethod(opt.value)}
                    className="h-4 w-4 accent-[#9a7d47]"
                  />
                  <span>
                    <span className="block font-medium text-ink">{opt.label}</span>
                    <span className="block text-xs text-ink-soft">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          {showPoints && (
            <section className="iv-card">
              <h2 className="font-serif text-lg text-ink">{t.pointsSection}</h2>
              <p className="mt-1 text-sm text-ink-soft">
                {t.pointsAvailablePrefix}
                <span className="font-semibold text-accent">
                  {pointsBalance.toLocaleString(locale === "en" ? "en-US" : "zh-TW")}
                </span>
                {t.pointsAvailableMid}
                {formatTWD(maxRedeemable, locale)}
                {t.pointsAvailableSuffix}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="number"
                  min={0}
                  max={maxRedeemable}
                  className="iv-input max-w-40"
                  value={pointsInput}
                  onChange={(e) => setPointsInput(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setPointsInput(String(maxRedeemable))}
                  className="text-sm tracking-[0.04em] text-accent border-b border-gold pb-0.5"
                >
                  {t.redeemAll}
                </button>
              </div>
            </section>
          )}

          <section className="iv-card">
            <h2 className="font-serif text-lg text-ink">{t.noteSection}</h2>
            <textarea
              rows={3}
              className="iv-input mt-4 min-h-24"
              placeholder={t.notePlaceholder}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </section>
        </div>

        <div className="iv-card h-fit lg:sticky lg:top-24">
          <h2 className="font-serif text-lg text-ink">{t.summaryTitle}</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {items.map((i) => (
              <li key={`${i.productId}-${i.mode}`} className="flex justify-between gap-2">
                <span className="line-clamp-1 text-ink-soft">
                  {localizeText(i.name, i.name_en, locale)}
                  <span className="ml-1 text-[11px] text-accent">
                    ({getPurchaseModeLabel(i.mode, locale)})
                  </span>
                  {" "}× {i.quantity}
                </span>
                <span className="shrink-0">{formatTWD(i.price * i.quantity, locale)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-soft">{t.subtotal}</span>
              <span>{formatTWD(subtotal, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-soft">{t.shippingFee}</span>
              <span>
                {!hasPhysical
                  ? t.shippingNone
                  : effectiveShippingMethod === "pickup"
                    ? t.shippingFreePickup
                    : shippingFee === 0
                      ? t.shippingFree
                      : formatTWD(shippingFee, locale)}
              </span>
            </div>
            {pointsUsed > 0 && (
              <div className="flex justify-between text-accent">
                <span>{t.pointsDiscount}</span>
                <span>-{formatTWD(pointsUsed, locale)}</span>
              </div>
            )}
          </div>
          <div className="mt-3 flex justify-between border-t border-line pt-3 font-medium">
            <span>{t.total}</span>
            <span className="font-serif text-[18px] text-ink">{formatTWD(total, locale)}</span>
          </div>
          {error && (
            <p className="mt-3 rounded-[2px] bg-danger-soft p-3 text-sm text-danger">{error}</p>
          )}
          <button type="submit" disabled={submitting} className="iv-btn-primary mt-5 w-full">
            {submitting ? t.submitting : t.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
