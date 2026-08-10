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
  /**
   * label → 依序消耗的回應佇列。同一個 label 在一次請求中會被打到多次時用
   * (例:orders.select 既是冪等預查、也是撞 unique 之後的 raced 查詢,
   * 兩者要能分別給不同回應)。佇列空了就退回 results[label]。
   */
  resultsQueue: {} as Record<string, QueryResult[]>,
  /** 記錄被 console.error 吐出來的訊息 —— 用來斷言「錯誤有留下痕跡」 */
  logs: [] as string[],
  user: null as { id: string } | null,
  /** auth.getUser() 要回傳的 error(訪客是 AuthSessionMissingError,不是失敗) */
  authError: null as { name: string; message: string } | null,
  /** auth.getUser() 直接 throw(連 supabase client 都建不起來的情境) */
  authThrows: false,
  /** auth.getUser() 被呼叫幾次(不進 state.calls,以免動到既有的 toEqual 序列斷言) */
  authCalls: 0,
  pointsBalance: 0,
  /** getPointsBalance 的 ok:false = 餘額「查不到」,不是「餘額為 0」 */
  pointsBalanceOk: true,
  companySettingOk: true,
  shippingSettingOk: true,
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

  const resultFor = (label: string): QueryResult => {
    const queue = state.resultsQueue[label];
    if (queue && queue.length > 0) return queue.shift() as QueryResult;
    return state.results[label] ?? { data: null, error: null };
  };

  // 這條鏈同時是 thenable(route 有 `await supabase.from(x).delete().eq(...)`
  // 這種直接 await builder 的寫法)也帶 .single()/.maybeSingle()。
  //
  // ⚠️ 一條鏈只向 resultFor() 取一次值,之後 .single()/.maybeSingle() 沿用同一個 ——
  // 否則一次查詢會從 resultsQueue 消耗掉兩筆。
  function makeChain(label: string): Chain {
    const result = resultFor(label);
    const chain = Promise.resolve(result) as Chain;
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    chain.single = () => Promise.resolve(result);
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
      auth: {
        // 刻意不寫進 state.calls:那個序列被既有測試逐項比對(toEqual),
        // 多塞一筆就會動到既有斷言。
        getUser: () => {
          state.authCalls++;
          if (state.authThrows) return Promise.reject(new Error("auth client exploded"));
          return Promise.resolve({
            data: { user: state.authError ? null : state.user },
            error: state.authError,
          });
        },
      },
    }),
}));

vi.mock("@/lib/points", () => ({
  getPointsBalance: () =>
    Promise.resolve({
      balance: state.pointsBalance,
      expiringSoon: 0,
      ok: state.pointsBalanceOk,
    }),
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

vi.mock("@/lib/settings", () => {
  const company = {
    name: "好日子",
    tagline: "",
    email: "shop@example.test",
    phone: "0212345678",
    address: "台北市測試路 1 號",
  };
  const shipping = { fee_home: 120, free_threshold_home: 3000, deadline_days: 3 };
  return {
    getCompanyProfile: () => Promise.resolve(company),
    getShippingConfig: () => Promise.resolve(shipping),
    // *Result 版本多帶一個 ok:false = 「讀不到,value 是硬編的 fallback」。
    // 注意 value 這裡仍給正確值 —— 測的是 route 有沒有因為 ok:false 就停下來,
    // 而不是它會不會用到錯的數字(用了就更糟)。
    getCompanyProfileResult: () =>
      Promise.resolve({ value: company, ok: state.companySettingOk }),
    getShippingConfigResult: () =>
      Promise.resolve({ value: shipping, ok: state.shippingSettingOk }),
  };
});

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
  state.logs.length = 0;
  state.resultsQueue = {};
  state.user = null;
  state.authError = null;
  state.authThrows = false;
  state.authCalls = 0;
  state.pointsBalance = 0;
  state.pointsBalanceOk = true;
  state.companySettingOk = true;
  state.shippingSettingOk = true;
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

function checkout(
  items: CartItem[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
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
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

/** state.calls 中某個副作用的位置;找不到回 -1 */
const at = (label: string) => state.calls.indexOf(label);

/** 這次請求的錯誤 log 裡有沒有出現某個 scope(用來斷言「錯誤沒有被靜默吞掉」) */
const logged = (scope: string) => state.logs.some((line) => line.includes(scope));

/** orders.insert 實際寫進去的欄位 */
const insertedOrder = () =>
  state.writes.find((w) => w.table === "orders" && w.op === "insert")?.payload as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  setupHappyPath([ARTWORK]);
  // 內容收進 state.logs:reportIssue() 一定會 console.error,所以這是「錯誤有沒有
  // 留下痕跡」最直接的觀測點(Sentry 那一半由 tests/observability.test.ts 釘)。
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    state.logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
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

// ===========================================================================
// 以下為第二批:靜默吞錯(`const { data } = await supabase...` 把 error 解構掉)
//
// 共通症狀:「查詢失敗」與「查無資料」在程式裡長得一模一樣,於是錯誤被吞掉、流程
// 帶著壞資料繼續往下走。每個 describe 對應 route.ts 的一處,並標明該處判定為
// fail-closed 還是 fail-open,以及「把修法拿掉會發生什麼」。
// ===========================================================================

const IDEMPOTENT = { "Idempotency-Key": "idem-key-1" };
const DB_DOWN = { code: "57014", message: "canceling statement due to statement timeout" };

// ---------------------------------------------------------------------------
// route.ts 冪等預查 —— fail-closed
//
// 理由:冪等的意義就是「不確定有沒有建過就不要再建一次」。查詢失敗時舊寫法得到
// existing=null,與「這個 key 沒建過單」完全同義 → 直接建新單。
//
// 改壞方式(必須讓下面測試變紅):把 `error: existingErr` 解構拿掉、不檢查。
// ---------------------------------------------------------------------------
describe("冪等預查失敗必須擋下(fail-closed)", () => {
  it("預查查詢失敗時回 503,而且絕不建立新訂單", async () => {
    state.resultsQueue["orders.select"] = [{ data: null, error: DB_DOWN }];

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], {}, IDEMPOTENT);

    expect(res.status).toBe(503);
    // 核心:查不出來就不能建單(否則同一個 key 可能已經有單了)
    expect(state.calls).not.toContain("orders.insert");
    expect(state.calls).not.toContain("payments.createPayment");
    // 錯誤不能無聲消失
    expect(logged("orders.idempotency-precheck-failed")).toBe(true);
  });

  it("預查查到既有訂單時照樣回既有 token(冪等本身不被改壞)", async () => {
    state.resultsQueue["orders.select"] = [
      { data: { public_token: "existing-token" }, error: null },
    ];

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], {}, IDEMPOTENT);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ orderToken: "existing-token" });
    expect(state.calls).not.toContain("orders.insert");
  });
});

