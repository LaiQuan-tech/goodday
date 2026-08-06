-- 課程「完整活動頁」所需欄位
--
-- 設計判斷:固定欄位,不做彈性區塊表(course_sections)。
--   版型是需求寫死的 7 個區塊,不是任意組合。彈性區塊表要配一整套後台 CRUD
--   (新增/刪除/排序/型別切換/每型別不同欄位),而本專案的表單慣例是
--   「非受控 + Server Action」,承載動態列表得另做子頁面,與「現在就能用」衝突。
--   固定欄位只是 CourseForm 多幾個 textarea。代價:未來加區塊要再開 migration。
--
-- _en 欄位一次加齊:事後補要再開 migration + 改 types + 改表單 + 改渲染,
-- 同一件事做兩次。後台把英文欄位收進 <details> 摺疊區,不會讓表單看起來爆炸。
-- 一律 not null default '' —— localizeText() 對空白字串會 fallback 中文,
-- 行為與 products.name_en 的 nullable 相同但處理更簡單。
--
-- ⚠️ _migrations 表與實際 schema 不同步(有人直接在 Dashboard 跑過 SQL),
--    本檔手動單獨執行、不可跑 provision.mjs。故一律 if not exists,重跑安全。

alter table public.course_details
  add column if not exists subtitle             text not null default '',
  add column if not exists subtitle_en          text not null default '',
  add column if not exists pain_points          text not null default '',
  add column if not exists pain_points_en       text not null default '',
  add column if not exists benefits             text not null default '',
  add column if not exists benefits_en          text not null default '',
  add column if not exists outline_en           text not null default '',
  add column if not exists location_en          text not null default '',
  add column if not exists instructor_title     text not null default '',
  add column if not exists instructor_title_en  text not null default '',
  add column if not exists instructor_bio       text not null default '',
  add column if not exists instructor_bio_en    text not null default '',
  add column if not exists instructor_photo_url text not null default '',
  add column if not exists fee_note             text not null default '',
  add column if not exists fee_note_en          text not null default '',
  add column if not exists faq                  jsonb not null default '[]'::jsonb;

-- faq 形狀 [{q, a, q_en, a_en}]。
-- 只擋「必須是陣列」:逐項驗 CHECK 會讓後台任何小格式錯誤變成 500,
-- 而寫入端(server action)已經先清洗過一次。
alter table public.course_details drop constraint if exists course_details_faq_is_array;
alter table public.course_details add constraint course_details_faq_is_array
  check (jsonb_typeof(faq) = 'array');

-- RLS 不用動:course_details_public_read / course_details_admin_write
-- (20260723000001_courses.sql)是整列層級,新欄位自動繼承。
