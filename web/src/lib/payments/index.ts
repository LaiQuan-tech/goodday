// 付款供應商介面:銀行轉帳/貨到付款走現行流程(createPayment 回 null,不轉導);
// 信用卡由 PayUni 統一金流處理(見 ./payuni.ts)。
export type PaymentOrder = {
  id: string;
  order_no: string;
  total: number;
  contact_name: string;
  contact_email: string;
  public_token: string;
  /** 顯示在 PayUni 支付頁的品項名稱;未提供時退化為「好日子訂單 ${order_no}」 */
  itemName?: string;
};

/**
 * PayUni 的整合式支付頁(UPP)是「由瀏覽器 Form POST 四個欄位過去」才成立交易,
 * 沒有「伺服器端先建立交易、換一個 redirect URL」的流程(這點與本站舊金流商相反)。
 * 因此這裡回傳的是表單內容,由前端動態建 form 送出,而不是一個可以直接 location.href 的網址。
 */
export type PaymentResult = {
  kind: "form";
  action: string;
  fields: Record<string, string>;
};

// 刷卡選項是否可用:除了 PayUni 的三把金鑰(MER_ID/HASH_KEY/HASH_IV)之外,
// WEBHOOK_SECRET 也必須設定才算可用。
//
// ⚠️ 這一條是刻意沿用舊金流時期的安全設計,不要為了「規格只寫三個變數」而拿掉:
// 少了 WEBHOOK_SECRET,payuniNotifyUrl() 會回 null → 建立交易時根本不會帶 NotifyURL
// → 客戶被真的收款成功,但我們永遠收不到付款通知,訂單卡在 pending(點數/會員升級/
// 確認信全不發,錢已經進金流商)。寧可整個不開放刷卡,也不要開放一個會卡單的刷卡。
export function isCardPaymentAvailable(): boolean {
  return Boolean(
    process.env.PAYUNI_MER_ID &&
      process.env.PAYUNI_HASH_KEY &&
      process.env.PAYUNI_HASH_IV &&
      process.env.PAYUNI_WEBHOOK_SECRET
  );
}

// bank_transfer / cod 一律回傳 null(沿用現行「站內顯示匯款資訊」流程);
// card 在金鑰未設定時 isCardPaymentAvailable() 已為 false,理論上不會有人送出 card,這裡再防一層。
export async function createPayment(
  paymentMethod: string,
  order: PaymentOrder
): Promise<PaymentResult | null> {
  if (paymentMethod !== "card") return null;
  if (!isCardPaymentAvailable()) return null;

  const { buildUppForm } = await import("./payuni");

  // MerTradeNo 直接用 order_no(格式 IV-2026-00001):≤25 碼、字元集符合 PayUni 規則、
  // 全站唯一,且與建單時寫入的 gateway_tx_id 完全一致 —— webhook 才對得回這筆訂單。
  const { action, fields } = buildUppForm({
    merTradeNo: order.order_no,
    amount: order.total,
    prodDesc: order.itemName ?? `好日子訂單 ${order.order_no}`,
  });

  return { kind: "form", action, fields };
}
