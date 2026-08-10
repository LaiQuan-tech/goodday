/**
 * lib/observability.ts —— fail-open 的那一半修法靠這支撐著。
 *
 * 判斷原則是「純顯示、可降級的可以 fail-open,但必須留下可觀測的痕跡」。痕跡就是
 * reportIssue():console.error 進 Vercel log(事後查得到)+ Sentry.captureException
 * 進告警(事發當下有人知道)。這支測試釘住那兩條線真的都接上了 —— 否則 points.ts /
 * settings.ts 那些 fail-open 分支就只是換個寫法繼續靜默吞錯。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  captured: [] as Array<{ error: unknown; hint: unknown }>,
  captureThrows: false,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (error: unknown, hint: unknown) => {
    if (state.captureThrows) throw new Error("Sentry transport exploded");
    state.captured.push({ error, hint });
    return "event-id";
  },
}));

const { reportIssue } = await import("@/lib/observability");

beforeEach(() => {
  state.captured.length = 0;
  state.captureThrows = false;
});

describe("reportIssue:錯誤同時進 log 與 Sentry", () => {
  it("console.error 帶上 scope(Vercel log 這條線)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportIssue("orders.auth-getuser-failed", new Error("boom"));

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("orders.auth-getuser-failed");
    spy.mockRestore();
  });

  it("Sentry.captureException 有被呼叫,且帶 scope tag 與 extra(告警這條線)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportIssue("orders.settings-unavailable", new Error("boom"), { orderId: "order-1" });

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].hint).toEqual({
      tags: { scope: "orders.settings-unavailable" },
      extra: { orderId: "order-1" },
    });
    spy.mockRestore();
  });

  it("Supabase 的 PostgrestError(不是 Error 實例)也會被包成 Error 送出去", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportIssue("points.balance-query-failed", { code: "57014", message: "statement timeout" });

    const sent = state.captured[0].error as Error;
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toContain("statement timeout");
    expect(sent.name).toBe("SupabaseError(57014)");
    spy.mockRestore();
  });

  it("Sentry 自己炸掉時不會往外丟 —— 告警管道不能反過來弄壞它在監看的主流程", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.captureThrows = true;

    expect(() => reportIssue("orders.auth-getuser-failed", new Error("boom"))).not.toThrow();
    spy.mockRestore();
  });
});
