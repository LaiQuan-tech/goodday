/**
 * lib/settings.ts 的靜默吞錯迴歸測試。
 *
 * 原本的 getSetting() 是 `const { data } = await ...` 再包一層 try/catch —— 查詢失敗、
 * 連線炸掉、這個 key 根本沒設定過,三件事全部回同一個 fallback,無聲無息。
 *
 * 對「純顯示」的設定(rate_card、quote_config)那樣做沒問題;但同一支函式也供應
 * shipping —— fee_home / free_threshold_home / deadline_days。fallback 是硬編的
 * 200 / 10000 / 3,與線上實際設定不同,所以 DB 一抖就是「用一組猜的價錢跟客人收錢」。
 *
 * 修法:保留 fail-open 的 getSetting()(行為逐字不變,只是不再靜音),另外提供
 * getSettingResult() 帶 ok 旗標,讓金流路徑(POST /api/orders)自己 fail-closed。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  result: { data: null, error: null } as QueryResult,
  /** true = createAdminClient() 直接 throw(env 未設定 / 連線建不起來) */
  clientThrows: false,
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
    maybeSingle: () => Promise<QueryResult>;
  };

  function makeChain(): Chain {
    const chain = Promise.resolve(state.result) as Chain;
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => Promise.resolve(state.result);
    return chain;
  }

  return {
    createAdminClient: () => {
      if (state.clientThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY 未設定");
      return { from: () => ({ select: () => makeChain() }) };
    },
  };
});

const { getSetting, getSettingResult, getShippingConfigResult, getCompanyProfileResult } =
  await import("@/lib/settings");

const DB_DOWN = { code: "57014", message: "canceling statement due to statement timeout" };
const FALLBACK = { fee_home: 200, free_threshold_home: 10000, deadline_days: 3 };

beforeEach(() => {
  state.result = { data: null, error: null };
  state.clientThrows = false;
  state.reported.length = 0;
});

// ---------------------------------------------------------------------------
// 改壞方式(必須讓下面測試變紅):把 getSettingResult 的 `error` 解構拿掉、
// 永遠回 ok:true(等同還原成舊的 getSetting)。
// ---------------------------------------------------------------------------
describe("getSettingResult:查詢失敗 ≠ 這個 key 沒設定過", () => {
  it("查詢失敗 → ok:false,並留下痕跡", async () => {
    state.result = { data: null, error: DB_DOWN };

    const result = await getSettingResult("shipping", FALLBACK);

    expect(result).toEqual({ value: FALLBACK, ok: false });
    expect(state.reported).toContain("settings.load-failed");
  });

  it("client 建不起來(env 未設定)→ ok:false,並留下痕跡", async () => {
    state.clientThrows = true;

    const result = await getSettingResult("shipping", FALLBACK);

    expect(result).toEqual({ value: FALLBACK, ok: false });
    expect(state.reported).toContain("settings.load-threw");
  });

  it("查詢成功但這個 key 沒設定過 → ok:true 用 fallback(這才是 fallback 該出場的時機)", async () => {
    state.result = { data: null, error: null };

    const result = await getSettingResult("shipping", FALLBACK);

    expect(result).toEqual({ value: FALLBACK, ok: true });
    expect(state.reported).toEqual([]);
  });

  it("查得到就回 DB 的值", async () => {
    const live = { fee_home: 120, free_threshold_home: 3000, deadline_days: 5 };
    state.result = { data: { value: live }, error: null };

    await expect(getSettingResult("shipping", FALLBACK)).resolves.toEqual({
      value: live,
      ok: true,
    });
  });
});

describe("getSetting:fail-open 行為不變,但錯誤不再靜音", () => {
  it("查詢失敗仍回 fallback(顯示用呼叫端零改動),但 reportIssue 有被呼叫", async () => {
    state.result = { data: null, error: DB_DOWN };

    await expect(getSetting("rate_card", { note: "", items: [] })).resolves.toEqual({
      note: "",
      items: [],
    });
    expect(state.reported).toContain("settings.load-failed");
  });
});

describe("結帳用的 *Result 版本", () => {
  it("shipping 讀不到時 ok:false,而 fallback 的運費與線上設定並不相同", async () => {
    state.result = { data: null, error: DB_DOWN };

    const result = await getShippingConfigResult();

    expect(result.ok).toBe(false);
    // 這組硬編值正是「DB 一抖就用猜的價錢收錢」的來源 —— 所以 route 必須看 ok 而不是看 value
    expect(result.value).toEqual(FALLBACK);
  });

  it("company 讀不到時 ok:false,且 fallback 沒有 bank_info(匯款信會沒有收款帳號)", async () => {
    state.result = { data: null, error: DB_DOWN };

    const result = await getCompanyProfileResult();

    expect(result.ok).toBe(false);
    expect(result.value.bank_info).toBeUndefined();
  });
});
