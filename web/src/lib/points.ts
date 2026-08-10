import { createAdminClient } from "@/lib/supabase/admin";
import { reportIssue } from "@/lib/observability";
import type { MembershipTier, Order, PointsLedgerEntry } from "@/lib/types";

// 點數規則(仿 realreal points_ledger):
//  * 1 點 = NT$1(redeem 時折抵)
//  * earn 冪等靠 points_ledger_dedupe unique index (user_id, source, source_ref_id)
//  * 無等級會員預設回饋 1%
const DEFAULT_REBATE_RATE = 1;
const POINTS_EXPIRE_DAYS = 365;

const UNIQUE_VIOLATION = "23505";

function db() {
  return createAdminClient();
}

export type PointsBalance = {
  balance: number;
  expiringSoon: number;
  /**
   * false = 餘額**查不到**(不是「餘額為 0」)。舊寫法把查詢失敗 fallback 成 0,
   * 於是有 500 點的客人在結帳時會收到「點數餘額不足」—— 錢沒少,但單被擋掉,
   * 而且訊息是錯的(客人會以為自己的點數不見了)。呼叫端必須自己分辨:
   *   顯示用(account / checkout 頁)→ fail-open,照樣顯示 0 就好
   *   金流用(POST /api/orders)     → fail-closed,回「暫時無法確認」而非「餘額不足」
   */
  ok: boolean;
};

export async function getPointsBalance(userId: string): Promise<PointsBalance> {
  const supabase = db();

  const { data: balanceRow, error: balanceError } = await supabase
    .from("v_user_points_balance")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (balanceError) {
    reportIssue("points.balance-query-failed", balanceError, { userId });
    return { balance: 0, expiringSoon: 0, ok: false };
  }
  const balance = (balanceRow?.balance as number | undefined) ?? 0;

  // 30 天內到期(近似值:未計入之後可能發生的 redeem,僅供前端軟提示)
  //
  // 以下兩個查詢是 fail-open:expiringSoon 只是前端的軟提示,算不出來就當作 0,
  // 絕不因此把 balance 判成不可信(balance 本身已經查到了)。但錯誤要留痕跡。
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400000).toISOString();
  const { data: earnRows, error: earnError } = await supabase
    .from("points_ledger")
    .select("id, delta")
    .eq("user_id", userId)
    .eq("source", "earn")
    .not("expires_at", "is", null)
    .gt("expires_at", now.toISOString())
    .lte("expires_at", in30Days);
  if (earnError) {
    reportIssue("points.expiring-earn-query-failed", earnError, { userId });
    return { balance, expiringSoon: 0, ok: true };
  }

  let expiringSoon = 0;
  if (earnRows && earnRows.length > 0) {
    const ids = earnRows.map((r) => r.id as string);
    const { data: expiredRefs, error: expiredError } = await supabase
      .from("points_ledger")
      .select("source_ref_id")
      .eq("user_id", userId)
      .eq("source", "expire")
      .in("source_ref_id", ids);
    if (expiredError) {
      // 查不到「已沖銷過哪些」就不能算 expiringSoon —— 硬算會把已收回的點數也算進
      // 「即將到期」,給客人看一個偏大的數字。寧可不顯示。
      reportIssue("points.expired-refs-query-failed", expiredError, { userId });
      return { balance, expiringSoon: 0, ok: true };
    }
    const alreadyExpired = new Set((expiredRefs ?? []).map((r) => r.source_ref_id as string));
    expiringSoon = earnRows
      .filter((r) => !alreadyExpired.has(r.id as string))
      .reduce((sum, r) => sum + (r.delta as number), 0);
  }

  return { balance, expiringSoon, ok: true };
}

export async function getPointsLedger(
  userId: string,
  opts?: { limit?: number }
): Promise<PointsLedgerEntry[]> {
  const supabase = db();
  const { data, error } = await supabase
    .from("points_ledger")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 50);
  if (error) {
    // fail-open:這是帳戶頁的明細清單,純顯示。查不到就顯示空清單(與原行為相同),
    // 但錯誤要留痕跡 —— 否則「明細怎麼空了」永遠查不出原因。
    reportIssue("points.ledger-query-failed", error, { userId });
    return [];
  }
  return (data ?? []) as PointsLedgerEntry[];
}

