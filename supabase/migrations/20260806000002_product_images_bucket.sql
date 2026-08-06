-- 商品／課程圖片的 public bucket
--
-- 為什麼 public 而不是像 chat-uploads 那樣 private:
--   前台圖要長期顯示且經 next/image 最佳化。private 只能給簽名網址,而簽名網址
--   (a) 到期後 next/image 快取內的來源失效變破圖
--   (b) 每次 render 的 query string 都不同 → 快取鍵每次都變 → 每個請求重新最佳化
--   (c) 這是公開行銷素材,沒有 chat-uploads(客戶家中照片)的隱私考量
-- public URL 的 host 是 <ref>.supabase.co,已在 next.config.ts 的 remotePatterns 內。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 8388608,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ⚠️ 刻意不建立任何 storage.objects 的 policy,維持本專案既有的安全模型:
--
--   讀:public bucket 的 /storage/v1/object/public/... 端點不經 RLS,不需要 select policy。
--   寫:沒有 insert/update/delete policy → anon/authenticated 一律不能寫。
--       上傳只能經 /api/admin/uploads(server 端驗 admin 身分 + service role 寫入)。
--
-- ⚠️⚠️ 不要「順手補齊 RLS」加上 select policy —— 一旦加了,匿名就能用
--       storage.list() 列出整個 bucket 的檔名。這是刻意的留白,不是遺漏。
