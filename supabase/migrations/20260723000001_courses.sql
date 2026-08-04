-- 課程系統
--   報名型課程(live):有日期、有名額上限,可免費報名或付費報名
--   線上預錄課程(recorded):付費購買後可觀看多支 YouTube 單元影片
--
-- 設計:沿用 products(product_type='course')以繼承既有金流、點數折抵、
--      後端查價防篡改與購物車;課程專屬資料放以下四張子表。
--
-- 慣例:裸 DDL(由 scripts/provision.mjs 的 _migrations 表去重,每檔只跑一次)。
--      整檔由 Management API 一次送出,語法錯誤會整份 rollback。

-- ========== 既有 CHECK 放寬 ==========
-- 注意:這兩個 CHECK 是匿名宣告的(add column ... check(...)),名稱由 Postgres
-- 自動生成。用 if exists 避免名稱不符時整份 migration 卡死。
alter table public.products drop constraint if exists products_product_type_check;
alter table public.products add constraint products_product_type_check
  check (product_type in ('artwork', 'journey', 'membership', 'course'));

alter table public.order_items drop constraint if exists order_items_purchase_mode_check;
alter table public.order_items add constraint order_items_purchase_mode_check
  check (purchase_mode in ('buyout', 'rental', 'journey', 'membership', 'course'));

-- ========== 課程細節(與 products 一對一) ==========
create table public.course_details (
  product_id uuid primary key references public.products (id) on delete cascade,
  course_kind text not null check (course_kind in ('live', 'recorded')),
  enrollment_type text not null default 'paid' check (enrollment_type in ('free', 'paid')),
  instructor text not null default '',
  outline text not null default '',
  location text not null default '',
  starts_at timestamptz,
  ends_at timestamptz,
  enroll_deadline timestamptz,
  -- null = 不限名額
  capacity integer check (capacity is null or capacity > 0),
  -- 只能經由本檔的 SQL function 異動,直接 update 會讓名額失準
  seats_taken integer not null default 0 check (seats_taken >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 預錄課程沒有免費報名與名額的概念
  constraint course_details_recorded_is_paid
    check (course_kind = 'live' or enrollment_type = 'paid'),
  constraint course_details_recorded_no_cap
    check (course_kind = 'live' or capacity is null)
);
create index course_details_starts_at_idx on public.course_details (starts_at);

-- ========== 課程單元影片 ==========
-- 只存 11 碼 YouTube video id,不存完整網址:
--   1. ?t= / &list= / &si= 等參數帶進 iframe 會出錯
--   2. 統一格式才能加 CHECK 正規式
-- 本表刻意不開放公開讀(見下方 RLS),影片 id 只由伺服器在驗證購買後吐出。
create table public.course_lessons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  title text not null,
  description text not null default '',
  youtube_video_id text not null check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  is_preview boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index course_lessons_product_idx on public.course_lessons (product_id, sort_order);

-- ========== 報名紀錄 ==========
-- 免費報名:order_id 為 null,建立時即 confirmed
-- 付費報名:建單(pending)時先佔位為 reserved 並設 expires_at,付款後轉 confirmed
create table public.course_enrollments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'cancelled')),
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  note text not null default '',
  expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
-- 同一人同一堂課只能有一筆有效報名(取消後可重報)
create unique index course_enrollments_active_uniq
  on public.course_enrollments (product_id, user_id) where status <> 'cancelled';
create index course_enrollments_product_idx on public.course_enrollments (product_id, created_at desc);
create index course_enrollments_user_idx on public.course_enrollments (user_id, created_at desc);
create index course_enrollments_order_idx on public.course_enrollments (order_id);
create index course_enrollments_expiry_idx on public.course_enrollments (expires_at)
  where status = 'reserved';

-- ========== 觀看權 ==========
-- 本專案原本沒有任何 entitlement 機制(profiles.tier_slug 是單值欄位,
-- 存不了多堂課),故新建本表。
create table public.course_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  source text not null check (source in ('purchase', 'enrollment', 'manual')),
  source_ref_id text,
  note text not null default '',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index course_access_user_product_uniq
  on public.course_access (user_id, product_id);
create index course_access_user_idx on public.course_access (user_id) where revoked_at is null;

-- ========== 名額控制 ==========
-- 一律經由以下 function 異動 seats_taken。全部先對 course_details 該列
-- 下 FOR UPDATE 列鎖,把同一堂課的報名交易序列化,不可能超賣。
-- (不用 count(*) 判斷:read committed 下兩個交易會同時數到 n-1 而雙雙通過)

