import { timingSafeEqual } from "node:crypto";
import { tryCreateAdminClient } from "@/lib/supabase/admin";
import {
  decryptInfo,
  queryPayuniTrade,
  verifyHashInfo,
  TRADE_STATUS_PAID,
  TRADE_STATUS_FAILED,
  TRADE_STATUS_CANCELLED,
} from "@/lib/payments/payuni";
import { markOrderPaid } from "@/lib/orders";

export const dynamic = "force-dynamic";

// 常數時間比對,避免以回應時間逐字元還原密鑰(密鑰非金流權威,但零成本防禦)。
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/webhooks/payuni — PayUni 統一金流 NotifyURL 背景通知。
 *
 * PayUni POST 過來的外層欄位(與建立交易的回應同結構):
 *   Status / MerID / Version / EncryptInfo / HashInfo
 *
 * 安全性(三層,順序不可顛倒):
 *   1. 密鑰閘門 —— NotifyURL 建立時就附上 ?k=<PAYUNI_WEBHOOK_SECRET>(見
 *      lib/payments/payuni.ts payuniNotifyUrl)。缺密鑰或不符,直接 503/404,
 *      連 body 都不解析,擋掉所有偽造/掃描式 POST。
 *   2. 驗簽 —— 自己用 SHA256(HashKey + 收到的 EncryptInfo + HashIV) 重算,與收到的
 *      HashInfo 常數時間比對。⚠️ 不符整包丟棄,絕不進到解密;通過了才 decryptInfo()。
 *   3. 反查 —— 驗簽只證明「這包東西是持有同一組金鑰的一方產生的」。付款狀態與金額
 *      一律以伺服器對伺服器反查 /api/trade/query 的結果為準(縱深防禦),不用 notify
 *      body 解密出來的 TradeStatus 直接判定付款成功。
 *
 * 外層 Status="SUCCESS" 只代表這次請求合法,不是付款結果;付款成功的權威判定是
 * 反查回來的 TradeStatus === "1"。
 *
 * ⚠️ TODO(沙盒實測待確認):官方文件查不到「要回什麼給 PayUni 才算 ack」。
 * 目前一律回 HTTP 200 純文字 "OK"。若沙盒實測發現 PayUni 會持續重送(代表它不接受
 * 這個回應),請改成官方要求的字面值(常見金流慣例是 "1" / "OK" / "SUCCESS")。
 * 在確認之前,重送是安全的 —— 見下面的冪等設計。
 *
 * 冪等設計(不用預佔式 dedupe insert):
 *   - 訂單一旦是終態(paid/processing/shipped/completed)就直接 ack,不再打上游反查。
 *   - 真正的「恰好一次」保證來自 markOrderPaid 內建的條件式 update(CAS on
 *     status='pending')—— 並發的兩則通知都會通過終態短路、都反查到 TradeStatus=1、
 *     都呼叫 markOrderPaid,但只有第一個成功轉移狀態,第二個的條件式 update 落空,
 *     回傳 alreadyPaid 視為成功,不重複執行副作用。
 *   - webhook_events 表只用來存 `failed_<order_no>` marker,供 /api/orders/status
 *     判斷「確認中」還是「付款失敗」;不再用它做預佔式去重。
 *
 * 本專案的 orders 表沒有獨立的 payments 表也沒有 payment_status 欄位(訂單生命週期
 * 就是 orders.status 本身,pending/paid/processing/shipped/completed/cancelled,不含
 * "failed")。因此:
 *   - isPaid:直接對 orders 做條件式更新(經由 markOrderPaid,CAS + 冪等)。
 *   - isFailed:不去動 orders.status(沒有對應狀態可寫,寫了會違反 CHECK constraint),
 *     只在 webhook_events 留一筆正規化的 `failed_<order_no>` marker。訂單維持 pending,
 *     等客戶重新導向付款或後台人工處理。
 */
