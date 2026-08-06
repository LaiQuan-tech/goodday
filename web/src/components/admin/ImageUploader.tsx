"use client";

import { useRef, useState } from "react";
import { uploadImage } from "@/lib/upload-image";

export type ImageItem = { url: string; alt?: string };

const DEFAULT_MAX = 8;
// 只用來標示「這張是舊的外部圖床網址」。真正的白名單把關在 server action 的
// parseImagesField(),那裡才有 NEXT_PUBLIC_SUPABASE_URL 可比對完整前綴。
const STORAGE_MARKER = "/storage/v1/object/public/product-images/";

export default function ImageUploader({
  name = "images",
  initial,
  max = DEFAULT_MAX,
  hint,
}: {
  name?: string;
  initial: ImageItem[];
  max?: number;
  hint?: string;
}) {
  const [items, setItems] = useState<ImageItem[]>(() =>
    (initial ?? [])
      .filter((i) => i && typeof i.url === "string" && i.url)
      .map((i) => ({ url: i.url, alt: i.alt }))
  );
  // null = 沒在上傳;否則是「已完成幾張 / 共幾張」
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const full = items.length >= max;
  const busy = progress !== null;

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // 清空 input,不然連續選同一個檔案不會觸發 change
    event.target.value = "";
    if (picked.length === 0) return;

    setError("");
    const room = Math.max(0, max - items.length);
    const queue = picked.slice(0, room);
    const overflow = picked.length - queue.length;
    if (queue.length === 0) {
      setError(`最多只能放 ${max} 張圖片,請先刪除不要的再上傳。`);
      return;
    }

    const failures: string[] = [];
    // ⚠️ 逐張序列上傳,不用 Promise.all:一次併發送 4 個 8MB 的檔會同時佔滿上行頻寬,
    // 每一張都變慢、而且更容易整批 timeout。序列還能誠實回報「第幾張 / 共幾張」。
    for (let i = 0; i < queue.length; i++) {
      setProgress({ done: i, total: queue.length });
      try {
        const uploaded = await uploadImage(queue[i]);
        setItems((prev) => (prev.length >= max ? prev : [...prev, { url: uploaded.url }]));
      } catch (err) {
        failures.push(
          `${queue[i].name}(${err instanceof Error ? err.message : "上傳失敗"})`
        );
      }
    }
    setProgress(null);

    const messages: string[] = [];
    if (overflow > 0) messages.push(`超過 ${max} 張上限,已略過 ${overflow} 張`);
    if (failures.length > 0) messages.push(`以下圖片上傳失敗:${failures.join("、")}`);
    setError(messages.join(";"));
  }

  function remove(index: number) {
    // 只從清單移除,不去刪 storage 裡的檔案。刪檔要另一支 API,而且必須處理
    // 「刪了檔卻沒按儲存」與「同一張圖被別的商品共用」兩種情況——誤刪線上圖的代價
    // 遠高於留下幾個孤兒檔(bucket 只放商品圖,量級很小)。
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    setItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setAlt(index: number, alt: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, alt } : item)));
  }

  return (
    <div>
      <label className="iv-label">商品圖片(第一張為主視覺)</label>

      {/*
        ⚠️ 非受控表單的橋接點。
        ProductForm / CourseForm 是 "use client" 但全部欄位都用 defaultValue,沒有任何 state;
        送出時靠 <form action={…}> 讓瀏覽器自己把 DOM 內的欄位序列化成 FormData。
        上傳結果只活在本元件的 useState 裡,所以用這個 hidden input 把它寫回 DOM ——
        送出時 FormData 自然帶上,父表單完全不需要改成受控、也不用把 state 提上去。
        (本專案其他 hidden input 都只用來帶 id,這是第一個帶結構化資料的,故特別註明。)
        server 端由 app/admin/actions.ts 的 parseImagesField() 解析 + 驗證。
      */}
      <input type="hidden" name={name} readOnly value={JSON.stringify(items)} />

      {items.length > 0 && (
        <ul className="mt-2 grid gap-3 sm:grid-cols-2">
          {items.map((item, index) => {
            const legacy = !item.url.includes(STORAGE_MARKER);
            return (
              <li
                key={`${item.url}-${index}`}
                className="flex gap-3 border border-[var(--color-line)] p-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- 後台縮圖不需要 next/image 最佳化,
                    而且舊的外部網址不在 remotePatterns 內,用 <Image> 會直接丟錯 */}
                <img
                  src={item.url}
                  alt=""
                  className="h-20 w-20 shrink-0 bg-[var(--color-line)] object-cover"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {index === 0 && (
                      <span className="iv-chip bg-[var(--color-line)]">主視覺</span>
                    )}
                    {legacy && (
                      <span className="iv-chip bg-danger-soft text-danger">
                        舊外部圖(儲存後會被移除)
                      </span>
                    )}
                  </div>
                  <input
                    className="iv-input min-h-9 py-1 text-sm"
                    placeholder="圖片說明(選填,供無障礙與 SEO 使用)"
                    value={item.alt ?? ""}
                    onChange={(e) => setAlt(index, e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {/* 排序用按鈕而不是 HTML5 drag:後台在手機上也會用,
                        drag 事件在觸控裝置不會觸發;按鈕還能掛 aria-label 給讀屏軟體。 */}
                    <button
                      type="button"
                      className="iv-btn-ghost min-h-8 px-3 py-1 text-xs"
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || busy}
                      aria-label={`把第 ${index + 1} 張圖片往前移`}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="iv-btn-ghost min-h-8 px-3 py-1 text-xs"
                      onClick={() => move(index, 1)}
                      disabled={index === items.length - 1 || busy}
                      aria-label={`把第 ${index + 1} 張圖片往後移`}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="iv-btn-danger min-h-8 px-3 py-1 text-xs"
                      onClick={() => remove(index)}
                      disabled={busy}
                      aria-label={`刪除第 ${index + 1} 張圖片`}
                    >
                      刪除
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFiles}
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="iv-btn-ghost"
          onClick={() => inputRef.current?.click()}
          disabled={busy || full}
        >
          {progress ? `上傳中 ${progress.done + 1}/${progress.total}…` : "選擇圖片上傳"}
        </button>
        <span className="text-xs text-ink-soft">
          {full
            ? `已達上限 ${max} 張,請先刪除再上傳。`
            : `已放 ${items.length}/${max} 張。JPEG／PNG／WebP,單張上限 8MB。`}
        </span>
      </div>

      <p className="mt-1 text-xs text-ink-soft">
        {hint ?? "圖片會上傳到本站的 Supabase Storage,自動轉為 WebP 並縮到長邊 2000px。"}
      </p>

      {error && (
        <p className="mt-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>
      )}
    </div>
  );
}
