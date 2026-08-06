import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import CourseForm from "@/components/admin/CourseForm";
import type { CourseDetail, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminCourseEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let product: Product | null = null;
  let detail: CourseDetail | null = null;
  if (id !== "new") {
    const db = createAdminClient();
    const { data } = await db
      .from("products")
      .select("*")
      .eq("id", id)
      .eq("product_type", "course")
      .maybeSingle();
    if (!data) notFound();
    product = data as Product;

    const { data: detailData } = await db
      .from("course_details")
      .select("*")
      .eq("product_id", id)
      .maybeSingle();
    detail = (detailData as CourseDetail | null) ?? null;
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold break-words">
          {product ? `編輯:${product.name}` : "新增課程"}
        </h2>
        {product && (
          <Link href={`/admin/courses/${product.id}/enrollments`} className="iv-btn-ghost">
            報名名單
            {detail ? `(${detail.seats_taken})` : ""}
          </Link>
        )}
      </div>
      <CourseForm product={product} detail={detail} />
    </div>
  );
}
