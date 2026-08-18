-- 修掉 Supabase Security Advisor 的項目,外加一個 advisor 沒抓到、但實際更嚴重的外洩。
--
-- ⚠️ 本檔手動單獨執行,不可跑 provision.mjs(_migrations 與實際 schema 早已不同步,
--    會重跑舊檔撞「already exists」)。執行後手動 insert 進 _migrations。
--
-- 【advisor 沒標、但最嚴重的一項】
-- v_user_points_balance / v_expirable_earn_points 建立時沒有指定 security_invoker,
-- 因此是 SECURITY DEFINER view(以 owner=postgres 的權限執行),而 anon/authenticated
-- 又被授了 ALL。實測(全部在 rollback 的交易內驗證):
--    anon 讀 points_ledger              → 0 筆        (RLS 有擋)
--    anon 讀 v_user_points_balance      → 2 位使用者的餘額全出來(RLS 被繞過)
--    anon 透過 v_expirable_earn_points DELETE → 真的刪掉 points_ledger 的列
-- 也就是:只要有公開的 anon key,任何人都能讀走全站點數餘額,並刪除點數紀錄。

-- 1) view 改成以呼叫者權限執行,並收回 anon/authenticated 的授權。
--    app 端三個消費點全部走 service_role(BYPASSRLS),不受影響:
--      web/src/lib/points.ts          createAdminClient()
--      web/src/app/admin/members/     createAdminClient()
--      api/src/jobs.ts                SUPABASE_SERVICE_ROLE_KEY
alter view public.v_user_points_balance   set (security_invoker = on);
alter view public.v_expirable_earn_points set (security_invoker = on);
revoke all on public.v_user_points_balance   from public, anon, authenticated;
revoke all on public.v_expirable_earn_points from public, anon, authenticated;

-- 2) _migrations 開 RLS,刻意不建任何 policy → 只有 service_role / postgres 進得去。
--    provision.mjs 走 Management API 的 database/query(以 postgres 執行),不受影響。
alter table public._migrations enable row level security;

-- 3) touch_updated_at 鎖 search_path。函式體只用到 now()(pg_catalog,永遠隱含在
--    search_path 最前面),所以空字串就夠,不需要保留 public。
alter function public.touch_updated_at() set search_path = '';

-- 4) 收回兩個不該從 PostgREST 打得到的 SECURITY DEFINER 函式。
--    ⚠️⚠️ 一定要含 public。proacl 裡的 `=X/postgres` 就是 PUBLIC 的授權,
--         只寫 revoke ... from anon, authenticated 完全沒有效果(已實測:revoke 後
--         anon 照樣呼叫得到)。這與 reserve_course_seat 當初踩的是同一個坑的反面。
--
--    ai_rate_check   目前任何人都能打 /rest/v1/rpc/ai_rate_check,灌爆全站每日 3000 次
--                    AI 額度,或拿別人的 IP 去把對方的每日 60 次打完鎖死。
--                    呼叫端只有 web/src/app/api/chat/route.ts 與 .../chat/mockup/route.ts,
--                    兩支都用 tryCreateAdminClient()(service_role)。
--    handle_new_user auth.users 的 trigger function。trigger 觸發不需要呼叫者持有
--                    EXECUTE(Postgres 在 CREATE TRIGGER 當下就檢查完),收回安全。
revoke execute on function public.ai_rate_check(text, int, int) from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