export async function POST(req: Request) {
  // ---------- 第 1 層:密鑰閘門(在任何 body 解析或資料庫存取之前) ----------
  const webhookSecret = process.env.PAYUNI_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response("service unavailable", { status: 503 });
  }
  const k = new URL(req.url).searchParams.get("k");
  if (!secretMatches(k, webhookSecret)) {
    return new Response("not found", { status: 404 });
  }

  const supabase = tryCreateAdminClient();
  if (!supabase) {
    return new Response("service unavailable", { status: 503 });
  }

  // PayUni 以 form-urlencoded POST;少數情況可能是 JSON,兩種都吃。
  let body: Record<string, string>;
  try {
    const text = await req.text();
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = JSON.parse(text) as Record<string, string>;
    } else {
      body = {};
      for (const [key, value] of new URLSearchParams(text)) body[key] = value;
    }
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const encryptInfoHex = body.EncryptInfo;
  const receivedHash = body.HashInfo;
  if (!encryptInfoHex || !receivedHash) {
    return new Response("missing EncryptInfo/HashInfo", { status: 400 });
  }

  // ---------- 第 2 層:先驗簽,不符整包丟棄(絕不進到解密) ----------
  if (!verifyHashInfo(encryptInfoHex, receivedHash)) {
    console.error("[webhooks/payuni] HashInfo 驗簽失敗,整包丟棄");
    return new Response("invalid signature", { status: 400 });
  }

  // ---------- 驗簽通過,才解密 ----------
  let notify: Record<string, string>;
  try {
    notify = decryptInfo(encryptInfoHex);
  } catch (err) {
    console.error("[webhooks/payuni] decryptInfo failed:", err);
    return new Response("decrypt failed", { status: 400 });
  }

  const orderNo = notify.MerTradeNo;
  if (!orderNo) {
    return new Response("missing MerTradeNo", { status: 400 });
  }

  // 用 gateway_tx_id(= MerTradeNo = order_no,建單時就已寫入)精確比對找單。
  const { data: order } = await supabase
    .from("orders")
    .select("id, order_no, total, status")
    .eq("gateway_tx_id", orderNo)
    .maybeSingle();

  if (!order) {
    // 找不到對應訂單(測試通知、MerTradeNo 打錯,或密鑰外洩後的偽造值):直接 ack,
    // 不打上游反查 —— 避免把反查端點當成可被利用的放大攻擊入口。
    return new Response("OK");
  }

  const TERMINAL_STATUSES = new Set(["paid", "processing", "shipped", "completed"]);
  if (TERMINAL_STATUSES.has(order.status)) {
    // 訂單已是終態:這通常是同一筆付款的重送通知,直接 ack,不再打上游反查。
    return new Response("OK");
  }

  // ---------- 第 3 層:反查(縱深防禦)。驗簽過了仍然不信 body 的付款結果 ----------
  let authoritative: Awaited<ReturnType<typeof queryPayuniTrade>>;
  try {
    authoritative = await queryPayuniTrade(orderNo);
  } catch (err) {
    console.error("[webhooks/payuni] queryPayuniTrade failed:", err);
    // fail-closed:反查失敗就回 5xx 逼 PayUni 重送,不能靜默 ack 放過
    // (否則真正完成的付款會卡在 pending 永遠沒人知道)。
    return new Response("query failed; please retry", { status: 500 });
  }

  const { tradeStatus, tradeAmt, dataSource } = authoritative;
  const isPaid = tradeStatus === TRADE_STATUS_PAID;
  // DataSource="B" 代表上游還在處理、資料不完整,此時不把訂單判成失敗
  // (等下一次通知或客戶輪詢時再拿一次完整結果)。
  const isFailed =
    dataSource !== "B" &&
    (tradeStatus === TRADE_STATUS_FAILED || tradeStatus === TRADE_STATUS_CANCELLED);

  if (isPaid) {
    // 金額缺失(理論上反查一定會回,這裡是防禦性處理):不知道實收金額就不能放行,
    // fail-closed 記錄待人工對帳,不標 paid、也不佔用任何 key(下一次通知或反查
    // 仍能正常處理這筆訂單)。
    if (tradeAmt == null) {
      console.error(
        `[webhooks/payuni] order=${orderNo} TradeStatus=1 但反查未回傳 TradeAmt — 待對帳,暫不標 paid`
      );
      return new Response("OK");
    }

    // 金額比對:反查金額與訂單應付金額不符(對到不同筆訂單、被竄改、或 gateway 資料
    // 異常)一律不標 paid,只記錄供人工對帳,並回 200 讓 PayUni 不要一直重送。
    const collected = Math.round(Number(tradeAmt));
    const expected = Math.round(Number(order.total));
    if (collected !== expected) {
      console.error(
        `[webhooks/payuni] AMOUNT MISMATCH order=${orderNo} collected=${collected} expected=${expected} — NOT marking paid, needs reconcile`
      );
      return new Response("OK");
    }

    const result = await markOrderPaid(order.id);
    if (!result.ok) {
      console.error("[webhooks/payuni] markOrderPaid failed:", result.error);
      return new Response("order update failed; please retry", { status: 500 });
    }
  } else if (isFailed) {
    // 已付款訂單不會被這裡動到(上面 TERMINAL_STATUSES 已經短路)。這裡完全不碰
    // orders.status(本專案的訂單狀態機沒有 failed,寫了會違反 CHECK constraint),
    // 只留一個正規化 marker 給 /api/orders/status 判斷「確認中」還是「付款失敗」。
    if (order.status !== "paid") {
      const { error: markErr } = await supabase
        .from("webhook_events")
        .insert({ gateway: "payuni", event_key: `failed_${orderNo}` });
      if (markErr && markErr.code !== "23505") {
        console.error("[webhooks/payuni] failed-marker insert failed:", markErr);
      }
    }
  }
  // TradeStatus="0"(取號成功)/"8"(訂單待確認)或 DataSource="B"(處理中)等未決狀態:
  // 不做任何動作,單純 ack,等後續通知或狀態變化再處理。

  // TODO(沙盒實測待確認):ack 格式。詳見本檔開頭註解。
  return new Response("OK");
}
