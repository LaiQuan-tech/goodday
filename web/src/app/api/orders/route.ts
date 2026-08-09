import { NextRequest, NextResponse } from "next/server";
import { tryCreateAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { emailShell, notifyAdmin, sendMail, siteUrl } from "@/lib/resend";
import { getCompanyProfile, getShippingConfig } from "@/lib/settings";
import {
  formatDate,
  formatTWD,
  getPaymentMethodLabel,
  getPurchaseModeLabel,
  getShippingMethodLabel,
  localizeText,
  PAYMENT_METHOD_LABEL,
  PURCHASE_MODE_LABEL,
  SHIPPING_METHOD_LABEL,
} from "@/lib/format";
import { getPointsBalance, redeemPointsForOrder } from "@/lib/points";
import { reserveSeatsForOrder } from "@/lib/courses";
import { createPayment, isCardPaymentAvailable, type PaymentResult } from "@/lib/payments";
import { isLocale, type Locale } from "@/lib/i18n/config";
import type { InvoiceType, PurchaseMode, ShippingMethod } from "@/lib/types";

const PHONE_RE = /^09\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARRIER_RE = /^\/[0-9A-Z.+-]{7}$/;
const TAX_ID_RE = /^\d{8}$/;
const UNIQUE_VIOLATION = "23505";

type CheckoutItem = {
  productId: string;
  quantity: number;
  mode?: PurchaseMode;
};

type CheckoutBody = {
  items: CheckoutItem[];
  contact: {
    name: string;
    email: string;
    phone: string;
    note: string;
  };
  shipping?: {
    method?: string;
    county?: string;
    district?: string;
    postal?: string;
    detail?: string;
  };
  invoice?: {
    type?: string;
    carrier?: string;
    tax_id?: string;
    title?: string;
  };
  payment_method: string;
  pointsUsed?: number;
  locale?: string;
};

const VALID_MODES: PurchaseMode[] = ["buyout", "rental", "journey", "membership", "course"];

// 依商品的 product_type 決定允許的購買模式與預設模式
function resolveMode(productType: string, requested?: PurchaseMode): PurchaseMode | null {
  if (productType === "artwork") {
    const mode = requested ?? "buyout";
    return mode === "buyout" || mode === "rental" ? mode : null;
  }
  if (productType === "journey") return "journey";
  if (productType === "membership") return "membership";
  if (productType === "course") return "course";
  return null;
}

export async function POST(req: NextRequest) {
  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "格式錯誤" }, { status: 400 });
  }

  const supabase = tryCreateAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "系統尚未完成設定,請稍後再試" }, { status: 503 });
  }

  // Idempotency-Key:同一 key 已有訂單就直接回傳既有訂單,不重複建單、不報錯
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim().slice(0, 100) || null;
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from("orders")
      .select("public_token")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ orderToken: existing.public_token });
    }
  }

  const items = (body.items ?? []).filter(
    (i) =>
      i?.productId &&
      Number.isInteger(i.quantity) &&
      i.quantity > 0 &&
      i.quantity <= 999 &&
      (i.mode === undefined || VALID_MODES.includes(i.mode))
  );
  const contact = body.contact;
  if (
    items.length === 0 ||
    !contact?.name?.trim() ||
    !EMAIL_RE.test(contact?.email?.trim() ?? "") ||
    !PHONE_RE.test(contact?.phone?.trim() ?? "")
  ) {
    return NextResponse.json({ error: "缺少必要欄位或格式錯誤" }, { status: 400 });
  }

  // Phase F1:買家下單當下的介面語系,未帶值一律 zh(既有前端呼叫端零改動 → 行為不變)
  const requestLocale: Locale = isLocale(body.locale ?? "") ? (body.locale as Locale) : "zh";

  // 價格一律以資料庫為準,不信任前端
  const ids = items.map((i) => i.productId);
  const { data: products, error: prodErr } = await supabase
    .from("products")
    .select(
      "id, name, name_en, price, price_rental_monthly, stock, status, product_type, metadata"
    )
    .in("id", ids);
  if (prodErr) {
    console.error("[orders] product load failed:", prodErr);
    return NextResponse.json({ error: "系統忙碌,請稍後再試" }, { status: 500 });
  }

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));

  type ResolvedLine = {
    product_id: string;
    name: string;
    unit_price: number;
    quantity: number;
    purchase_mode: PurchaseMode;
    tier_slug: string | null;
  };
  const lineItems: ResolvedLine[] = [];

  for (const item of items) {
    const p = productMap.get(item.productId);
    if (!p || p.status !== "active") {
      return NextResponse.json({ error: "部分商品已下架,請重新整理購物車" }, { status: 409 });
    }
    const mode = resolveMode(p.product_type, item.mode);
    if (!mode) {
      return NextResponse.json({ error: `「${p.name}」不支援此購買模式` }, { status: 400 });
    }

    // 會員方案與課程一次只能買一份(非計量商品):課程報名是「一個人一個座位」,
    // 名額由 reserve_course_seat() 以「一筆報名 = 一位」控管,買 2 份也只會佔 1 位。
    const quantity = mode === "membership" || mode === "course" ? 1 : item.quantity;

    let unitPrice: number;
    if (mode === "rental") {
      if (p.price_rental_monthly == null) {
        return NextResponse.json({ error: `「${p.name}」尚未提供月租價` }, { status: 400 });
      }
      unitPrice = p.price_rental_monthly;
    } else {
      unitPrice = p.price;
    }

    // 庫存只對實體藝術品(買斷/月租)有意義;旅程、會員方案與課程是服務類商品,不受庫存限制。
    // ⚠️ 課程的 products.stock 恆為 0,若讓它走進這個 if 會一律被擋成「庫存不足」;
    // 課程的容量限制走 course_details.capacity + reserve_course_seat(),與 stock 無關。
    if (p.product_type === "artwork") {
      if (p.stock < quantity) {
        return NextResponse.json(
          { error: `「${p.name}」庫存不足(剩 ${p.stock} 件)` },
          { status: 409 }
        );
      }
    }

    const metadata = (p.metadata ?? {}) as Record<string, unknown>;
    const tierSlug = mode === "membership" ? (metadata.tier_slug as string | undefined) ?? null : null;

    lineItems.push({
      product_id: p.id,
      // Phase F1:依買家下單當下語系存快照名稱;未翻譯(name_en null)fallback 中文,
      // 中文買家(requestLocale="zh")一律走 p.name,行為與現在逐字相同。
      name: localizeText(p.name, p.name_en, requestLocale),
      unit_price: unitPrice,
      quantity,
      purchase_mode: mode,
      tier_slug: tierSlug,
    });
  }

  const subtotal = lineItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const hasPhysical = lineItems.some(
    (i) => i.purchase_mode === "buyout" || i.purchase_mode === "rental"
  );

  const [company, shippingConfig] = await Promise.all([getCompanyProfile(), getShippingConfig()]);

  // ---------- 收件方式 + 運費(伺服器算,不信任前端) ----------
  let shippingMethod: ShippingMethod;
  let shippingAddress = "";
  let shippingFee = 0;

  if (!hasPhysical) {
    shippingMethod = "none";
  } else {
    const requestedMethod = body.shipping?.method;
    if (requestedMethod !== "home" && requestedMethod !== "pickup") {
      return NextResponse.json({ error: "請選擇收件方式" }, { status: 400 });
    }
    shippingMethod = requestedMethod;

    if (shippingMethod === "pickup") {
      shippingAddress = company.address ?? "";
      shippingFee = 0;
    } else {
      const county = (body.shipping?.county ?? "").trim().slice(0, 20);
      const district = (body.shipping?.district ?? "").trim().slice(0, 30);
      const postal = (body.shipping?.postal ?? "").trim().slice(0, 10);
      const detail = (body.shipping?.detail ?? "").trim().slice(0, 200);
      if (!county || !district || !detail) {
        return NextResponse.json({ error: "請填寫完整收件地址" }, { status: 400 });
      }
      shippingAddress = `${postal ? postal + " " : ""}${county}${district}${detail}`.slice(0, 300);

      const physicalSubtotal = lineItems
        .filter((i) => i.purchase_mode === "buyout" || i.purchase_mode === "rental")
        .reduce((s, i) => s + i.unit_price * i.quantity, 0);
      shippingFee =
        physicalSubtotal >= shippingConfig.free_threshold_home ? 0 : shippingConfig.fee_home;
    }
  }

  // ---------- 發票(收欄位先存檔不開立) ----------
  const requestedInvoiceType: InvoiceType =
    body.invoice?.type === "company" ? "company" : "personal";
  let invoice: { type: InvoiceType; carrier?: string; tax_id?: string; title?: string };
  if (requestedInvoiceType === "company") {
    const taxId = (body.invoice?.tax_id ?? "").trim();
    const title = (body.invoice?.title ?? "").trim().slice(0, 100);
    if (!TAX_ID_RE.test(taxId) || !title) {
      return NextResponse.json({ error: "請填寫正確的統一編號與公司抬頭" }, { status: 400 });
    }
    invoice = { type: "company", tax_id: taxId, title };
  } else {
    const carrier = (body.invoice?.carrier ?? "").trim().slice(0, 20);
    if (carrier && !CARRIER_RE.test(carrier)) {
      return NextResponse.json({ error: "手機條碼格式錯誤" }, { status: 400 });
    }
    invoice = { type: "personal", ...(carrier ? { carrier } : {}) };
  }

  // ---------- 付款方式 ----------
  const requestedPayment = body.payment_method;
  let paymentMethod: string;
  if (requestedPayment === "card") {
    if (!isCardPaymentAvailable()) {
      return NextResponse.json({ error: "刷卡功能尚未開放,請選擇其他付款方式" }, { status: 400 });
    }
    paymentMethod = "card";
  } else if (["bank_transfer", "cod"].includes(requestedPayment)) {
    paymentMethod = requestedPayment;
  } else {
    paymentMethod = "bank_transfer";
  }

  // 登入使用者綁定訂單
  let userId: string | null = null;
  try {
    const userClient = await createClient();
    const { data } = await userClient.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    /* 未登入照樣可下單 */
  }

  // 課程品項必須綁帳號:course_access(觀看權)與 course_enrollments 都以 user_id 為主鍵之一,
  // 訪客購課會付了錢卻拿不到觀看權、也無從歸戶,所以在建單之前就擋掉。
  const courseLines = lineItems.filter((i) => i.purchase_mode === "course");
  if (courseLines.length > 0 && !userId) {
    return NextResponse.json({ error: "購買課程請先登入會員" }, { status: 400 });
  }

  // 點數折抵(1 點 = NT$1,僅登入會員可用,上限為 min(餘額, 商品小計))
  const requestedPoints = Number(body.pointsUsed ?? 0);
  let pointsUsed = 0;
  if (requestedPoints > 0) {
    if (!Number.isInteger(requestedPoints)) {
      return NextResponse.json({ error: "點數格式錯誤" }, { status: 400 });
    }
    if (!userId) {
      return NextResponse.json({ error: "登入後才能使用點數折抵" }, { status: 400 });
    }
    const { balance } = await getPointsBalance(userId);
    if (requestedPoints > balance) {
      return NextResponse.json({ error: "點數餘額不足" }, { status: 400 });
    }
    if (requestedPoints > subtotal) {
      return NextResponse.json({ error: "折抵點數不可超過商品小計" }, { status: 400 });
    }
    pointsUsed = requestedPoints;
  }

  const total = Math.max(0, subtotal + shippingFee - pointsUsed);

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      user_id: userId,
      status: "pending",
      subtotal,
      shipping_fee: shippingFee,
      total,
      points_used: pointsUsed,
      contact_name: contact.name.slice(0, 100),
      contact_email: contact.email.slice(0, 200),
      contact_phone: contact.phone.slice(0, 50),
      shipping_address: shippingAddress,
      shipping_method: shippingMethod,
      invoice,
      payment_method: paymentMethod,
      note: (contact.note ?? "").slice(0, 1000),
      idempotency_key: idempotencyKey,
      locale: requestLocale,
    })
    .select("*")
    .single();

  if (orderErr || !order) {
    // 併發下同一 Idempotency-Key 兩個請求都通過了前面的預查 → 其中一個會撞 unique 衝突,
    // 回傳既有訂單而不是報錯,確保重試/雙擊永遠拿到同一張訂單
    if (orderErr?.code === UNIQUE_VIOLATION && idempotencyKey) {
      const { data: raced } = await supabase
        .from("orders")
        .select("public_token")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (raced) {
        return NextResponse.json({ orderToken: raced.public_token });
      }
    }
    console.error("[orders] insert failed:", orderErr);
    return NextResponse.json({ error: "訂單建立失敗" }, { status: 500 });
  }

  // card 訂單建單當下就寫入 gateway_tx_id(= order.order_no,DB insert 剛產生,每次結帳
  // 都是新值,unique index 不衝突),且必須早於下面呼叫 createPayment() —— createPayment()
  // 一旦成功,客戶的瀏覽器隨時可能把表單 POST 到 PayUni、PayUni 隨時可能打 webhook
  // 回來;若寫入動作留到 createPayment() 之後才做(舊版做法,且未檢查回傳結果),中間
  // 這段空窗期若 webhook 先到,會因為查不到 gateway_tx_id 而被直接 ack 放掉、永遠不會
  // 再重送。這裡改成先寫、檢查寫入結果;寫入失敗就不呼叫 createPayment()(不讓一筆金流
  // 訂單存在於 PayUni 卻對不到我們 DB 的紀錄)。
  let cardGatewayReady = false;
  if (paymentMethod === "card") {
    const { error: gatewayErr } = await supabase
      .from("orders")
      .update({ gateway: "payuni", gateway_tx_id: order.order_no })
      .eq("id", order.id);
    if (gatewayErr) {
      console.error("[orders] gateway_tx_id write failed:", gatewayErr);
    } else {
      cardGatewayReady = true;
    }
  }

  const { error: itemsErr } = await supabase
    .from("order_items")
    .insert(lineItems.map((i) => ({ ...i, order_id: order.id })));
  if (itemsErr) {
    console.error("[orders] items insert failed:", itemsErr);
    await supabase.from("orders").delete().eq("id", order.id);
    return NextResponse.json({ error: "訂單建立失敗" }, { status: 500 });
  }

  // 課程佔位(reserved,付款後才轉 confirmed)。
  //
  // ⚠️⚠️ 這一段的位置是這支 route 最重要的事,改動前請先讀完:
  //   1. 必須在 order_items 建立「之後」—— 佔位紀錄要帶 order_id 才能在付款/取消時對得回來。
  //   2. 必須在 redeemPointsForOrder()「之前」—— 扣點數會寫進 points_ledger,若先扣點再
  //      發現額滿,就得回滾點數帳本(而 ledger 是不可變的帳,回滾要再寫一筆沖銷);
  //      排在前面則額滿的失敗路徑完全不用碰點數。
  //   3. 也必須在扣庫存之前(同理:失敗路徑不用把庫存加回去)。
  //   4. 全有或全無:多堂課只要有一堂搶不到位,整張訂單失敗,已搶到的位子由
  //      reserveSeatsForOrder() 內部呼叫 release_course_seats_for_order() 釋放,不留孤兒保留。
  if (courseLines.length > 0 && userId) {
    const reserveResult = await reserveSeatsForOrder(
      {
        id: order.id,
        user_id: userId,
        contact_name: order.contact_name,
        contact_email: order.contact_email,
        contact_phone: order.contact_phone,
      },
      courseLines.map((i) => ({ product_id: i.product_id, name: i.name }))
    );
    if (!reserveResult.ok) {
      // 位子沒搶到就不該留下這張訂單(否則客人會看到一張永遠付不成的單,
      // 且 idempotency_key 會被佔住導致重試拿到同一張壞單)
      await supabase.from("order_items").delete().eq("order_id", order.id);
      await supabase.from("orders").delete().eq("id", order.id);
      return NextResponse.json({ error: reserveResult.error }, { status: 409 });
    }
  }

  // 扣庫存(僅實體藝術品)。
  //
  // ⚠️ 位置與上面搶位那段同一套規約,理由完全一樣:
  //   - 在搶位「之後」:兩者都會失敗,先做便宜的、後做要補償的;搶位失敗時庫存還沒動。
  //   - 在 redeemPointsForOrder()「之前」:扣庫存失敗要刪單,若點數已扣就得沖銷
  //     points_ledger(不可變帳本,回滾要再寫一筆),排在前面則完全不用碰點數。
  //
  // 舊實作是讀快照 → 數百行後寫絕對值,且 update 的回傳值沒接沒檢查,扣不到也照樣
  // 導去金流,是靜默超賣的來源。改呼叫 deduct_product_stock():單一交易內排序後
  // FOR UPDATE 鎖列、相對扣減,任一項不足就整批 RAISE EXCEPTION 回滾。
  const stockItems = lineItems
    .filter((line) => productMap.get(line.product_id)!.product_type === "artwork")
    .map((line) => ({ product_id: line.product_id, quantity: line.quantity }));
  if (stockItems.length > 0) {
    const { error: stockError } = await supabase.rpc("deduct_product_stock", {
      p_items: stockItems,
    });
    if (stockError) {
      console.error("[orders] deduct_product_stock failed:", stockError);
      // 刪單前必須先退位:course_enrollments.order_id 的 FK 是 on delete set null,
      // 先刪訂單會把 order_id 抹成 null,release_course_seats_for_order() 就再也
      // 找不到這些保留,seats_taken 永遠回不來(名額被一張不存在的訂單卡死)。
      if (courseLines.length > 0 && userId) {
        const { error: releaseError } = await supabase.rpc("release_course_seats_for_order", {
          p_order_id: order.id,
        });
        if (releaseError) {
          console.error("[orders] release seats after stock failure failed:", releaseError);
        }
      }
      await supabase.from("order_items").delete().eq("order_id", order.id);
      await supabase.from("orders").delete().eq("id", order.id);
      return NextResponse.json(
        { error: "部分商品庫存不足,請重新整理購物車後再試一次" },
        { status: 409 }
      );
    }
  }

  // 扣點數(server 端已驗證餘額;冪等靠 points_ledger unique index)
  if (pointsUsed > 0 && userId) {
    const redeemResult = await redeemPointsForOrder(userId, order.id, pointsUsed);
    if (!redeemResult.ok) {
      console.error("[orders] points redeem failed after order created:", redeemResult.error);
    }
  }

  // bank_transfer/cod 一律回 null,走現行「站內顯示匯款資訊」流程;
  // card 組出 PayUni 整合式支付頁(UPP)的 Form POST 內容({ action, fields }),由前端
  // 動態建 form 送出 —— 但只在上面 gateway_tx_id 已確實寫入(cardGatewayReady)時才做,
  // 避免產生一筆 webhook 永遠對不到單的金流交易。
  let paymentResult: PaymentResult | null = null;
  if (paymentMethod !== "card" || cardGatewayReady) {
    try {
      paymentResult = await createPayment(paymentMethod, {
        id: order.id,
        order_no: order.order_no,
        total: order.total,
        contact_name: order.contact_name,
        contact_email: order.contact_email,
        public_token: order.public_token,
        itemName: lineItems[0]?.name,
      });
    } catch (err) {
      // 訂單已建立,金流建立失敗不讓整個下單流程 500 —— 客戶仍拿得到 orderToken,
      // 訂單維持 pending,可從訂單頁或客服協助重新導向付款。
      console.error("[orders] createPayment failed:", err);
    }
  }

  // 通知信
  const itemRows = lineItems
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;">${i.name}(${PURCHASE_MODE_LABEL[i.purchase_mode]}) × ${i.quantity}</td><td style="text-align:right;">${formatTWD(i.unit_price * i.quantity)}</td></tr>`
    )
    .join("");
  const shippingRow =
    shippingFee > 0
      ? `<tr><td style="padding:6px 0;">運費(${SHIPPING_METHOD_LABEL[shippingMethod]})</td><td style="text-align:right;">${formatTWD(shippingFee)}</td></tr>`
      : "";
  const pointsRow =
    pointsUsed > 0
      ? `<tr><td style="padding:6px 0;">點數折抵</td><td style="text-align:right;">-${formatTWD(pointsUsed)}</td></tr>`
      : "";
  const deadline = new Date(order.created_at);
  deadline.setDate(deadline.getDate() + shippingConfig.deadline_days);
  const bankInfo =
    paymentMethod === "bank_transfer" && company.bank_info
      ? `<p style="background:#f4ede0;border-radius:4px;padding:12px;margin-top:16px;">匯款資訊:<br/>${company.bank_info.replace(/\n/g, "<br/>")}
         <br/>應付金額:${formatTWD(order.total)}<br/>匯款期限:${formatDate(deadline)} 前</p>`
      : "";

  // Phase F2:客戶信依 order.locale 分支——下面這組英文版本只給客戶信英文分支用;
  // notifyAdmin(下方)與 zh 客戶信一律沿用上面那組 itemRows/shippingRow/pointsRow/bankInfo
  // (完全未改動),保證店主信與中文客戶信 byte 不變。
  const orderLocale: Locale = order.locale === "en" ? "en" : "zh";
  const itemRowsEn = lineItems
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;">${i.name}(${getPurchaseModeLabel(i.purchase_mode, "en")}) × ${i.quantity}</td><td style="text-align:right;">${formatTWD(i.unit_price * i.quantity, "en")}</td></tr>`
    )
    .join("");
  const shippingRowEn =
    shippingFee > 0
      ? `<tr><td style="padding:6px 0;">Shipping (${getShippingMethodLabel(shippingMethod, "en")})</td><td style="text-align:right;">${formatTWD(shippingFee, "en")}</td></tr>`
      : "";
  const pointsRowEn =
    pointsUsed > 0
      ? `<tr><td style="padding:6px 0;">Points Redeemed</td><td style="text-align:right;">-${formatTWD(pointsUsed, "en")}</td></tr>`
      : "";
  const bankInfoEn =
    paymentMethod === "bank_transfer" && company.bank_info
      ? `<p style="background:#f4ede0;border-radius:4px;padding:12px;margin-top:16px;">Bank Transfer Details:<br/>${company.bank_info.replace(/\n/g, "<br/>")}
         <br/>Amount Due: ${formatTWD(order.total, "en")}<br/>Payment Deadline: ${formatDate(deadline, "en")}</p>`
      : "";

  if (orderLocale === "en") {
    await sendMail({
      to: order.contact_email,
      subject: `[Good Days] Order Confirmed — ${order.order_no}`,
      html: emailShell(
        `Order ${order.order_no} Confirmed`,
        `<p>Dear ${order.contact_name}, thank you for your order!</p>
       <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px;">${itemRowsEn}${shippingRowEn}${pointsRowEn}</table>
       <p style="font-weight:700;margin-top:12px;">Total ${formatTWD(order.total, "en")} (${getPaymentMethodLabel(paymentMethod, "en")})</p>
       ${bankInfoEn}
       <p style="margin-top:16px;"><a href="${siteUrl()}/orders/${order.public_token}">View Order Status</a></p>`,
        "en"
      ),
    });
  } else {
    await sendMail({
      to: order.contact_email,
      subject: `【好日子】訂單成立 ${order.order_no}`,
      html: emailShell(
        `訂單 ${order.order_no} 已成立`,
        `<p>${order.contact_name} 您好,感謝您的訂購!</p>
       <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px;">${itemRows}${shippingRow}${pointsRow}</table>
       <p style="font-weight:700;margin-top:12px;">合計 ${formatTWD(order.total)}(${PAYMENT_METHOD_LABEL[paymentMethod]})</p>
       ${bankInfo}
       <p style="margin-top:16px;"><a href="${siteUrl()}/orders/${order.public_token}">查看訂單狀態</a></p>`
      ),
    });
  }
  await notifyAdmin(
    `新訂單 ${order.order_no}(${formatTWD(order.total)})`,
    emailShell(
      "收到新訂單",
      `<p>${order.contact_name} / ${order.contact_email} / ${order.contact_phone}</p>
       <table style="width:100%;border-collapse:collapse;font-size:14px;">${itemRows}${shippingRow}${pointsRow}</table>
       <p style="font-weight:700;">合計 ${formatTWD(order.total)}(${PAYMENT_METHOD_LABEL[paymentMethod]})</p>
       <p><a href="${siteUrl()}/admin/orders/${order.id}">前往後台處理</a></p>`
    )
  );

  // card:回傳 PayUni 支付頁的 Form POST 內容,前端動態建 form 並 submit
  // (PayUni 沒有可以直接 location.href 的 redirect URL)。
  return NextResponse.json({
    orderToken: order.public_token,
    ...(paymentResult
      ? { payment: { action: paymentResult.action, fields: paymentResult.fields } }
      : {}),
  });
}
