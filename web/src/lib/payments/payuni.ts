import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

// PayUni 統一金流 API client(正式串接;PAYUNI_HASH_KEY/IV 為商店真實金鑰,呼叫
// buildUppForm / queryPayuniTrade 都是真實金流動作,測試時請勿誤觸)。
//
// ── 加解密規格出處 ────────────────────────────────────────────────────────────
// 依 PayUni 官方文件與官方 Node.js 範例逐字實作,並以官方測試向量驗證通過
// (見 scripts/payuni-selftest.mjs,那支腳本直接 import 本檔的函式,不另外複製一份邏輯):
//   * 演算法 aes-256-gcm
//   * key = HashKey 原字串(僅 trim,不做任何 hash),固定 32 bytes
//   * iv  = HashIV  原字串(僅 trim,不做任何 hash),固定 16 bytes
//     ⚠️ 注意 iv 是 16 bytes,不是 GCM 慣例的 12 bytes —— PayUni 就是 16。
//   * 明文 = 參數的 application/x-www-form-urlencoded query string(中文會 UTF-8 percent-encode)
//   * EncryptInfo = hex( base64(密文) + ":::" + base64(GCM authTag) )   ← 三個冒號
//   * HashInfo    = SHA256(HashKey + EncryptInfo + HashIV) 的 hex,轉大寫
//
// ── 本檔刻意不 import 任何專案內模組 ──────────────────────────────────────────
// 只依賴 node:crypto。這樣 scripts/payuni-selftest.mjs 才能不經 bundler / tsconfig
// paths 直接 import 本檔(Node 原生 TypeScript 型別剝離),用官方測試向量驗證
// 「產線上真正跑的那份加解密程式碼」,而不是驗證一份複製品。
// siteUrl() 因此在本檔有一份 1 行的本地實作(與 lib/resend.ts 的 siteUrl() 同義)。
//
// ── 尚待沙盒實測確認的項目(交付時已知的不確定處)──────────────────────────
//   1. NotifyURL 的 ack 格式:官方文件查不到「要回什麼給 PayUni 才算收到」。
//      目前回 HTTP 200 純文字 "OK"(見 app/api/webhooks/payuni/route.ts)。
//   2. /api/trade/query 的外層 Version 值:文件只明確寫 UPP 是 "2.0",查詢 API 的
//      版本號未載明,此處用 "1.0"(見 TRADE_QUERY_VERSION)。
//   3. /api/trade/query 回應解密後的內容格式(JSON 或 query string),此處兩種都吃。

/** UPP 整合式支付頁的固定版本號(官方文件明載)。 */
export const UPP_VERSION = "2.0";

/**
 * 交易查詢 API 的版本號。
 * TODO(沙盒實測):官方文件只明確寫 UPP 是 "2.0",查詢 API 的 Version 未載明。
 * 若沙盒查詢回 Status 非 SUCCESS 且 Message 提到版本,請優先調整這個常數。
 */
export const TRADE_QUERY_VERSION = "1.0";

/** 與 lib/resend.ts 的 siteUrl() 同義;本檔不 import 專案模組的原因見檔頭。 */
function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

/**
 * 環境判斷刻意「fail-safe 到沙盒」:只有 PAYUNI_SANDBOX 明確等於字串 "false"
 * 才會打正式環境,未設定 / 空字串 / 任何其他值一律走沙盒。
 *
 * ⚠️ 這與本站舊金流商的設定方向相反(舊的是 SANDBOX==="true" 才走沙盒,未設定
 * 走正式)。理由:兩種設錯的後果不對等 ——
 *   * 該正式卻走沙盒 → 客人刷不到真的錢,訂單卡 pending,可回頭補救。
 *   * 該沙盒卻走正式 → 測試時真的從客人的卡扣款,無法「補救」只能退刷。
 * 所以預設值選擇比較安全的那一邊:沒設就是沙盒。
 */
function isSandbox(): boolean {
  return process.env.PAYUNI_SANDBOX !== "false";
}

function apiBase(): string {
  return isSandbox() ? "https://sandbox-api.payuni.com.tw" : "https://api.payuni.com.tw";
}

/** 商店代號。未設定時回空字串,由呼叫端(isCardPaymentAvailable)先擋掉。 */
export function payuniMerId(): string {
  return (process.env.PAYUNI_MER_ID ?? "").trim();
}

/** PayUni 是否已完成設定(三把金鑰齊全)。 */
export function payuniConfigured(): boolean {
  return Boolean(payuniMerId() && process.env.PAYUNI_HASH_KEY && process.env.PAYUNI_HASH_IV);
}

