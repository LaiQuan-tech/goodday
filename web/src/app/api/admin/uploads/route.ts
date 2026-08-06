import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { isAdminRequest } from "@/lib/admin-auth";
import { tryCreateAdminClient } from "@/lib/supabase/admin";

// sharp 是原生模組,只能跑在 node runtime(不是 edge)
export const runtime = "nodejs";
export const maxDuration = 30;

// 與 api/chat/mockup/route.ts 同一組限制;bucket 的 allowed_mime_types/file_size_limit
// (migration 20260806000002)也是同一組值,兩邊要一起改。
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const BUCKET = "product-images";
// 商品圖最大顯示尺寸遠小於此;2000px 已足夠 retina 全幅,再大只是白佔流量。
const MAX_EDGE = 2000;

function friendly(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

type Processed = { buffer: Buffer; width: number; height: number };

// ⚠️ File.type 是瀏覽器依副檔名猜的,可以被任意偽造(改副檔名即可)。
// 真正的把關是「sharp 解析得出中繼資料」——解不出來就不是圖片,直接擋掉。
// 一併做 EXIF 方向校正:手機直拍的照片沒 rotate() 會在網頁上躺平。
async function processImage(input: Buffer): Promise<Processed | null> {
  try {
    const pipeline = sharp(input).rotate();
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height) return null;

    const { data, info } = await pipeline
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  // bucket 的 storage.objects 沒有任何寫入 policy,寫入只能靠 service role;
  // 所以這一行就是整支上傳流程唯一的授權關卡,不能省。
  if (!(await isAdminRequest())) return friendly("權限不足", 403);

  let form: FormData;
  try {
    // 原生 multipart:base64 JSON 會讓傳輸量膨脹 33%,大檔更容易撞到平台的 body 上限
    form = await req.formData();
  } catch {
    return friendly("上傳內容無法解析");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return friendly("缺少檔案");
  if (!ALLOWED_MIME.has(file.type)) return friendly("圖片格式需為 JPEG/PNG/WebP");
  if (file.size === 0) return friendly("圖片內容無法解析");
  if (file.size > MAX_BYTES) return friendly("圖片檔案太大,請重新上傳(上限 8MB)");

  const processed = await processImage(Buffer.from(await file.arrayBuffer()));
  if (!processed) return friendly("圖片內容無法解析,請確認是有效的 JPEG/PNG/WebP 圖片");

  const db = tryCreateAdminClient();
  if (!db) return friendly("系統尚未完成設定,請稍後再試", 503);

  // 一律用 uuid 當檔名,不沿用原始檔名:避開路徑穿越(../)、中文/空白檔名在 URL 的轉義問題,
  // 以及兩位管理員傳同名檔互相覆蓋。原始檔名對前台沒有任何用處。
  const path = `products/${randomUUID()}.webp`;
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, processed.buffer, { contentType: "image/webp", upsert: false });
  if (error) {
    console.error("[admin/uploads] upload failed:", error);
    return friendly("圖片上傳失敗,請稍後再試一次", 502);
  }

  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
  return NextResponse.json({
    ok: true,
    url: pub.publicUrl,
    path,
    width: processed.width,
    height: processed.height,
  });
}
