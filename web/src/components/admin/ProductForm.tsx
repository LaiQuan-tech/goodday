"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { archiveProduct, upsertProduct } from "@/app/admin/actions";
import ImageUploader from "@/components/admin/ImageUploader";
import type { Product } from "@/lib/types";

export default function ProductForm({ product }: { product: Product | null }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(formData: FormData) {
    setSaving(true);
    setError("");
    try {
      await upsertProduct(formData);
      router.push("/admin/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
      setSaving(false);
    }
  }

  return (
    <form action={handleSubmit} className="iv-card space-y-4">
      {product && <input type="hidden" name="id" value={product.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="iv-label">商品名稱 *</label>
          <input name="name" required className="iv-input" defaultValue={product?.name ?? ""} />
        </div>
        <div>
          <label className="iv-label">網址代稱(slug)*</label>
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            title="小寫英數與連字號"
            className="iv-input"
            defaultValue={product?.slug ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">分類</label>
          <input name="category" className="iv-input" defaultValue={product?.category ?? ""} />
        </div>
        <div>
          <label className="iv-label">售價(TWD)*</label>
          <input
            name="price"
            required
            type="number"
            min={0}
            className="iv-input"
            defaultValue={product?.price ?? 0}
          />
        </div>
        <div>
          <label className="iv-label">原價(劃線價,選填)</label>
          <input
            name="compare_at_price"
            type="number"
            min={0}
            className="iv-input"
            defaultValue={product?.compare_at_price ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">庫存 *</label>
          <input
            name="stock"
            required
            type="number"
            min={0}
            className="iv-input"
            defaultValue={product?.stock ?? 0}
          />
        </div>
        <div>
          <label className="iv-label">狀態</label>
          <select name="status" className="iv-input" defaultValue={product?.status ?? "draft"}>
            <option value="draft">草稿</option>
            <option value="active">上架</option>
            <option value="archived">下架</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">商品說明</label>
          <textarea
            name="description"
            rows={5}
            className="iv-input min-h-32"
            defaultValue={product?.description ?? ""}
          />
        </div>
        <div>
          <label className="iv-label">英文名稱(選填,AI 已翻譯可覆核修改)</label>
          <input
            name="name_en"
            className="iv-input"
            defaultValue={product?.name_en ?? ""}
            placeholder="留空則英文站顯示中文名稱"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="iv-label">英文描述(選填,AI 已翻譯可覆核修改)</label>
          <textarea
            name="description_en"
            rows={5}
            className="iv-input min-h-32"
            defaultValue={product?.description_en ?? ""}
            placeholder="留空則英文站顯示中文描述"
          />
        </div>
        <div className="sm:col-span-2">
          <ImageUploader initial={product?.images ?? []} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="featured"
            defaultChecked={product?.featured ?? false}
            className="h-4 w-4 accent-[#2742f5]"
          />
          設為精選(顯示於首頁)
        </label>
      </div>

      {error && (
        <p className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={saving} className="iv-btn-primary">
          {saving ? "儲存中…" : "儲存"}
        </button>
        {product && product.status !== "archived" && (
          <button
            type="button"
            className="iv-btn-danger"
            onClick={async () => {
              if (!confirm("確定要下架此商品嗎?")) return;
              await archiveProduct(product.id);
              router.push("/admin/products");
            }}
          >
            下架商品
          </button>
        )}
      </div>
    </form>
  );
}