// ────────────────────────────── 加解密核心 ──────────────────────────────

export type PayuniParams = Record<string, string | number | undefined | null>;

/**
 * 金鑰解析。keyOverride/ivOverride 存在的唯一目的是讓 selftest 用官方測試向量
 * 驗證同一份程式碼;產線呼叫一律不傳,走環境變數。
 * 長度檢查放在呼叫時(而非 module load 時),確保沒設金鑰也能正常 import/build。
 */
function resolveKeys(keyOverride?: string, ivOverride?: string) {
  const hashKey = (keyOverride ?? process.env.PAYUNI_HASH_KEY ?? "").trim();
  const hashIv = (ivOverride ?? process.env.PAYUNI_HASH_IV ?? "").trim();
  const keyBuf = Buffer.from(hashKey, "utf8");
  const ivBuf = Buffer.from(hashIv, "utf8");
  if (keyBuf.length !== 32) {
    throw new Error(`PayUni HashKey 長度須為 32 bytes(目前 ${keyBuf.length})`);
  }
  if (ivBuf.length !== 16) {
    throw new Error(`PayUni HashIV 長度須為 16 bytes(目前 ${ivBuf.length})`);
  }
  return { hashKey, hashIv, keyBuf, ivBuf };
}

/** 參數 → application/x-www-form-urlencoded 明文。undefined/null 直接略過不送。 */
export function toPlaintext(params: PayuniParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

/** 產生 EncryptInfo(hex 字串)。 */
export function encryptInfo(
  params: PayuniParams,
  keyOverride?: string,
  ivOverride?: string
): string {
  const { keyBuf, ivBuf } = resolveKeys(keyOverride, ivOverride);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, ivBuf);
  let cipherText = cipher.update(toPlaintext(params), "utf8", "base64");
  cipherText += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");
  return Buffer.from(`${cipherText}:::${tag}`).toString("hex").trim();
}

/** 產生 HashInfo:SHA256(HashKey + EncryptInfo + HashIV) 的大寫 hex。 */
export function hashInfo(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string
): string {
  const { hashKey, hashIv } = resolveKeys(keyOverride, ivOverride);
  return createHash("sha256")
    .update(`${hashKey}${encryptInfoHex}${hashIv}`)
    .digest("hex")
    .toUpperCase();
}

/**
 * 驗簽:用自己的金鑰重算 HashInfo,與對方送來的值常數時間比對。
 * ⚠️ 呼叫順序上這一步必須在 decryptInfo() 之前 —— 驗簽不過的封包連解都不要解。
 */
