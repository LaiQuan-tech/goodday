-- 修復商品庫存超賣(見 web/src/app/api/orders/route.ts 扣庫存段落)。
--
-- 舊實作的兩個疊在一起的缺陷:
--   1. 在建單流程前段讀出 products.stock 快照,數百行後才用「絕對值」寫回
--        update products set stock = <快照 - qty> where id = ? and stock >= qty
--      快照時間與寫回時間之間可能已被其他訂單改動,不是真正的併發安全寫法。
--   2. 更嚴重:那句 update 的回傳值完全沒接、沒檢查 error/count——guard 沒擋到時
--      (或根本沒發動保護)訂單照樣成立、照樣導去金流收錢,是「靜默超賣」的來源。
--
-- 新作法比照本專案課程座位 reserve_course_seat()(20260723000001_courses.sql):
-- 對要扣的商品排序後 FOR UPDATE 鎖列,把同一批商品的併發扣庫存交易序列化;
-- 鎖到之後一律用「相對扣減」(set stock = stock - qty where stock >= qty),
-- 任何一筆 ROW_COUNT = 0 就 RAISE EXCEPTION,讓整個 function 呼叫(單一交易)
-- 全部回滾,不留半扣狀態——多品項訂單全有或全無。
--
-- 鎖列順序:所有呼叫一律用「商品 id 排序」取鎖,避免兩張訂單各自以相反順序
-- 鎖兩件相同商品而互相等待造成死鎖。
--
-- 呼叫端(web/src/app/api/orders/route.ts)必須檢查這支 RPC 回傳的 error;
-- 扣不到庫存時要把剛建立的訂單整張刪除、回 409,不能讓訂單留在「已成立」
-- 但庫存沒真的扣到的狀態。
--
-- 參考:Realreal atomic_deduct_stock()(packages/db/migrations/0028_audit_foundation.sql)。

create or replace function public.deduct_product_stock(p_items jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids      uuid[];
  v_rec      record;
  v_affected int;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return true;
  end if;

  -- 排序後取鎖,所有呼叫都用同一順序,避免死鎖
  select array_agg((elem->>'product_id')::uuid order by (elem->>'product_id')::uuid)
    into v_ids
    from jsonb_array_elements(p_items) as elem;

  perform 1
    from public.products
    where id = any(v_ids)
    order by id
    for update;

  -- 逐項相對扣減;任何一項扣不到就整批回滾(拋出例外會讓整個 function 呼叫
  -- 所在的交易 abort,前面已成功的扣減一併撤銷)
  for v_rec in
    select (elem->>'product_id')::uuid as pid,
           (elem->>'quantity')::int    as qty
      from jsonb_array_elements(p_items) as elem
  loop
    update public.products
      set stock = stock - v_rec.qty
      where id = v_rec.pid
        and stock >= v_rec.qty;
    get diagnostics v_affected = row_count;
    if v_affected = 0 then
      raise exception 'insufficient stock for product %', v_rec.pid using errcode = 'P0001';
    end if;
  end loop;

  return true;
end;
$$;

-- ⚠️ 安全關鍵:比照 reserve_course_seat() 已踩過的坑——security definer 函式
-- 預設 PUBLIC 可 EXECUTE,且 Supabase 另外對 anon/authenticated 有
-- alter default privileges 授權,只 revoke from public 收不到,三個對象缺一不可,
-- 否則任何拿 anon key 的人可以直接打
-- /rest/v1/rpc/deduct_product_stock 任意扣光別人商品的庫存。
revoke execute on function public.deduct_product_stock(jsonb) from public, anon, authenticated;
grant execute on function public.deduct_product_stock(jsonb) to service_role;
