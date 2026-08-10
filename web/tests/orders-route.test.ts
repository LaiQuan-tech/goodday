/**
 * 訂單建立流程(POST /api/orders)的迴歸測試。
 *
 * 這支測試的存在理由:route.ts 的副作用順序是
 *     建 order → 建 order_items → 課程搶位 → 扣庫存 → 扣點數
 * 這個順序目前只靠註解維繫,而它一旦被無聲破壞,後果是「錢的問題」
 * (超賣、點數帳本要沖銷、課程名額被卡死)。以下三個 describe 各釘住一條規約:
 *
 *   規約 1  扣庫存必須在扣點數之前
 *   規約 2  扣庫存失敗時,必須先 release_course_seats_for_order() 才能刪單
 *   規約 3  扣庫存走 deduct_product_stock() RPC,且必須檢查回傳的 error
 *
 * 全部 hermetic:supabase / resend / 金流 / 點數 / 課程模組一律 vi.mock 假掉,
 * 不連任何 DB、Redis 或外部 API。斷言方式是把每個副作用依「實際發生順序」寫進
 * state.calls,再對這個序列做位置比較 —— 這樣才咬得住「順序」本身,而不只是
 * 「有沒有被呼叫」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type QueryResult = { data: unknown; error: unknown };

// vi.mock 的工廠會被提升到 import 之前執行,共用狀態必須用 vi.hoisted 建立。
const state = vi.hoisted(() => ({
  /** 依實際發生順序記錄每一個副作用,順序斷言全靠它 */
  calls: [] as string[],
  /** 每次 supabase.rpc() 的函式名與參數 */
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** 每次寫入類操作(insert/update)的 table 與 payload */
  writes: [] as Array<{ op: string; table: string; payload: unknown }>,
  /** label(如 "orders.insert" / "rpc:deduct_product_stock")→ 假回應 */
  results: {} as Record<string, QueryResult>,
  user: null as { id: string } | null,
  pointsBalance: 0,
  reserveResult: { ok: true, reserved: 0 } as unknown,
  redeemResult: { ok: true } as unknown,
}));

vi.mock("@/lib/supabase/admin", () => {
  type ChainMethods = {
    select: () => Chain;
    eq: () => Chain;
    in: () => Chain;
    maybeSingle: () => Promise<QueryResult>;
    single: () => Promise<QueryResult>;
  };
  type Chain = Promise<QueryResult> & ChainMethods;

  const resultFor = (label: string): QueryResult =>
    state.results[label] ?? { data: null, error: null };

  // 這條鏈同時是 thenable(route 有 `await supabase.from(x).delete().eq(...)`
  // 這種直接 await builder 的寫法)也帶 .single()/.maybeSingle()。
  function makeChain(label: string): Chain {
    const chain = Promise.resolve(resultFor(label)) as Chain;
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.maybeSingle = () => Promise.resolve(resultFor(label));
    chain.single = () => Promise.resolve(resultFor(label));
    return chain;
  }

  function record(table: string, op: string, payload?: unknown): Chain {
    const label = `${table}.${op}`;
    state.calls.push(label);
    if (op === "insert" || op === "update") {
      state.writes.push({ op, table, payload });
    }
    return makeChain(label);
  }

  const client = {
    from: (table: string) => ({
      select: () => record(table, "select"),
      insert: (payload: unknown) => record(table, "insert", payload),
      update: (payload: unknown) => record(table, "update", payload),
      delete: () => record(table, "delete"),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.calls.push(`rpc:${fn}`);
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(resultFor(`rpc:${fn}`));
    },
  };

  return {
    tryCreateAdminClient: () => client,
    createAdminClient: () => client,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: state.user }, error: null }) },
    }),
}));

vi.mock("@/lib/points", () => ({
  getPointsBalance: () => Promise.resolve({ balance: state.pointsBalance, expiringSoon: 0 }),
  redeemPointsForOrder: () => {
    state.calls.push("points.redeem");
    return Promise.resolve(state.redeemResult);
  },
}));

vi.mock("@/lib/courses", () => ({
  reserveSeatsForOrder: () => {
    state.calls.push("courses.reserveSeats");
    return Promise.resolve(state.reserveResult);
  },
}));

vi.mock("@/lib/payments", () => ({
  isCardPaymentAvailable: () => false,
  createPayment: () => {
    state.calls.push("payments.createPayment");
    return Promise.resolve(null);
  },
}));

vi.mock("@/lib/resend", () => ({
  sendMail: () => {
    state.calls.push("mail.customer");
    return Promise.resolve();
  },
  notifyAdmin: () => {
    state.calls.push("mail.admin");
    return Promise.resolve();
  },
  emailShell: (_title: string, body: string) => body,
  siteUrl: () => "http://localhost:3000",
}));

vi.mock("@/lib/settings", () => ({
  getCompanyProfile: () =>
    Promise.resolve({
      name: "好日子",
      tagline: "",
      email: "shop@example.test",
      phone: "0212345678",
      address: "台北市測試路 1 號",
    }),
  getShippingConfig: () =>
    Promise.resolve({ fee_home: 120, free_threshold_home: 3000, deadline_days: 3 }),
}));