export function verifyHashInfo(
  encryptInfoHex: string,
  receivedHashInfo: string | null | undefined
): boolean {
  if (!receivedHashInfo) return false;
  let expected: string;
  try {
    expected = hashInfo(encryptInfoHex);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(receivedHashInfo.trim().toUpperCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 解密 EncryptInfo,回傳明文字串。
 * GCM authTag 會在 final() 時驗證,被竄改的密文會直接 throw(完整性保護)。
 */
export function decryptInfoRaw(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string
): string {
  const { keyBuf, ivBuf } = resolveKeys(keyOverride, ivOverride);
  const hex = (encryptInfoHex ?? "").trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("PayUni EncryptInfo 非合法 hex 字串");
  }
  const raw = Buffer.from(hex, "hex").toString("utf8");
  // base64 字母表不含 ":",所以用 ":::" 切一定只會切出 2 段。
  const parts = raw.split(":::");
  if (parts.length !== 2) {
    throw new Error("PayUni EncryptInfo 格式錯誤(找不到 ::: 分隔)");
  }
  const [cipherB64, tagB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, ivBuf);
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  let plain = decipher.update(Buffer.from(cipherB64, "base64"), undefined, "utf8");
  plain += decipher.final("utf8");
  return plain;
}

/** 解密 EncryptInfo 並以 query string 格式 parse 成扁平物件(付款通知的格式)。 */
export function decryptInfo(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string
): Record<string, string> {
  const plain = decryptInfoRaw(encryptInfoHex, keyOverride, ivOverride);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(plain)) out[k] = v;
  return out;
}

// ────────────────────────────── 建立交易(UPP)──────────────────────────────

/** MerTradeNo 規則:≤25 碼、只允許 [A-Za-z0-9_-]、10 分鐘內不可重複。 */
const MER_TRADE_NO_RE = /^[A-Za-z0-9_-]{1,25}$/;

export interface PayuniUppOrder {
  /** 直接沿用 orders.order_no(格式 IV-2026-00001,天生符合 PayUni 規則且全站唯一)。 */
  merTradeNo: string;
  /** 整數 TWD。 */
  amount: number;
  /** 商品說明,≤550 碼(超過會截斷)。 */
  prodDesc: string;
}

export interface PayuniUppForm {
  /** 表單 POST 目的地(沙盒/正式不同網域)。 */
  action: string;
  /** 要以 hidden input 送出的四個外層欄位。 */
  fields: Record<string, string>;
}

/**
 * 組出要「由瀏覽器 Form POST」到 PayUni 整合式支付頁的內容。
 * ⚠️ 這跟本站舊金流商不同 —— PayUni 沒有「伺服器端建立交易換一個 redirect URL」的流程,
 * 交易是靠瀏覽器直接 POST 這四個欄位過去才成立,所以前端必須動態建 form 並 submit。
 */
export function buildUppForm(order: PayuniUppOrder): PayuniUppForm {
  const merId = payuniMerId();
  if (!merId) throw new Error("缺少 PAYUNI_MER_ID");
  if (!MER_TRADE_NO_RE.test(order.merTradeNo)) {
    throw new Error(`PayUni MerTradeNo 格式不符(≤25 碼且只能 A-Za-z0-9_-):${order.merTradeNo}`);
  }
  const amount = Math.round(Number(order.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`PayUni TradeAmt 需為正整數(收到 ${order.amount})`);
  }

  const params: PayuniParams = {
    MerID: merId,
    MerTradeNo: order.merTradeNo,
    TradeAmt: amount,
    Timestamp: Math.floor(Date.now() / 1000),
    ProdDesc: (order.prodDesc || `好日子訂單 ${order.merTradeNo}`).slice(0, 550),
    ReturnURL: payuniReturnUrl(order.merTradeNo),
    // 本次只開信用卡(Credit=1);ATM/超商等其他支付方式暫不開放。
    Credit: 1,
  };

  // NotifyURL 只接受 80/443 port。本機開發(localhost:3000)PayUni 本來也連不進來,
  // 直接不送這個欄位,避免整筆交易被 PayUni 以「NotifyURL 格式錯誤」退掉。
  const notifyUrl = payuniNotifyUrl();
  if (notifyUrl) {
    params.NotifyURL = notifyUrl;
  } else {
    console.warn("[payuni] NotifyURL 未帶入(非 80/443 port 或未設定 webhook secret),付款結果將只能靠前景輪詢");
  }

  const encrypt = encryptInfo(params);
  return {
    action: `${apiBase()}/api/upp`,
    fields: {
      MerID: merId,
      Version: UPP_VERSION,
      EncryptInfo: encrypt,
      HashInfo: hashInfo(encrypt),
    },
  };
}

/** 前景導回頁,附上 ?order= 供 checkout/confirm 輪詢用。 */
export function payuniReturnUrl(orderNo: string): string {
  return `${siteUrl()}/checkout/confirm?order=${encodeURIComponent(orderNo)}`;
}

/**
 * 背景通知網址,附上伺服器產生的密鑰(?k=)當第一道閘門。
 * PayUni 限制 NotifyURL 只能是 80/443 port —— 不符或缺密鑰時回 null(不送這個欄位)。
 */
export function payuniNotifyUrl(): string | null {
  const secret = process.env.PAYUNI_WEBHOOK_SECRET;
  if (!secret) return null;
  let url: URL;
  try {
    url = new URL(`${siteUrl()}/api/webhooks/payuni`);
  } catch {
    return null;
  }
  const port = url.port;
  const okPort =
    port === "" || (url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80");
  if (!okPort) return null;
  url.searchParams.set("k", secret);
  return url.toString();
}

// ────────────────────────────── 主動查詢交易 ──────────────────────────────

export interface PayuniTradeQueryResult {
  /** 外層 Status,"SUCCESS" 代表這次「查詢請求」合法,不代表付款成功。 */
  status?: string;
  message?: string;
  /** "0"=取號成功 "1"=付款成功 "2"=付款失敗 "3"=付款取消 "8"=訂單待確認 */
  tradeStatus?: string;
  /** 金流實際收到的金額(整數 TWD)。 */
  tradeAmt?: number;
  paymentType?: string;
  /** "A"=完整資料 "B"=處理中,建議稍後重查 */
  dataSource?: string;
  merTradeNo?: string;
  tradeNo?: string;
  /** 解密後的原始欄位,除錯用。 */
  raw: Record<string, string>;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return undefined;
}

/**
 * 解析查詢回應解密後的內容。
 * TODO(沙盒實測):文件對這段的格式描述不一致 —— 付款通知是 query string,查詢 API
 * 則提到回應含 Result 陣列(那比較像 JSON)。這裡兩種都吃:先試 JSON、失敗退回
 * query string;JSON 若有 Result 陣列就取第一筆。
 */
function parseQueryPayload(plain: string): Record<string, string> {
  const trimmed = plain.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const root = Array.isArray(parsed)
        ? (parsed[0] as Record<string, unknown> | undefined)
        : (parsed as Record<string, unknown>);
      if (root && typeof root === "object") {
        const result = (root as { Result?: unknown }).Result;
        const target = Array.isArray(result)
          ? (result[0] as Record<string, unknown> | undefined) ?? {}
          : (result && typeof result === "object" ? (result as Record<string, unknown>) : root);
        const flat: Record<string, string> = {};
        // 外層欄位(Status/Message)也一併保留,Result 內同名欄位優先。
        for (const [k, v] of Object.entries(root)) {
          if (k === "Result") continue;
          if (v !== null && typeof v !== "object") flat[k] = String(v);
        }
        for (const [k, v] of Object.entries(target)) {
          if (v !== null && typeof v !== "object") flat[k] = String(v);
        }
        return flat;
      }
    } catch {
      // 不是合法 JSON,往下用 query string 解
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v;
  return out;
}

/**
 * 伺服器對伺服器反查 —— 縱深防禦的核心。
 * 即使 webhook 的 HashInfo 驗簽已經通過,付款狀態與金額仍一律以這裡的結果為準,
 * 不用 notify body 解密出來的欄位直接判定付款成功。
 */
export async function queryPayuniTrade(merTradeNo: string): Promise<PayuniTradeQueryResult> {
  const merId = payuniMerId();
  if (!merId) throw new Error("缺少 PAYUNI_MER_ID");

  const encrypt = encryptInfo({
    MerID: merId,
    Timestamp: Math.floor(Date.now() / 1000),
    MerTradeNo: merTradeNo,
  });

  const body = new URLSearchParams({
    MerID: merId,
    Version: TRADE_QUERY_VERSION,
    EncryptInfo: encrypt,
    HashInfo: hashInfo(encrypt),
  });

  const res = await fetch(`${apiBase()}/api/trade/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`PayUni trade/query failed (HTTP ${res.status}): ${await res.text()}`);
  }

  const text = await res.text();
  let envelope: Record<string, string>;
  try {
    envelope = JSON.parse(text) as Record<string, string>;
  } catch {
    // 少數情況可能回 form-urlencoded,一併容錯。
    envelope = {};
    for (const [k, v] of new URLSearchParams(text)) envelope[k] = v;
  }

  const encInfo = envelope.EncryptInfo;
  if (!encInfo) {
    throw new Error(`PayUni trade/query 回應缺少 EncryptInfo:${text.slice(0, 300)}`);
  }
  // 回應也驗簽:確認這份密文確實由持有同一組 HashKey/HashIV 的一方產生。
  if (!verifyHashInfo(encInfo, envelope.HashInfo)) {
    throw new Error("PayUni trade/query 回應 HashInfo 驗簽失敗");
  }

  const payload = parseQueryPayload(decryptInfoRaw(encInfo));
  const amtRaw = pickFirst(payload, ["TradeAmt", "Amount"]);
  const amt = amtRaw === undefined ? undefined : Number(amtRaw);

  return {
    status: envelope.Status ?? pickFirst(payload, ["Status"]),
    message: envelope.Message ?? pickFirst(payload, ["Message"]),
    tradeStatus: pickFirst(payload, ["TradeStatus"]),
    tradeAmt: Number.isFinite(amt) ? (amt as number) : undefined,
    paymentType: pickFirst(payload, ["PaymentType"]),
    dataSource: pickFirst(payload, ["DataSource"]),
    merTradeNo: pickFirst(payload, ["MerTradeNo"]),
    tradeNo: pickFirst(payload, ["TradeNo"]),
    raw: payload,
  };
}

/** 付款成功的權威判定值。其他值:0=取號成功 2=付款失敗 3=付款取消 8=訂單待確認 */
export const TRADE_STATUS_PAID = "1";
export const TRADE_STATUS_FAILED = "2";
export const TRADE_STATUS_CANCELLED = "3";
