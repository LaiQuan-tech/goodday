-- 把 is_admin() 從 public 搬到 PostgREST 不曝露的 private schema。
--
-- 為什麼不能照 advisor 字面「revoke EXECUTE」:實測過,revoke 之後
--   以 anon 執行 select count(*) from public.products
--   → ERROR 42501 permission denied for function is_admin
-- 因為 is_admin() 被 23 條 RLS policy 引用,RLS 運算式會以查詢者身分求值,
-- 少了 EXECUTE 等於整個前台商店直接死。(WARN 本身也寫 "if that is not intentional")
--
-- 也不能改成 SECURITY INVOKER:is_admin() 讀 public.profiles,而 profiles 的
-- profiles_select_own policy 又是 (auth.uid() = id) OR is_admin() → 無限遞迴。
--
-- 唯一乾淨解:搬到 private schema。anon/authenticated 仍持有 USAGE + EXECUTE
-- (policy 需要),但 PostgREST 的 db-schemas 只有 public / graphql_public,
-- 打不到 /rest/v1/rpc/is_admin,advisor 的 0028/0029 也只掃曝露的 schema。

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated, service_role;

-- 以下 23 條逐字取自改動前的 pg_policies.qual,只把 is_admin() 換成
-- private.is_admin(),其餘一字未動。全部都是 PERMISSIVE、roles={public}、
-- 且只有 USING 沒有 WITH CHECK,所以 ALTER POLICY 只需要改 USING。

-- [ALL] ai_chat_logs.chat_logs_admin
alter policy chat_logs_admin on public.ai_chat_logs
  using (private.is_admin());

-- [ALL] ai_usage.ai_usage_admin
alter policy ai_usage_admin on public.ai_usage
  using (private.is_admin());

-- [ALL] bookings.bookings_admin_all
alter policy bookings_admin_all on public.bookings
  using (private.is_admin());

-- [SELECT] course_access.course_access_select_own
alter policy course_access_select_own on public.course_access
  using (((auth.uid() = user_id) OR private.is_admin()));

-- [ALL] course_details.course_details_admin_write
alter policy course_details_admin_write on public.course_details
  using (private.is_admin());

-- [SELECT] course_details.course_details_public_read
alter policy course_details_public_read on public.course_details
  using (((EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = course_details.product_id) AND (p.status = 'active'::text)))) OR private.is_admin()));

-- [ALL] course_enrollments.course_enrollments_admin_write
alter policy course_enrollments_admin_write on public.course_enrollments
  using (private.is_admin());

-- [SELECT] course_enrollments.course_enrollments_select_own
alter policy course_enrollments_select_own on public.course_enrollments
  using (((auth.uid() = user_id) OR private.is_admin()));

-- [ALL] course_lessons.course_lessons_admin_all
alter policy course_lessons_admin_all on public.course_lessons
  using (private.is_admin());

-- [ALL] membership_tiers.membership_tiers_admin_write
alter policy membership_tiers_admin_write on public.membership_tiers
  using (private.is_admin());

-- [ALL] order_items.order_items_admin_write
alter policy order_items_admin_write on public.order_items
  using (private.is_admin());

-- [SELECT] order_items.order_items_select_own
alter policy order_items_select_own on public.order_items
  using ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_items.order_id) AND ((o.user_id = auth.uid()) OR private.is_admin())))));

-- [ALL] orders.orders_admin_write
alter policy orders_admin_write on public.orders
  using (private.is_admin());

-- [SELECT] orders.orders_select_own
alter policy orders_select_own on public.orders
  using (((auth.uid() = user_id) OR private.is_admin()));

-- [SELECT] points_ledger.points_ledger_select_own
alter policy points_ledger_select_own on public.points_ledger
  using (((auth.uid() = user_id) OR private.is_admin()));

-- [ALL] products.products_admin_write
alter policy products_admin_write on public.products
  using (private.is_admin());

-- [SELECT] products.products_public_read
alter policy products_public_read on public.products
  using (((status = 'active'::text) OR private.is_admin()));

-- [SELECT] profiles.profiles_select_own
alter policy profiles_select_own on public.profiles
  using (((auth.uid() = id) OR private.is_admin()));

-- [UPDATE] profiles.profiles_update_own
alter policy profiles_update_own on public.profiles
  using (((auth.uid() = id) OR private.is_admin()));

-- [ALL] quotes.quotes_admin_write
alter policy quotes_admin_write on public.quotes
  using (private.is_admin());

-- [SELECT] quotes.quotes_select_own
alter policy quotes_select_own on public.quotes
  using (((auth.uid() = user_id) OR private.is_admin()));

-- [ALL] settings.settings_admin
alter policy settings_admin on public.settings
  using (private.is_admin());

-- [SELECT] webhook_events.webhook_events_admin_read
alter policy webhook_events_admin_read on public.webhook_events
  using (private.is_admin());

-- 沒有 CASCADE:只要上面漏改任何一條 policy,這行就會因為相依而失敗,
-- 整個交易 rollback。這是這支 migration 的完整性保險。
drop function public.is_admin();
