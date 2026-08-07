"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clearCart } from "@/lib/cart";
import { useTranslations } from "@/lib/i18n/context";
import { localeHref } from "@/lib/i18n/href";

// PayUni 前景導回頁(ReturnURL)。導回時帶什麼參數不保證,所以 ReturnURL 本身在
// 建立交易時就已經附上 ?order=<order_no>(見 lib/payments/payuni.ts payuniReturnUrl)。
//
// 信 DB 不信 URL:不管 PayUni 導回時帶了什麼(或什麼都沒帶),一律以
// GET /api/orders/status 的輪詢結果為準,不用 URL query string 判斷付款是否成功。
//
// 狀態對應刻意保守:只有明確拿到 "paid" 才算成功、明確拿到 "failed"/"cancelled" 才算失敗,
// 其餘一切(包含 PayUni 反查的 "0" 取號成功 /"8" 待確認、網路錯誤、未知值)一律當作還在
// 確認中繼續輪詢,避免把「還沒有結果」誤判成「失敗」。
//
// 這頁不再 fetch 或使用 public_token —— /api/orders/status 只回 { status },不回任何
// 可用來查看訂單詳情的憑證(避免靠猜 order_no 冒領訂單頁,見該 route 的註解)。訂單
// 查詢連結改由付款成功後 markOrderPaid 寄出的確認信提供。

type ViewState = "checking" | "pending" | "paid" | "failed" | "not_found" | "timeout";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 40; // 40 * 3s = 120s

export default function CheckoutConfirmPage() {
  const { locale, messages } = useTranslations();
  const t = messages.checkout.confirm;
  const [view, setView] = useState<ViewState>("checking");
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartClearedRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const no = params.get("order");
    setOrderNo(no);
    if (!no) {
      setView("not_found");
      return;
    }

    let cancelled = false;

    async function poll() {
      attemptsRef.current += 1;
      try {
        const res = await fetch(`/api/orders/status?no=${encodeURIComponent(no!)}`, {
          cache: "no-store",
        });
        if (cancelled) return;

        if (res.status === 404) {
          setView("not_found");
          return;
        }
        if (!res.ok) throw new Error("查詢失敗");

        const data = (await res.json()) as { status?: string };

        if (data.status === "paid") {
          if (!cartClearedRef.current) {
            clearCart();
            cartClearedRef.current = true;
          }
          setView("paid");
          return;
        }
        if (data.status === "failed" || data.status === "cancelled") {
          setView("failed");
          return;
        }

        // 其餘一律當「還在確認中」,包含未知狀態值 —— 不要在這裡誤判成失敗。
        if (attemptsRef.current >= MAX_ATTEMPTS) {
          setView("timeout");
          return;
        }
        setView("pending");
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (cancelled) return;
        if (attemptsRef.current >= MAX_ATTEMPTS) {
          setView("timeout");
          return;
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="lm-container max-w-135 py-14 sm:py-20">
      <div className="iv-card flex flex-col items-center gap-4 py-14 text-center">
        {(view === "checking" || view === "pending") && (
          <>
            <div
              aria-hidden
              className="h-8 w-8 animate-spin rounded-full border-2 border-line-2 border-t-gold"
            />
            <h1 className="font-serif text-xl text-ink">{t.checkingTitle}</h1>
            <p className="text-sm text-ink-soft">{t.checkingDesc}</p>
          </>
        )}

        {view === "paid" && (
          <>
            <h1 className="font-serif text-xl text-ink">{t.paidTitle}</h1>
            <p className="text-sm text-ink-soft">
              {t.paidDescPrefix}{orderNo}{t.paidDescSuffix}
            </p>
            <Link href={localeHref("/account", locale)} className="iv-btn-primary mt-2">
              {t.viewAccount}
            </Link>
          </>
        )}

        {view === "failed" && (
          <>
            <h1 className="font-serif text-xl text-ink">{t.failedTitle}</h1>
            <p className="text-sm text-ink-soft">{t.failedDesc}</p>
            <div className="mt-2 flex flex-wrap justify-center gap-3">
              <Link href={localeHref("/checkout", locale)} className="iv-btn-primary">
                {t.retryCheckout}
              </Link>
            </div>
          </>
        )}

        {view === "timeout" && (
          <>
            <h1 className="font-serif text-xl text-ink">{t.timeoutTitle}</h1>
            <p className="text-sm text-ink-soft">{t.timeoutDesc}</p>
          </>
        )}

        {view === "not_found" && (
          <>
            <h1 className="font-serif text-xl text-ink">{t.notFoundTitle}</h1>
            <p className="text-sm text-ink-soft">
              {orderNo
                ? `${t.notFoundWithOrderPrefix}${orderNo}${t.notFoundWithOrderSuffix}`
                : t.notFoundNoOrder}
              {" "}{t.notFoundHelp}
            </p>
            <Link href={localeHref("/checkout", locale)} className="iv-btn-primary mt-2">
              {t.backToCheckout}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
