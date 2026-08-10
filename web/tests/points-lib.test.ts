/**
 * lib/points.ts 的靜默吞錯迴歸測試。
 *
 * 這支檔案的存在理由:points.ts 原本有 9 處 `const { data } = await supabase...`
 * —— error 被解構掉、不看。於是「查詢失敗」與「查無資料」在程式裡完全同義,
 * 錯誤被靜默吞掉、流程帶著壞資料繼續走。每個 describe 釘住其中一處,並標明它
 * 判定為 fail-closed(擋下)還是 fail-open(降級但留痕跡)。
 *
 * 判定原則:
 *   會寫進 points_ledger / profiles 的(= 錢與權益)→ fail-closed。
 *     尤其 points_ledger 有 dedupe unique index (user_id, source, source_ref_id),
 *     寫錯的金額**永久固定**、事後補不回來 —— 所以「寧可不寫,之後重試」。
 *   純顯示、算不出來可以不顯示的 → fail-open,但一定要 reportIssue。
 *
 * 全部 hermetic:supabase admin client 與 observability 一律 vi.mock 假掉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "@/lib/types";

type QueryResult = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  /** 依實際發生順序記錄每一次查詢/寫入 */
  calls: [] as string[],
  /** 每次寫入類操作(insert/update)的 table 與 payload */
  writes: [] as Array<{ op: string; table: string; payload: unknown }>,
  /** label(`${table}.${op}`)→ 假回應 */
  results: {} as Record<string, QueryResult>,
  /** label → 依序消耗的回應佇列(同一個 label 在一支函式裡被打多次時用) */
  queue: {} as Record<string, QueryResult[]>,
  /** reportIssue() 被呼叫時記下的 scope —— 「錯誤有沒有留下痕跡」的觀測點 */
  reported: [] as string[],
}));

vi.mock("@/lib/observability", () => ({
  reportIssue: (scope: string) => {
    state.reported.push(scope);
  },
}));

vi.mock("@/lib/supabase/admin", () => {
  type Chain = Promise<QueryResult> & {
    select: () => Chain;
    eq: () => Chain;
    in: () => Chain;
    not: () => Chain;
    gt: () => Chain;
    lte: () => Chain;
    is: () => Chain;
    order: () => Chain;
    limit: () => Chain;
    maybeSingle: () => Promise<QueryResult>;
    single: () => Promise<QueryResult>;
  };

  const resultFor = (label: string): QueryResult => {
    const q = state.queue[label];
    if (q && q.length > 0) return q.shift() as QueryResult;
    return state.results[label] ?? { data: null, error: null };
  };

  // 一條鏈只取一次值,之後 .maybeSingle() 沿用同一個 —— 否則一次查詢會吃掉兩筆佇列。
  function makeChain(label: string): Chain {
    const result = resultFor(label);
    const chain = Promise.resolve(result) as Chain;
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.not = () => chain;
    chain.gt = () => chain;
    chain.lte = () => chain;
    chain.is = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    chain.single = () => Promise.resolve(result);
    return chain;
  }

  function record(table: string, op: string, payload?: unknown): Chain {
    const label = `${table}.${op}`;
    state.calls.push(label);
    if (op === "insert" || op === "update" || op === "upsert") {
      state.writes.push({ op, table, payload });
    }
    return makeChain(label);
  }

  const client = {
    from: (table: string) => ({
      select: () => record(table, "select"),
      insert: (payload: unknown) => record(table, "insert", payload),
      update: (payload: unknown) => record(table, "update", payload),
      upsert: (payload: unknown) => record(table, "upsert", payload),
      delete: () => record(table, "delete"),
    }),
  };

  return { createAdminClient: () => client, tryCreateAdminClient: () => client };
});

const {
  getPointsBalance,
  getPointsLedger,
  getMemberTier,
  getMemberTierResult,
  grantPointsForOrder,
  redeemPointsForOrder,
  refundPointsForOrder,
  applyMembershipPurchase,
} = await import("@/lib/points");

const DB_DOWN = { code: "57014", message: "canceling statement due to statement timeout" };