// ---------------------------------------------------------------------------
// route.ts 撞 unique 之後的 raced 查詢 —— fail-closed(整支最危險的一處)
//
// 理由:23505 已經證明「有一列的 idempotency_key 撞到了」= 訂單存在。此時 raced
// 查詢再失敗,舊寫法會往下掉、回 500「訂單建立失敗」—— 訂單其實已經建好了。客人
// 看到失敗就會重下單,重下單會拿到新的 Idempotency-Key,於是變成真的重複下單。
//
// 改壞方式(必須讓下面測試變紅):把 `error: racedErr` 解構拿掉、不檢查。
// ---------------------------------------------------------------------------
describe("撞 unique 後的 raced 查詢失敗必須擋下(fail-closed)", () => {
  const UNIQUE_ERR = {
    code: "23505",
    message: 'duplicate key value violates unique constraint "orders_idempotency_key_key"',
  };

  it("raced 查詢也失敗時不可回「訂單建立失敗」,要明確叫客人不要重下單", async () => {
    state.results["orders.insert"] = { data: null, error: UNIQUE_ERR };
    state.resultsQueue["orders.select"] = [
      { data: null, error: null }, // 預查:當時還沒有
      { data: null, error: DB_DOWN }, // raced:查詢失敗
    ];

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], {}, IDEMPOTENT);
    const body = (await res.json()) as { error: string };

    // 500 +「訂單建立失敗」正是會誘發客人重下單的組合,絕不能是它
    expect(res.status).toBe(503);
    expect(body.error).not.toBe("訂單建立失敗");
    expect(body.error).toContain("請勿重複下單");
    expect(logged("orders.idempotency-raced-lookup-failed")).toBe(true);
  });

  it("raced 查得到既有訂單時仍回既有 token(既有安全網不被改壞)", async () => {
    state.results["orders.insert"] = { data: null, error: UNIQUE_ERR };
    state.resultsQueue["orders.select"] = [
      { data: null, error: null },
      { data: { public_token: "raced-token" }, error: null },
    ];

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], {}, IDEMPOTENT);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ orderToken: "raced-token" });
  });

  it("查得到但沒有這一列(23505 來自別的 unique 約束)仍是貨真價實的建單失敗 → 500", async () => {
    state.results["orders.insert"] = {
      data: null,
      error: { code: "23505", message: 'duplicate key ... "orders_order_no_key"' },
    };
    state.resultsQueue["orders.select"] = [
      { data: null, error: null },
      { data: null, error: null }, // 查詢成功,但真的沒有這個 idempotency_key
    ];

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], {}, IDEMPOTENT);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "訂單建立失敗" });
  });
});

