#!/usr/bin/env node
/**
 * 商品／課程圖片搬家腳本(一次性)
 *
 * 背景:後台圖片欄位以前是「貼網址」的 textarea,DB 裡因此存了一批外部圖床的 hotlink。
 * 那些網址在前台一律渲染不出來——next.config.ts 的 images.remotePatterns 只允許
 * *.supabase.co,next/image 會直接拒絕,畫面變成灰底佔位圖。
 * 後台改成只能上傳到自家 product-images bucket 之後,這支腳本負責把既有的外部圖搬進來,
 * 並把 products.images 的網址改寫成 bucket 的 public URL。
 *
 * 判斷「需要搬」的條件:圖片網址既不是站內相對路徑(/scenes/… 這種 public/ 靜態檔),
 * 也不在本專案的 Supabase host 上。已經在自家 storage 的網址一律原封不動。
 *
 * 冪等:重跑只會處理仍指向外部的網址;搬過的下次就會被判定為已在自家 host 而跳過。
 * 安全:單筆圖片失敗(來源 404、防盜連、不是圖片…)只印警告並保留原網址,不中斷整支腳本;
 *       也永遠不刪任何既有資料——最壞情況是某張圖沒搬成功,維持原狀。
 *
 * 用法(在 repo 根目錄,金鑰讀 web/.env.local):
 *   node scripts/migrate-images.mjs --dry-run     # 只印計畫,不下載、不上傳、不寫 DB
 *   node scripts/migrate-images.mjs               # 實際執行
 *   node scripts/migrate-images.mjs --limit=1     # 先搬 1 筆商品確認結果再全跑
 *
 * 前提:supabase/migrations/20260806000002_product_images_bucket.sql 已套用到目標 DB。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(ROOT, "web");

// ---------- 讀 web/.env.local(不覆蓋已存在的環境變數,方便 CI 用真正的 env 覆寫)----------
async function loadEnvFile(path) {
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue; // 已有(如 CI 注入)就不覆蓋
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env.local 不存在就略過,靠外部環境變數
  }
}

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
const fail = (msg) => console.log(`\x1b[31m✗\x1b[0m ${msg}`);

// ---------- CLI 參數 ----------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

// ---------- 與 /api/admin/uploads 對齊的限制 ----------
const BUCKET = "product-images";
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2000;
const WEBP_QUALITY = 82;
const FETCH_TIMEOUT_MS = 15_000;

function normalizeMime(header) {
  if (!header) return null;
  const type = header.split(";")[0].trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg"; // 有些圖床這樣回,實際上就是 jpeg
  return type;
}

// 下載 + 驗證 + 轉 webp。任何一步不過就 throw,由呼叫端印警告後跳過這一張。
async function fetchAndConvert(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // 有些圖床會依 UA 擋掉沒有瀏覽器特徵的請求
    headers: { "User-Agent": "Mozilla/5.0 (compatible; GoodDaysImageMigrator/1.0)" },
  });
  if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`);

  const mime = normalizeMime(res.headers.get("content-type"));
  // content-type 有給就照它擋;沒給(部分 CDN 會漏)就先放行,交給下面 sharp 判斷是不是圖片。
  if (mime && !ALLOWED_MIME.has(mime)) throw new Error(`格式不支援(${mime})`);

  const declaredSize = parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BYTES) {
    throw new Error(`檔案太大(${(declaredSize / 1024 / 1024).toFixed(1)}MB)`);
  }

  const input = Buffer.from(await res.arrayBuffer());
  if (input.length === 0) throw new Error("下載到空檔案");
  if (input.length > MAX_BYTES) {
    throw new Error(`檔案太大(${(input.length / 1024 / 1024).toFixed(1)}MB)`);
  }

  // sharp 解得出中繼資料才算真的是圖片(content-type 可以隨便亂寫)
  const pipeline = sharp(input).rotate(); // 順手做 EXIF 方向校正
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("不是可解析的圖片");

  const { data, info } = await pipeline
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, sourceBytes: input.length };
}

async function main() {
  await loadEnvFile(join(WEB_ROOT, ".env.local"));

  const missing = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    fail(`缺少必要環境變數:${missing.join(", ")}(請確認 web/.env.local 或外部 env 已設定)`);
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
  let projectHost;
  try {
    projectHost = new URL(supabaseUrl).host;
  } catch {
    fail(`NEXT_PUBLIC_SUPABASE_URL 不是合法網址:${supabaseUrl}`);
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("\n=== 商品圖片搬家(外部 hotlink → product-images bucket)===");
  console.log(DRY_RUN ? "模式:--dry-run(只印計畫,不動任何東西)" : "模式:實際執行");
  if (LIMIT !== Infinity) console.log(`限制:最多處理 ${LIMIT} 筆商品`);
  console.log(`目標 bucket:${BUCKET}(host ${projectHost})\n`);

  log("讀取 products…");
  const { data: products, error } = await supabase
    .from("products")
    .select("id, slug, name, images")
    .order("created_at", { ascending: true });
  if (error) {
    fail(`讀取 products 失敗:${error.message}`);
    process.exitCode = 1;
    return;
  }

  // 站內相對路徑與已在自家 host 的網址都不用搬
  const needsMigration = (url) => {
    if (typeof url !== "string" || !url.trim()) return false;
    if (url.startsWith("/")) return false;
    try {
      return new URL(url).host !== projectHost;
    } catch {
      return false; // 解不出來的字串不去動它,留給人工處理
    }
  };

  const targets = (products ?? []).filter((p) =>
    Array.isArray(p.images) && p.images.some((img) => needsMigration(img?.url))
  );
  ok(`共 ${products?.length ?? 0} 筆商品,其中 ${targets.length} 筆含外部圖片網址`);

  const todo = targets.slice(0, LIMIT);
  if (todo.length === 0) {
    ok("沒有需要搬的圖片,結束。");
    return;
  }
  console.log("");

  const mapping = []; // 對照表:[商品, 原網址, 新網址 or 失敗原因]
  let moved = 0;
  let failed = 0;
  let rowsUpdated = 0;

  for (const product of todo) {
    const label = `${product.slug || product.id}`;
    let changed = false;
    const nextImages = [];

    for (const image of product.images) {
      const url = image?.url;
      if (!needsMigration(url)) {
        nextImages.push(image);
        continue;
      }

      if (DRY_RUN) {
        mapping.push([label, url, "(dry-run,尚未搬移)"]);
        nextImages.push(image);
        continue;
      }

      try {
        const converted = await fetchAndConvert(url);
        // 一律用 uuid 檔名(與 /api/admin/uploads 相同);原始檔名對前台沒有用處,
        // 而且外部網址的檔名常含中文/查詢字串,拿來當 storage path 只會製造麻煩。
        const path = `products/${crypto.randomUUID()}.webp`;
        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .upload(path, converted.buffer, { contentType: "image/webp", upsert: false });
        if (uploadError) throw new Error(`上傳失敗:${uploadError.message}`);

        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
        nextImages.push({ ...image, url: pub.publicUrl });
        changed = true;
        moved++;
        mapping.push([label, url, pub.publicUrl]);
        ok(
          `${label}:已搬移 → ${path}(${converted.width}×${converted.height},` +
            `${(converted.sourceBytes / 1024).toFixed(0)}KB → ${(converted.buffer.length / 1024).toFixed(0)}KB)`
        );
      } catch (err) {
        // 單筆失敗不中斷:保留原網址,讓人工決定要重新上傳還是放棄這張圖
        failed++;
        mapping.push([label, url, `失敗:${err.message}`]);
        warn(`${label}:跳過一張圖 — ${err.message}\n    來源:${url}`);
        nextImages.push(image);
      }
    }

    if (changed && !DRY_RUN) {
      const { error: updateError } = await supabase
        .from("products")
        .update({ images: nextImages })
        .eq("id", product.id);
      if (updateError) {
        fail(`${label}:圖片已上傳但回寫 products.images 失敗 — ${updateError.message}`);
        fail("    → 該商品的新圖已在 bucket 內但 DB 還指向舊網址,重跑本腳本會再搬一次(留下孤兒檔)。");
        process.exitCode = 1;
      } else {
        rowsUpdated++;
      }
    }
  }

  // ---------- 對照表 ----------
  console.log("\n=== 對照表 ===");
  for (const [label, from, to] of mapping) {
    console.log(`${label}\n  舊:${from}\n  新:${to}`);
  }

  console.log("\n=== 統計 ===");
  console.log(`處理商品:${todo.length} 筆`);
  console.log(`搬移成功:${moved} 張`);
  console.log(`失敗跳過:${failed} 張`);
  console.log(`回寫 DB :${rowsUpdated} 筆`);
  if (DRY_RUN) {
    console.log("\n(dry-run:以上都沒有實際執行。確認清單無誤後拿掉 --dry-run 再跑一次。)");
  } else if (failed > 0) {
    console.log(
      "\n失敗的圖片維持原網址不動;前台會顯示漸層佔位圖,請到後台手動重新上傳那幾張。"
    );
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