function makeOrder(patch: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    order_no: "IV-2026-00001",
    user_id: "user-1",
    total: 1000,
    points_used: 0,
    points_earned: 0,
    contact_name: "王小明",
    contact_email: "buyer@example.test",
    contact_phone: "0912345678",
    ...patch,
  } as Order;
}

/** 某個 table 上有沒有發生過寫入 */
const wroteTo = (table: string) => state.writes.some((w) => w.table === table);

beforeEach(() => {
  state.calls.length = 0;
  state.writes.length = 0;
  state.reported.length = 0;
  state.results = {};
  state.queue = {};
});

// ---------------------------------------------------------------------------
// getPointsBalance:餘額 —— fail-closed(回 ok:false,由呼叫端擋)
//
// 理由:舊寫法查詢失敗會 fallback 成 balance 0,於是有 500 點的客人在結帳時收到
// 「點數餘額不足」。單被擋掉(錢沒少),但訊息是錯的,客人與客服都會往
// 「我的點數不見了」的方向查。「餘額為 0」與「餘額查不到」必須是兩件事。
//
// 改壞方式(必須讓下面測試變紅):把 `error: balanceError` 解構拿掉、不檢查,
// 改回 `const balance = (balanceRow?.balance) ?? 0`。
// ---------------------------------------------------------------------------
describe("getPointsBalance:餘額查不到 ≠ 餘額為 0", () => {
  it("餘額查詢失敗 → ok:false(而不是安靜地回 balance 0)", async () => {
    state.results["v_user_points_balance.select"] = { data: null, error: DB_DOWN };

    const result = await getPointsBalance("user-1");

    expect(result.ok).toBe(false);
    expect(result.balance).toBe(0); // 值仍是 0,但 ok:false 讓呼叫端知道那是「查不到」
    expect(state.reported).toContain("points.balance-query-failed");
  });

  it("查得到時 ok:true,並正確扣掉已沖銷的到期點數", async () => {
    state.results["v_user_points_balance.select"] = { data: { balance: 500 }, error: null };
    state.queue["points_ledger.select"] = [
      { data: [{ id: "e1", delta: 30 }, { id: "e2", delta: 20 }], error: null }, // 即將到期
      { data: [{ source_ref_id: "e2" }], error: null }, // e2 已經被收回過
    ];

    const result = await getPointsBalance("user-1");

    expect(result).toEqual({ balance: 500, expiringSoon: 30, ok: true });
    expect(state.reported).toEqual([]);
  });

  it("「即將到期」查詢失敗是 fail-open:餘額照回 ok:true,但錯誤要留痕跡", async () => {
    state.results["v_user_points_balance.select"] = { data: { balance: 500 }, error: null };
    state.queue["points_ledger.select"] = [{ data: null, error: DB_DOWN }];

    const result = await getPointsBalance("user-1");

    // expiringSoon 只是前端軟提示,算不出來不該連累 balance 的可信度
    expect(result).toEqual({ balance: 500, expiringSoon: 0, ok: true });
    expect(state.reported).toContain("points.expiring-earn-query-failed");
  });

  it("「已沖銷哪些」查不到時寧可不顯示 expiringSoon(硬算會給出偏大的數字)", async () => {
    state.results["v_user_points_balance.select"] = { data: { balance: 500 }, error: null };
    state.queue["points_ledger.select"] = [
      { data: [{ id: "e1", delta: 30 }], error: null },
      { data: null, error: DB_DOWN },
    ];

    const result = await getPointsBalance("user-1");

    expect(result).toEqual({ balance: 500, expiringSoon: 0, ok: true });
    expect(state.reported).toContain("points.expired-refs-query-failed");
  });
});

// ---------------------------------------------------------------------------
// getPointsLedger:明細清單 —— fail-open(純顯示)
//
// 改壞方式:把 `error` 解構拿掉 → reported 為空,測試紅。
// ---------------------------------------------------------------------------
describe("getPointsLedger:查詢失敗回空清單但要留痕跡(fail-open)", () => {
  it("查詢失敗時回 [],且 reportIssue 有被呼叫", async () => {
    state.results["points_ledger.select"] = { data: null, error: DB_DOWN };

    await expect(getPointsLedger("user-1")).resolves.toEqual([]);
    expect(state.reported).toContain("points.ledger-query-failed");
  });
});

