import { createClient } from "@/lib/supabase/server";

// route handler 專用的 admin 判斷。
//
// ⚠️ 這與 app/admin/actions.ts 的 requireAdmin() 是「刻意的邏輯重複」,不是漏抽共用:
//   1. requireAdmin() 沒有 export,而且語意是「不是 admin 就 throw」——那是為 server action
//      設計的(表單 catch 到 Error 直接顯示訊息)。route handler 需要的是布林值,
//      才能自己決定回 403 還是繼續往下跑。
//   2. 要共用就得改 requireAdmin() 的簽章或回傳型別,而它被每一支 admin action 呼叫,
//      改它等於一次動到全部後台寫入路徑的錯誤處理。為了省 15 行而承擔那個爆炸半徑不划算。
//
// 兩邊的判斷條件必須保持一致:有登入 + profiles.role === 'admin'。改動其中一邊時要同步另一邊。
export async function isAdminRequest(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return profile?.role === "admin";
}