/**
 * 會員等級查詢結果。`ok=false` = 查不到(不是「沒有等級」)。
 *
 * 兩者必須分開,因為 grantPointsForOrder 用它決定回饋率:查詢失敗被當成「無等級」
 * 就會用預設 1% 發點數給高等級會員,而 points_ledger 的 dedupe unique index
 * (user_id, source, source_ref_id)會讓那個錯誤金額**永久固定**——事後補發會撞
 * 唯一索引寫不進去。寧可不發(之後還能重試),也不要發錯。
 */
export type MemberTierResult = { tier: MembershipTier | null; ok: boolean };

// 會員目前等級(已過期視為無等級,不影響 profiles.tier_slug 本身 — 到期清除交由後續排程處理)
export async function getMemberTierResult(userId: string): Promise<MemberTierResult> {
  const supabase = db();
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("tier_slug, tier_expires_at")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) {
    reportIssue("points.member-tier-profile-query-failed", profileError, { userId });
    return { tier: null, ok: false };
  }
  if (!profile?.tier_slug) return { tier: null, ok: true };
  if (profile.tier_expires_at && new Date(profile.tier_expires_at) < new Date()) {
    return { tier: null, ok: true };
  }

  const { data: tier, error: tierError } = await supabase
    .from("membership_tiers")
    .select("*")
    .eq("slug", profile.tier_slug)
    .maybeSingle();
  if (tierError) {
    reportIssue("points.member-tier-query-failed", tierError, {
      userId,
      tierSlug: profile.tier_slug,
    });
    return { tier: null, ok: false };
  }
  return { tier: (tier as MembershipTier | null) ?? null, ok: true };
}

/** fail-open 版本(顯示用,行為與修改前相同:查不到就當作無等級) */
export async function getMemberTier(userId: string): Promise<MembershipTier | null> {
  const { tier } = await getMemberTierResult(userId);
  return tier;
}

// 訂單狀態 → paid 時呼叫:依會員等級回饋率核發點數,365 天到期
export async function grantPointsForOrder(order: Order) {
  if (!order.user_id) return; // 訪客訂單無帳號可歸戶,不核發點數
  const supabase = db();

  // fail-closed:等級查不到就不發點數。理由見 MemberTierResult 的註解 ——
  // points_ledger 的 dedupe unique index 會讓錯誤金額永久化,不發還能重試,發錯不能。
  const { tier, ok: tierOk } = await getMemberTierResult(order.user_id);
  if (!tierOk) {
    reportIssue("points.grant-skipped-tier-unknown", new Error("會員等級查詢失敗,略過本次點數核發"), {
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
    });
    return;
  }
  const rebateRate = tier?.rebate_rate ?? DEFAULT_REBATE_RATE;
  const earned = Math.floor((order.total * rebateRate) / 100);
  if (earned <= 0) return;

  const expiresAt = new Date(Date.now() + POINTS_EXPIRE_DAYS * 86400000).toISOString();
  const { error } = await supabase.from("points_ledger").insert({
    user_id: order.user_id,
    delta: earned,
    source: "earn",
    source_ref_id: order.id,
    note: `訂單 ${order.order_no} 消費回饋`,
    expires_at: expiresAt,
  });

  if (error) {
    if (error.code !== UNIQUE_VIOLATION) {
      console.error("[points] grant failed:", error);
    }
    return; // 已核發過(冪等)或失敗,不覆寫 points_earned
  }

  await supabase.from("orders").update({ points_earned: earned }).eq("id", order.id);
}

// 建單時呼叫:1 點 = NT$1,server 端驗證餘額後寫入 redeem 負項
export async function redeemPointsForOrder(
  userId: string,
  orderId: string,
  points: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (points <= 0) return { ok: true };
  const supabase = db();

  // fail-closed:餘額查不到就不寫 ledger(寫下去等於承認一筆沒驗證過的折抵),
  // 但訊息不能謊稱「餘額不足」—— 那會讓客服往完全錯的方向查。
  const { balance, ok: balanceOk } = await getPointsBalance(userId);
  if (!balanceOk) return { ok: false, error: "點數餘額暫時無法確認,請稍後再試" };
  if (points > balance) return { ok: false, error: "點數餘額不足" };

  const { error } = await supabase.from("points_ledger").insert({
    user_id: userId,
    delta: -points,
    source: "redeem",
    source_ref_id: orderId,
    note: "訂單折抵",
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: true }; // 已折抵過,冪等視為成功
    console.error("[points] redeem failed:", error);
    return { ok: false, error: "點數折抵失敗" };
  }
  return { ok: true };
}