create or replace function public.reserve_course_seat(
  p_product_id uuid,
  p_user_id uuid,
  p_order_id uuid,
  p_confirmed boolean,
  p_expires_at timestamptz,
  p_name text,
  p_email text,
  p_phone text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap int;
  v_taken int;
  v_existing text;
begin
  select capacity, seats_taken into v_cap, v_taken
    from public.course_details
    where product_id = p_product_id
    for update;                       -- 併發在此序列化
  if not found then
    return 'not_course';
  end if;

  select status into v_existing
    from public.course_enrollments
    where product_id = p_product_id and user_id = p_user_id and status <> 'cancelled';
  if found then
    return 'already_enrolled';
  end if;

  if v_cap is not null and v_taken >= v_cap then
    return 'full';
  end if;

  insert into public.course_enrollments
    (product_id, user_id, order_id, status, expires_at, confirmed_at,
     contact_name, contact_email, contact_phone)
  values
    (p_product_id, p_user_id, p_order_id,
     case when p_confirmed then 'confirmed' else 'reserved' end,
     case when p_confirmed then null else p_expires_at end,
     case when p_confirmed then now() else null end,
     coalesce(p_name, ''), coalesce(p_email, ''), coalesce(p_phone, ''));

  update public.course_details
    set seats_taken = seats_taken + 1, updated_at = now()
    where product_id = p_product_id;

  return 'ok';
end;
$$;

-- 付款成功後把該訂單的保留位轉為確認。
-- 若保留期已被排程回收(客人拖太久才匯款),嘗試重新搶位;搶不到回 'full',
-- 由呼叫端通知後台人工處理 —— 但絕不因此中斷收款流程。
create or replace function public.confirm_course_seats_for_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_cap int;
  v_taken int;
  v_result text := 'ok';
begin
  for r in
    select id, product_id, status
      from public.course_enrollments
      where order_id = p_order_id and status <> 'confirmed'
      order by created_at
  loop
    if r.status = 'reserved' then
      update public.course_enrollments
        set status = 'confirmed', confirmed_at = now(), expires_at = null
        where id = r.id and status = 'reserved';
    else
      -- 已被回收(cancelled),重新搶位
      select capacity, seats_taken into v_cap, v_taken
        from public.course_details where product_id = r.product_id for update;
      if v_cap is not null and v_taken >= v_cap then
        v_result := 'full';
        continue;
      end if;
      begin
        update public.course_enrollments
          set status = 'confirmed', confirmed_at = now(),
              expires_at = null, cancelled_at = null
          where id = r.id;
        update public.course_details
          set seats_taken = seats_taken + 1, updated_at = now()
          where product_id = r.product_id;
      exception when unique_violation then
        v_result := 'duplicate';
      end;
    end if;
  end loop;
  return v_result;
end;
$$;

-- 取消訂單時退位
create or replace function public.release_course_seats_for_order(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, product_id from public.course_enrollments
      where order_id = p_order_id and status <> 'cancelled'
  loop
    perform 1 from public.course_details where product_id = r.product_id for update;
    update public.course_enrollments
      set status = 'cancelled', cancelled_at = now() where id = r.id;
    update public.course_details
      set seats_taken = greatest(seats_taken - 1, 0), updated_at = now()
      where product_id = r.product_id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 排程回收逾期未付款的保留位(由 api/src/jobs.ts 每小時呼叫)
create or replace function public.expire_course_reservations()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, product_id from public.course_enrollments
      where status = 'reserved' and expires_at is not null and expires_at < now()
  loop
    perform 1 from public.course_details where product_id = r.product_id for update;
    update public.course_enrollments
      set status = 'cancelled', cancelled_at = now()
      where id = r.id and status = 'reserved';
    if found then
      update public.course_details
        set seats_taken = greatest(seats_taken - 1, 0), updated_at = now()
        where product_id = r.product_id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ⚠️ 安全關鍵:security definer 函式預設 PUBLIC 可 EXECUTE,
-- anon 拿 anon key 直接打 PostgREST /rest/v1/rpc/ 就能代任意 user_id 報名。
-- 必須收回權限,只留 service_role(即 createAdminClient() 走的身分)。
revoke execute on function public.reserve_course_seat(uuid, uuid, uuid, boolean, timestamptz, text, text, text) from public;
revoke execute on function public.confirm_course_seats_for_order(uuid) from public;
revoke execute on function public.release_course_seats_for_order(uuid) from public;
revoke execute on function public.expire_course_reservations() from public;

grant execute on function public.reserve_course_seat(uuid, uuid, uuid, boolean, timestamptz, text, text, text) to service_role;
grant execute on function public.confirm_course_seats_for_order(uuid) to service_role;
grant execute on function public.release_course_seats_for_order(uuid) to service_role;
grant execute on function public.expire_course_reservations() to service_role;

-- ========== RLS ==========
alter table public.course_details enable row level security;
alter table public.course_lessons enable row level security;
alter table public.course_enrollments enable row level security;
alter table public.course_access enable row level security;

create policy "course_details_public_read" on public.course_details
  for select using (
    exists (select 1 from public.products p where p.id = product_id and p.status = 'active')
    or public.is_admin()
  );
create policy "course_details_admin_write" on public.course_details
  for all using (public.is_admin());

-- 刻意不開放任何公開讀:影片 id 只能由伺服器(service role)在驗證購買後吐出
create policy "course_lessons_admin_all" on public.course_lessons
  for all using (public.is_admin());

create policy "course_enrollments_select_own" on public.course_enrollments
  for select using (auth.uid() = user_id or public.is_admin());
create policy "course_enrollments_admin_write" on public.course_enrollments
  for all using (public.is_admin());

-- 仿 points_ledger:只給 select own,寫入一律由 service role 經 function 執行
create policy "course_access_select_own" on public.course_access
  for select using (auth.uid() = user_id or public.is_admin());

-- ========== trigger ==========
create trigger touch_course_details before update on public.course_details
  for each row execute function public.touch_updated_at();
create trigger touch_course_lessons before update on public.course_lessons
  for each row execute function public.touch_updated_at();
