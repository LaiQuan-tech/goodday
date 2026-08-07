import { NextRequest, NextResponse } from "next/server";
import { tryCreateAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PAID_LIKE = new Set(["paid", "processing", "shipped", "completed"]);

/**
 * GET /api/orders/status?no=<order_no> — 供 checkout/confirm 頁輪詢用。
 * 只回付款狀態層級資訊 { status },不回 public_token / total 等個資或可用來冒領
 * 訂單頁的憑證 —— order_no 本身可猜測(遞增/短字串),若連 public_token 一起回傳,
 * 等於讓任何人靠猜 order_no 就拿到能查看訂單詳情的 token(IDOR)。訂單連結改由
 * markOrderPaid 寄出的付款成功確認信提供(該信已內含 /orders/<token>)。
 *
 * status 值:
 *   "paid"      — orders.status 已是 paid 或更後面(processing/shipped/completed)
 *   "cancelled" — 訂單已被取消(理論上不會在 card 結帳流程中發生,防禦性處理)
 *   "failed"    — webhook 反查權威結果 TradeStatus="2"(付款失敗)/"3"(付款取消),但訂單仍是 pending
 *   "pending"   — 其餘情況(含 PayUni 反查狀態 "0" 取號成功 /"8" 待確認、尚未收到任何 webhook)
 */
export async function GET(req: NextRequest) {
  const orderNo = req.nextUrl.searchParams.get("no")?.trim().slice(0, 40);
  if (!orderNo) {
    return NextResponse.json({ error: "缺少訂單編號" }, { status: 400 });
  }

  const supabase = tryCreateAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "系統尚未完成設定" }, { status: 503 });
  }

  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("order_no", orderNo)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "找不到訂單" }, { status: 404 });
  }

  let status: "paid" | "pending" | "failed" | "cancelled";
  if (PAID_LIKE.has(order.status)) {
    status = "paid";
  } else if (order.status === "cancelled") {
    status = "cancelled";
  } else {
    const { data: failedMarker } = await supabase
      .from("webhook_events")
      .select("event_key")
      .eq("gateway", "payuni")
      .eq("event_key", `failed_${orderNo}`)
      .maybeSingle();
    status = failedMarker ? "failed" : "pending";
  }

  return NextResponse.json({ status });
}
