// 「查詢失敗」不可以消失得無影無蹤。
//
// 這個 repo 的訂單路徑上散落著 `const { data } = await supabase...` —— 把 error
// 解構掉不看,於是「查詢失敗」和「查無資料」在程式裡長得一模一樣。修法分兩類:
//
//   fail-closed(金流/歸戶/冪等):查詢失敗就明確報錯擋下流程,不帶著壞資料往前走。
//   fail-open(純顯示/可降級):照樣走預設值,但**必須留下可觀測的痕跡** —— 就是這支。
//
// console.error 進 Vercel log(事後查得到),Sentry.captureException 進告警
// (事發當下有人知道)。兩者都做,因為只有 log 沒人會去看。
//
// ⚠️ 這支永遠不 throw。告警管道掛掉不能反過來弄壞它在監看的那條主流程
// (同 api/src/lib/alert.ts 的立場)。
import * as Sentry from "@sentry/nextjs";

export type IssueExtra = Record<string, unknown>;

function toError(scope: string, detail: unknown): Error {
  if (detail instanceof Error) return detail;
  if (typeof detail === "object" && detail !== null && "message" in detail) {
    const supabaseError = detail as { message?: unknown; code?: unknown };
    const err = new Error(`${scope}: ${String(supabaseError.message)}`);
    err.name = supabaseError.code ? `SupabaseError(${String(supabaseError.code)})` : "SupabaseError";
    return err;
  }
  return new Error(`${scope}: ${String(detail)}`);
}

/**
 * 記錄一個「本來會被靜默吞掉」的錯誤。
 *
 * @param scope 出事的位置,例如 "orders.idempotency-precheck"。會變成 Sentry tag,
 *              方便直接對到程式碼中的哪一處。
 * @param detail 原始錯誤(Error、PostgrestError 或任何東西)
 * @param extra  一起帶上的關鍵欄位(訂單 id、user id 等)
 */
export function reportIssue(scope: string, detail: unknown, extra?: IssueExtra): void {
  if (extra) {
    console.error(`[${scope}]`, detail, extra);
  } else {
    console.error(`[${scope}]`, detail);
  }

  try {
    Sentry.captureException(toError(scope, detail), {
      tags: { scope },
      extra,
    });
  } catch (err) {
    // Sentry 自己炸掉不能連累呼叫端
    console.error("[observability] Sentry 上報失敗:", err);
  }
}