// ---------------------------------------------------------------------------
// route.ts auth.getUser() —— fail-closed(後果最重的一處)
//
// 理由:「auth 查不出來」被壓成 userId = null 之後,一個真的登入中的客人會拿到
// user_id 為 null 的訂單 —— 永遠不歸戶:點數不發、課程觀看權拿不到、會員升級不
// 生效。客人付了錢卻拿不到東西,而且那張單看起來就是一張正常的訪客單,事後查不出來。
//
// 「訪客本來就沒登入」則是完全正常的路徑,必須照樣能下單。auth-js 在沒有 session
// 時回的 error 是 AuthSessionMissingError,這是兩者唯一可靠的分界。
//
// 改壞方式(必須讓下面測試變紅):把整段還原成 try { ... } catch {} 並不接 error。
// ---------------------------------------------------------------------------
describe("auth 失敗 vs 訪客未登入必須分開(fail-closed)", () => {
  it("訪客(AuthSessionMissingError):照樣下單成功,user_id 為 null", async () => {
    state.authError = { name: "AuthSessionMissingError", message: "Auth session missing!" };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(200);
    expect(state.authCalls).toBe(1);
    expect(insertedOrder()?.user_id).toBeNull();
  });

  it("登入中:訂單確實綁到該帳號", async () => {
    state.user = { id: "user-1" };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(200);
    expect(insertedOrder()?.user_id).toBe("user-1");
  });

  it("auth 服務連不上(AuthRetryableFetchError):回 503 且絕不建立不歸戶的訂單", async () => {
    state.authError = { name: "AuthRetryableFetchError", message: "Failed to fetch" };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(503);
    // 這一條是核心:寧可不建單,也不要建一張永遠歸不了戶的單
    expect(state.calls).not.toContain("orders.insert");
    expect(state.calls).not.toContain("payments.createPayment");
    expect(logged("orders.auth-getuser-failed")).toBe(true);
  });

  it("JWT 失效(AuthApiError 401):同樣擋下,不當成訪客", async () => {
    state.authError = { name: "AuthApiError", message: "invalid claim: missing sub claim" };

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(503);
    expect(state.calls).not.toContain("orders.insert");
  });

  it("getUser() 直接 throw:也是「查不出來」,不是「訪客」", async () => {
    state.authThrows = true;

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(503);
    expect(state.calls).not.toContain("orders.insert");
    expect(logged("orders.auth-getuser-failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// route.ts 結帳設定(運費/免運門檻/匯款帳號)—— fail-closed
//
// 理由:settings 讀不到時 getSetting() 回硬編 fallback(fee_home=200 /
// free_threshold_home=10000),與線上實際設定不同 → 等於用一組猜的價錢跟客人收錢。
// company.bank_info 更是匯款信裡的收款帳號,取不到會寄出一封沒有帳號的請款信。
//
// 改壞方式(必須讓下面測試變紅):改回 getCompanyProfile()/getShippingConfig()
// 這組 fail-open 版本,不看 ok。
// ---------------------------------------------------------------------------
describe("結帳設定讀不到時必須擋下(fail-closed)", () => {
  it("運費設定讀取失敗 → 503,不以預設運費建單", async () => {
    state.shippingSettingOk = false;

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(503);
    expect(state.calls).not.toContain("orders.insert");
    expect(logged("orders.settings-unavailable")).toBe(true);
  });

  it("公司資料讀取失敗 → 503,不寄出沒有匯款帳號的訂單信", async () => {
    state.companySettingOk = false;

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }]);

    expect(res.status).toBe(503);
    expect(state.calls).not.toContain("orders.insert");
    expect(state.calls).not.toContain("mail.customer");
  });
});

// ---------------------------------------------------------------------------
// route.ts 點數餘額 —— fail-closed,但訊息要誠實
//
// 理由:getPointsBalance 查詢失敗時舊寫法 fallback 成 0,於是有 500 點的客人被擋成
// 「點數餘額不足」。錢沒少(這是 fail-closed),但訊息是錯的 —— 客人與客服都會往
// 「我的點數不見了」的方向查,而真正的原因是 DB 查詢失敗。
//
// 改壞方式(必須讓下面測試變紅):拿掉 `ok` 判斷,只看 balance。
// ---------------------------------------------------------------------------
describe("點數餘額查不到時不可謊稱餘額不足(fail-closed)", () => {
  it("餘額查詢失敗 → 503,且訊息不是「點數餘額不足」", async () => {
    state.user = { id: "user-1" };
    state.pointsBalanceOk = false;
    state.pointsBalance = 0; // 舊寫法的 fallback 就是這個 0

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], { pointsUsed: 100 });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(503);
    expect(body.error).not.toBe("點數餘額不足");
    expect(state.calls).not.toContain("orders.insert");
    expect(logged("orders.points-balance-unavailable")).toBe(true);
  });

  it("餘額查得到但真的不足 → 維持原本的 400「點數餘額不足」", async () => {
    state.user = { id: "user-1" };
    state.pointsBalanceOk = true;
    state.pointsBalance = 50;

    const res = await checkout([{ productId: ARTWORK.id, quantity: 1 }], { pointsUsed: 100 });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "點數餘額不足" });
  });
});