// ---------------------------------------------------------------------------
// getMemberTier:會員等級 —— fail-closed(回 ok:false,由 grantPointsForOrder 擋)
//
// 理由:等級決定回饋率。查詢失敗被當成「無等級」就會用預設 1% 發點數給高等級會員,
// 而 points_ledger 的 dedupe unique index 讓那個錯誤金額**永久固定** —— 事後補發
// 會撞唯一索引寫不進去。寧可不發(還能重試),也不要發錯(補不回來)。
//
// 改壞方式:把兩個 `error` 解構拿掉 → 下面 grantPointsForOrder 那條會照樣寫入,測試紅。
// ---------------------------------------------------------------------------
describe("getMemberTier:查不到等級 ≠ 沒有等級", () => {
  it("profiles 查詢失敗 → ok:false", async () => {
    state.results["profiles.select"] = { data: null, error: DB_DOWN };

    const result = await getMemberTierResult("user-1");

    expect(result).toEqual({ tier: null, ok: false });
    expect(state.reported).toContain("points.member-tier-profile-query-failed");
  });

  it("membership_tiers 查詢失敗 → ok:false", async () => {
    state.results["profiles.select"] = {
      data: { tier_slug: "gold", tier_expires_at: null },
      error: null,
    };
    state.results["membership_tiers.select"] = { data: null, error: DB_DOWN };

    const result = await getMemberTierResult("user-1");

    expect(result).toEqual({ tier: null, ok: false });
    expect(state.reported).toContain("points.member-tier-query-failed");
  });

  it("真的沒有等級 → ok:true、tier null(與查詢失敗分得開)", async () => {
    state.results["profiles.select"] = { data: { tier_slug: null }, error: null };

    await expect(getMemberTierResult("user-1")).resolves.toEqual({ tier: null, ok: true });
    // 顯示用的 fail-open 版本行為不變
    await expect(getMemberTier("user-1")).resolves.toBeNull();
    expect(state.reported).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// grantPointsForOrder:核發消費回饋 —— fail-closed
// ---------------------------------------------------------------------------
describe("grantPointsForOrder:等級查不到就不發點數(fail-closed)", () => {
  it("等級查詢失敗時絕不寫 points_ledger(錯誤金額會被 dedupe index 永久固定)", async () => {
    state.results["profiles.select"] = { data: null, error: DB_DOWN };

    await grantPointsForOrder(makeOrder({ total: 10000 }));

    expect(wroteTo("points_ledger")).toBe(false);
    expect(state.reported).toContain("points.grant-skipped-tier-unknown");
  });

  it("等級查得到就照常發(fail-closed 不能把正常路徑一起擋掉)", async () => {
    state.results["profiles.select"] = {
      data: { tier_slug: "gold", tier_expires_at: null },
      error: null,
    };
    state.results["membership_tiers.select"] = {
      data: { slug: "gold", rebate_rate: 5, sort: 10 },
      error: null,
    };

    await grantPointsForOrder(makeOrder({ total: 10000 }));

    const insert = state.writes.find((w) => w.table === "points_ledger");
    expect((insert?.payload as { delta: number }).delta).toBe(500); // 10000 × 5%
  });
});

// ---------------------------------------------------------------------------
// redeemPointsForOrder:折抵 —— fail-closed,但訊息要誠實
// ---------------------------------------------------------------------------
describe("redeemPointsForOrder:餘額查不到時不寫 ledger、也不謊稱餘額不足", () => {
  it("餘額查詢失敗 → 不寫 points_ledger,錯誤訊息不是「點數餘額不足」", async () => {
    state.results["v_user_points_balance.select"] = { data: null, error: DB_DOWN };

    const result = await redeemPointsForOrder("user-1", "order-1", 100);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toBe("點數餘額不足");
    expect(wroteTo("points_ledger")).toBe(false);
  });

  it("餘額查得到但真的不足 → 維持原本的「點數餘額不足」", async () => {
    state.results["v_user_points_balance.select"] = { data: { balance: 50 }, error: null };

    const result = await redeemPointsForOrder("user-1", "order-1", 100);

    expect(result).toEqual({ ok: false, error: "點數餘額不足" });
    expect(wroteTo("points_ledger")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refundPointsForOrder:取消訂單回沖 —— fail-open(擋不住)但必須叫出來
//
// 理由:訂單此刻已經是 cancelled,這裡 return 早了也回不去。但「查詢失敗」代表客人
// 留著一張已取消訂單的回饋點數,需要有人去補沖銷 —— 靜靜跳過就永遠沒人知道。
// ---------------------------------------------------------------------------
describe("refundPointsForOrder:找不到 earn 紀錄時要叫出來(fail-open)", () => {
  it("earn 查詢失敗 → reportIssue,且不寫任何沖銷", async () => {
    // points_used 的退回先寫一筆(insert),接著才查 earn
    state.results["points_ledger.select"] = { data: null, error: DB_DOWN };

    await refundPointsForOrder(makeOrder({ points_used: 0, points_earned: 100 }));

    expect(state.reported).toContain("points.refund-earn-lookup-failed");
    expect(wroteTo("points_ledger")).toBe(false);
  });

  it("earn 查得到 → 照常寫入 expire 沖銷(正常路徑不變)", async () => {
    state.results["points_ledger.select"] = { data: { id: "earn-1", delta: 100 }, error: null };

    await refundPointsForOrder(makeOrder({ points_used: 0, points_earned: 100 }));

    const insert = state.writes.find((w) => w.table === "points_ledger");
    expect(insert?.payload).toMatchObject({ delta: -100, source: "expire", source_ref_id: "earn-1" });
    expect(state.reported).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyMembershipPurchase:會員升級 —— fail-open(錢已收)但每一步都要叫出來
//
// 理由:這支跑在「客人已經付完會員費」之後。任何一個查詢失敗被吞掉,結果都是
// 「付了錢但等級沒升」,而且靜悄悄的。這裡沒東西可擋(收款已完成),所以唯一能做的
// 就是讓它進 Sentry 由人工補上。最後那個 profiles.update 舊寫法連回傳值都沒接。
// ---------------------------------------------------------------------------
describe("applyMembershipPurchase:付了錢沒升級不可以無聲無息", () => {
  it("order_items 查詢失敗 → reportIssue,且不會誤動 profiles", async () => {
    state.results["order_items.select"] = { data: null, error: DB_DOWN };

    await applyMembershipPurchase(makeOrder());

    expect(state.reported).toContain("membership.order-items-query-failed");
    expect(wroteTo("profiles")).toBe(false);
  });

  it("membership_tiers 查詢失敗 → reportIssue,且不會誤動 profiles", async () => {
    state.results["order_items.select"] = { data: [{ tier_slug: "gold" }], error: null };
    state.results["membership_tiers.select"] = { data: null, error: DB_DOWN };

    await applyMembershipPurchase(makeOrder());

    expect(state.reported).toContain("membership.tiers-query-failed");
    expect(wroteTo("profiles")).toBe(false);
  });

  it("profiles.update 失敗 → reportIssue(舊寫法連回傳值都沒接,成功失敗分不出來)", async () => {
    state.results["order_items.select"] = { data: [{ tier_slug: "gold" }], error: null };
    state.results["membership_tiers.select"] = { data: [{ slug: "gold", sort: 10 }], error: null };
    state.results["profiles.update"] = { data: null, error: DB_DOWN };

    await applyMembershipPurchase(makeOrder());

    expect(state.reported).toContain("membership.profile-upgrade-failed");
  });

  it("一切正常時照樣升級,且不誤報(fail-open 不能把正常路徑弄髒)", async () => {
    state.results["order_items.select"] = { data: [{ tier_slug: "gold" }], error: null };
    state.results["membership_tiers.select"] = { data: [{ slug: "gold", sort: 10 }], error: null };

    await applyMembershipPurchase(makeOrder());

    const update = state.writes.find((w) => w.table === "profiles" && w.op === "update");
    expect((update?.payload as { tier_slug: string }).tier_slug).toBe("gold");
    expect(state.reported).toEqual([]);
  });
});
