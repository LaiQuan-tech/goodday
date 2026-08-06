// 後台圖片上傳的 client helper(只給 components/admin/ImageUploader.tsx 用)。
//
// ⚠️ 與 lib/image.ts 分開兩支是刻意的:image.ts 是 ChatWidget / RoomMockupFlyout 在用的
// 「縮到 1536 + 轉 base64 給 AI 模型吃」,那條路徑對畫質要求低、要的是 base64;
// 這裡要的是「盡量保留原檔畫質、走 multipart」。共用一支會讓其中一邊被迫遷就另一邊。

export type UploadedImage = { url: string; path: string; width: number; height: number };

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB,與 /api/admin/uploads 一致

// Vercel serverless function 的 request body 上限是 4.5MB,而且是在進到 route handler
// 之前就被平台擋掉(前端只會拿到 413,看不到我們自己的中文錯誤訊息)。
// 所以「超過 4MB」才先在 client 預縮;4MB 以下維持原檔上傳,不多做一次 canvas 轉檔劣化畫質
// (真正的壓縮由 server 端 sharp 做,品質比 canvas 好)。
const PRESHRINK_THRESHOLD = 4 * 1024 * 1024;
const PRESHRINK_MAX_EDGE = 2560;

async function preshrink(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("圖片載入失敗"));
      el.src = objectUrl;
    });
    const scale = Math.min(1, PRESHRINK_MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("此瀏覽器不支援圖片處理");
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9)
    );
    if (!blob) throw new Error("圖片轉換失敗");
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!ALLOWED_MIME.has(file.type)) throw new Error("圖片格式需為 JPEG/PNG/WebP");
  if (file.size === 0) throw new Error("檔案是空的");
  if (file.size > MAX_BYTES) throw new Error("圖片檔案太大,請重新上傳(上限 8MB)");

  const payload: Blob = file.size > PRESHRINK_THRESHOLD ? await preshrink(file) : file;

  const body = new FormData();
  // 第三個參數(檔名)讓 server 端的 formData().get("file") 拿到 File 而不是 Blob。
  // 檔名本身不會被採用——server 一律改用 uuid。
  body.append("file", payload, file.name || "upload");

  const res = await fetch("/api/admin/uploads", { method: "POST", body });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "上傳失敗,請稍後再試");
  }
  return {
    url: String(data.url),
    path: String(data.path),
    width: Number(data.width) || 0,
    height: Number(data.height) || 0,
  };
}