// 訂單取消時呼叫:回沖已使用的折抵、收回已核發的消費回饋(對稱寫入,靠 dedupe 冪等)
export async function refundPointsForOrder(order: Order) {
  if (!order.user_id) return;
  const supabase = db();

  if (order.points_used > 0) {
    const { error } = await supabase.from("points_ledger").insert({
      user_id: order.user_id,
      delta: order.points_used,
      source: "refund",
      source_ref_id: order.id,
      note: `訂單 ${order.order_no} 取消,退回折抵點數`,
    });
    if (error && error.code !== UNIQUE_VIOLATION) {
      console.error("[points] refund redeem failed:", error);
    }
  }

  if (order.points_earned > 0) {
    const { data: earnRow, error: earnError } = await supabase
      .from("points_ledger")
      .select("id, delta")
      .eq("user_id", order.user_id)
      .eq("source", "earn")
      .eq("source_ref_id", order.id)
      .maybeSingle();
    // fail-open(擋不住):訂單此刻已經改成 cancelled,這裡 return 早了也回不去。
    // 但「查詢失敗」與「本來就沒發過回饋」的後果差很多:前者代表客人留著一張已取消
    // 訂單的回饋點數,必須有人去補沖銷。所以一定要叫出來,不能靜靜跳過。
    if (earnError) {
      reportIssue("points.refund-earn-lookup-failed", earnError, {
        orderId: order.id,
        orderNo: order.order_no,
        userId: order.user_id,
        pointsEarned: order.points_earned,
      });
    } else if (earnRow) {
      // 沿用「expire」語意收回(與到期排程共用同一組冪等 key,避免日後又被排程重複沖銷)
      const { error } = await supabase.from("points_ledger").insert({
        user_id: order.user_id,
        delta: -(earnRow.delta as number),
        source: "expire",
        source_ref_id: earnRow.id,
        note: `訂單 ${order.order_no} 取消,收回消費回饋點數`,
      });
      if (error && error.code !== UNIQUE_VIOLATION) {
        console.error("[points] revoke earn failed:", error);
      }
    }
  }
}

// 管理員手動調點(可正可負)
export async function adjustPoints(
  userId: string,
  delta: number,
  note: string,
  actorId: string
) {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("調整點數須為非零整數");
  }
  const supabase = db();
  const { error } = await supabase.from("points_ledger").insert({
    user_id: userId,
    delta,
    source: "manual_adjust",
    note: `${note || "後台手動調整"}(操作人:${actorId})`,
  });
  if (error) throw new Error(error.message);
}

// 會員方案商品付款後呼叫:寫入 profiles.tier_slug,效期 +1 年
export async function applyMembershipPurchase(order: Order) {
  if (!order.user_id) return;
  const supabase = db();

  // ⚠️ 這支跑在「客人已經付完錢」之後。以下每一個查詢失敗如果被吞掉,結果都是
  // 「客人付了會員費但等級沒升」——而且靜悄悄的,沒有任何人會發現(客人自己也未必
  // 立刻察覺)。這裡沒辦法 fail-closed 擋下什麼(錢已經收了),所以一律 reportIssue
  // 讓它進 Sentry,由人工補上。
  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("tier_slug")
    .eq("order_id", order.id)
    .eq("purchase_mode", "membership")
    .not("tier_slug", "is", null);
  if (itemsError) {
    reportIssue("membership.order-items-query-failed", itemsError, {
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
    });
    return;
  }
  if (!items || items.length === 0) return;

  const slugs = [...new Set(items.map((i) => i.tier_slug as string))];
  const { data: tiers, error: tiersError } = await supabase
    .from("membership_tiers")
    .select("slug, sort")
    .in("slug", slugs);
  if (tiersError) {
    reportIssue("membership.tiers-query-failed", tiersError, {
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
      slugs,
    });
    return;
  }
  if (!tiers || tiers.length === 0) return;

  // 同筆訂單理論上只會有一個會員方案商品;若有多個,取等級最高(sort 最大)者
  const best = [...tiers].sort((a, b) => (b.sort as number) - (a.sort as number))[0];
  const expiresAt = new Date(Date.now() + POINTS_EXPIRE_DAYS * 86400000).toISOString();

  const { error: upgradeError } = await supabase
    .from("profiles")
    .update({ tier_slug: best.slug, tier_expires_at: expiresAt })
    .eq("id", order.user_id);
  if (upgradeError) {
    // 這一行是整支最後一步:寫不進去就是「錢收了、等級沒升」,而舊寫法連回傳值
    // 都沒接,失敗與成功完全分不出來。
    reportIssue("membership.profile-upgrade-failed", upgradeError, {
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
      tierSlug: best.slug,
    });
  }
}