// route 必須在所有 vi.mock 之後才 import
const { POST } = await import("@/app/api/orders/route");

const ARTWORK = {
  id: "prod-artwork",
  name: "測試畫作",
  name_en: null,
  price: 1000,
  price_rental_monthly: null,
  stock: 5,
  status: "active",
  product_type: "artwork",
  metadata: {},
};

const COURSE = {
  id: "prod-course",
  name: "測試課程",
  name_en: null,
  price: 800,
  price_rental_monthly: null,
  stock: 0,
  status: "active",
  product_type: "course",
  metadata: {},
};

const ORDER = {
  id: "order-1",
  order_no: "IV-2026-00001",
  public_token: "public-token-1",
  total: 1120,
  contact_name: "王小明",
  contact_email: "buyer@example.test",
  contact_phone: "0912345678",
  created_at: "2026-08-10T00:00:00.000Z",
  locale: "zh",
};

/** 建立一個乾淨的「一切順利」情境,個別測試再覆寫需要的 key */
function setupHappyPath(products: unknown[]) {
  state.calls.length = 0;
  state.rpcCalls.length = 0;
  state.writes.length = 0;
  state.user = null;
  state.pointsBalance = 0;
  state.reserveResult = { ok: true, reserved: 1 };
  state.redeemResult = { ok: true };
  state.results = {
    "products.select": { data: products, error: null },
    "orders.select": { data: null, error: null },
    "orders.insert": { data: ORDER, error: null },
    "orders.update": { data: null, error: null },
    "orders.delete": { data: null, error: null },
    "order_items.insert": { data: null, error: null },
    "order_items.delete": { data: null, error: null },
    "rpc:deduct_product_stock": { data: null, error: null },
    "rpc:release_course_seats_for_order": { data: null, error: null },
  };
}

type CartItem = { productId: string; quantity: number; mode?: string };

