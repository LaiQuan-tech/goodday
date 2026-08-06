// 商品無真實圖檔時的 CSS 漸層佔位圖(依 dc.html .ph 做法延伸):
// 每件作品有自己的漸層色組(products.metadata.gradient),沒有則以 id 決定一組穩定的備援漸層。
const FALLBACK_GRADIENTS: [string, string][] = [
  ["#ece1cd", "#bfa06a"],
  ["#e2d7c4", "#7a6b52"],
  ["#d8c9a8", "#8a7259"],
  ["#f4ede0", "#9a7d47"],
  ["#2e2519", "#a2854a"],
  ["#e3c98f", "#5a4d3b"],
  ["#ece1cd", "#a2854a"],
  ["#e2d7c4", "#bfa06a"],
  ["#2a2016", "#e3c98f"],
];

export function gradientForId(id: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length];
}

import Image from "next/image";

// next.config.ts 的 images.remotePatterns 只允許 *.supabase.co。DB 裡若殘留舊的外部圖床網址,
// next/image 不會優雅降級而是直接丟錯,整個區塊變成錯誤佔位。
// 這裡先做一次純字串判斷(server component,零 client 成本、不必改成 "use client"):
// 只有站內相對路徑(/scenes/…、/rooms/…)與 Supabase Storage 的網址(public 或 signed)
// 才交給 <Image>,其餘一律視為「沒有圖」,顯示乾淨的漸層佔位。
function isRenderableSrc(src: string | null | undefined): src is string {
  if (!src) return false;
  if (src.startsWith("/")) return true; // public/ 底下的靜態圖
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".supabase.co") &&
      url.pathname.startsWith("/storage/")
    );
  } catch {
    return false; // 不是合法絕對網址
  }
}

export default function Placeholder({
  gradient,
  label,
  src,
  alt,
  sizes = "(max-width: 768px) 100vw, 33vw",
  priority = false,
  className = "",
  style,
}: {
  gradient?: [string, string] | null;
  label?: string;
  src?: string | null;
  alt?: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const backgroundImage = gradient
    ? `repeating-linear-gradient(135deg, rgba(120,95,70,0.09) 0 1px, transparent 1px 12px), linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`
    : undefined;

  const imageSrc = isRenderableSrc(src) ? src : null;

  return (
    <div
      className={`lm-ph ${className}`}
      // 有真圖時不顯示開發用的佔位標籤
      data-label={imageSrc ? undefined : label}
      style={{ backgroundImage, ...style }}
    >
      {imageSrc && (
        <Image
          src={imageSrc}
          alt={alt ?? label ?? ""}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
        />
      )}
    </div>
  );
}