function checkout(items: CartItem[], extra: Record<string, unknown> = {}) {
  const body = {
    items,
    contact: {
      name: "王小明",
      email: "buyer@example.test",
      phone: "0912345678",
      note: "",
    },
    shipping: {
      method: "home",
      county: "台北市",
      district: "中正區",
      postal: "100",
      detail: "測試路 1 號",
    },
    payment_method: "bank_transfer",
    ...extra,
  };
  return POST(
    new NextRequest("http://localhost:3000/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** state.calls 中某個副作用的位置;找不到回 -1 */
const at = (label: string) => state.calls.indexOf(label);

beforeEach(() => {
  setupHappyPath([ARTWORK]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// 前置:先確認 happy path 本身是通的。若這組壞了,下面三條規約的「沒被呼叫」
// 類斷言就會因為根本沒跑到那段程式而假性通過。
// ---------------------------------------------------------------------------
describe("前置:happy path 的副作用序列", () => {
  it("實體商品訂單依序建單 → 建品項 → 扣庫存 → 導金流", async () => {
    const res = await checkout([{ productId: ARTWORK.id, quantity: 2 }]);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ orderToken: ORDER.public_token });
    expect(state.calls).toEqual([
      "products.select",
      "orders.insert",
      "order_items.insert",
      "rpc:deduct_product_stock",
      "payments.createPayment",
      "mail.customer",
      "mail.admin",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 規約 1:扣庫存必須在扣點數之前
//
// 理由:扣庫存失敗要刪單。若點數已經扣掉,就得回滾 points_ledger —— 那是不可變
// 帳本,回滾必須再寫一筆沖銷。把扣庫存排在前面,失敗路徑就完全不用碰點數。
//
// 改壞方式(必須讓下面測試變紅):把扣點數那段搬到扣庫存之前。
// ---------------------------------------------------------------------------
describe("規約 1:扣庫存必須在扣點數之前", () => {
  it("成功路徑:deduct_product_stock 的位置在 points.redeem 之前", async () => {
    state.user = { id: "user-1" };
    state.pointsBalance = 500;

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], { pointsUsed: 100 });

    expect(res.status).toBe(200);
    expect(at("rpc:deduct_product_stock")).toBeGreaterThanOrEqual(0);
    expect(at("points.redeem")).toBeGreaterThanOrEqual(0);
    expect(at("rpc:deduct_product_stock")).toBeLessThan(at("points.redeem"));
  });

  it("扣庫存失敗時完全不碰點數(不需要沖銷 points_ledger)", async () => {
    state.user = { id: "user-1" };
    state.pointsBalance = 500;
    state.results["rpc:deduct_product_stock"] = {
      data: null,
      error: { message: "stock not enough" },
    };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], { pointsUsed: 100 });

    expect(res.status).toBe(409);
    // 這是本條規約的核心:失敗路徑一次都不能呼叫到扣點數
    expect(state.calls).not.toContain("points.redeem");
    // 而且訂單要被清乾淨,不留一張扣了點數卻沒庫存的孤兒單
    expect(state.calls).toContain("orders.delete");
  });
});

// ---------------------------------------------------------------------------
// 規約 2:扣庫存失敗時,必須先 release_course_seats_for_order() 才能刪單
//
// 理由:course_enrollments.order_id 的 FK 是 on delete set null。先刪訂單會把
// order_id 抹成 null,退位函式就再也找不到那些保留,seats_taken 永遠回不來
// (名額被一張不存在的訂單卡死)。
//
// 改壞方式(必須讓下面測試變紅):把 release RPC 移到兩個 delete 之後。
// ---------------------------------------------------------------------------
describe("規約 2:扣庫存失敗時,退位必須早於刪單", () => {
  beforeEach(() => {
    setupHappyPath([ARTWORK, COURSE]);
    state.user = { id: "user-1" };
    state.results["rpc:deduct_product_stock"] = {
      data: null,
      error: { message: "stock not enough" },
    };
  });

  it("release_course_seats_for_order 的位置早於 orders.delete 與 order_items.delete", async () => {
    const res = await checkout([
      { productId: ARTWORK.id, quantity: 1 },
      { productId: COURSE.id, quantity: 1 },
    ]);

    expect(res.status).toBe(409);
    const release = at("rpc:release_course_seats_for_order");
    expect(release).toBeGreaterThanOrEqual(0); // 有呼叫到退位
    expect(release).toBeLessThan(at("orders.delete"));
    expect(release).toBeLessThan(at("order_items.delete"));
  });

  it("退位帶的是這張訂單的 id(order_id 被抹掉前才對得回保留)", async () => {
    await checkout([
      { productId: ARTWORK.id, quantity: 1 },
      { productId: COURSE.id, quantity: 1 },
    ]);

    const release = state.rpcCalls.find((c) => c.fn === "release_course_seats_for_order");
    expect(release?.args).toEqual({ p_order_id: ORDER.id });
  });

  it("沒有課程品項時不必呼叫退位(純實體訂單失敗路徑維持原樣)", async () => {
    setupHappyPath([ARTWORK]);
    state.results["rpc:deduct_product_stock"] = {
      data: null,
      error: { message: "stock not enough" },
    };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(409);
    expect(state.calls).not.toContain("rpc:release_course_seats_for_order");
    expect(state.calls).toContain("orders.delete");
  });
});

// ---------------------------------------------------------------------------
// 規約 3:扣庫存走 deduct_product_stock() RPC,且必須檢查回傳的 error
//
// 理由:舊實作是「讀 stock 快照 → 數百行後寫絕對值」,而且 update 的回傳值沒接
// 沒檢查,扣不到也照樣把客人導去金流收錢 —— 這就是靜默超賣的來源。
//
// 改壞方式(必須讓下面測試變紅):
//   (a) 不接 error(`await supabase.rpc(...)` 不解構)→ 失敗照樣回 200 並導金流
//   (b) 改回 products.update 寫絕對值 → RPC 斷言與 no-update 斷言雙紅
// ---------------------------------------------------------------------------
describe("規約 3:扣庫存走 deduct_product_stock RPC 且檢查 error", () => {
  it("呼叫的是 deduct_product_stock,帶的是相對扣減量而非絕對庫存值", async () => {
    const res = await checkout([{ productId: ARTWORK.id, quantity: 2 }]);

    expect(res.status).toBe(200);
    const stockRpc = state.rpcCalls.find((c) => c.fn === "deduct_product_stock");
    expect(stockRpc).toBeDefined();
    // quantity 是「要扣掉幾件」(2),不是「扣完剩幾件」(5 - 2 = 3)。
    // 寫絕對值就是舊實作靜默超賣的成因(讀快照與寫入之間別人也在下單)。
    expect(stockRpc?.args).toEqual({
      p_items: [{ product_id: ARTWORK.id, quantity: 2 }],
    });
  });

  it("絕不用 products.update 寫絕對庫存值", async () => {
    await checkout([{ productId: ARTWORK.id, quantity: 2 }]);

    expect(state.calls).not.toContain("products.update");
    expect(state.writes.filter((w) => w.table === "products")).toEqual([]);
  });

  it("RPC 回 error 時必須擋下:回 409、刪單、且絕不導去金流", async () => {
    state.results["rpc:deduct_product_stock"] = {
      data: null,
      error: { message: "商品 prod-artwork 庫存不足" },
    };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 2 }]);

    expect(res.status).toBe(409);
    // 這一條是「有沒有真的檢查回傳 error」的照妖鏡:沒接 error 就會一路走到金流。
    expect(state.calls).not.toContain("payments.createPayment");
    expect(state.calls).not.toContain("mail.customer");
    expect(state.calls).toContain("order_items.delete");
    expect(state.calls).toContain("orders.delete");
  });

  it("非實體商品(課程)不進扣庫存,stock 恆為 0 也不會被誤擋", async () => {
    setupHappyPath([COURSE]);
    state.user = { id: "user-1" };

    const res = await checkout([{ productId: COURSE.id, quantity: 1 }]);

    expect(res.status).toBe(200);
    expect(state.calls).not.toContain("rpc:deduct_product_stock");
    expect(state.calls).toContain("courses.reserveSeats");
  });
});
