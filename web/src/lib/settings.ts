import { createAdminClient } from "@/lib/supabase/admin";
import { reportIssue } from "@/lib/observability";
import type { RateCardItem } from "@/lib/types";

export type CompanyProfile = {
  name: string;
  tagline: string;
  email: string;
  phone: string;
  bank_info?: string; // 匯款資訊,顯示在銀行轉帳訂單頁
  about?: string;
  address?: string; // 門市地址(預約參訪頁用)
  hours?: string;   // 營業時間(預約參訪頁用)
};

export type QuoteConfig = {
  valid_days: number;
  tax_rate: number;
  followup_days: number;
};

export type ShippingConfig = {
  fee_home: number; // 宅配運費(NT$)
  free_threshold_home: number; // 宅配免運門檻(以實體商品小計計算)
  deadline_days: number; // 銀行轉帳訂單的繳費期限(天)
};

/**
 * 設定讀取結果。`ok=false` 代表「讀不到,value 是硬編的 fallback」——
 * 呼叫端自己決定要 fail-open(顯示用,用預設值就好)還是 fail-closed(金流路徑)。
 *
 * 為什麼要多這個旗標:舊寫法 `const { data } = ...` + try/catch 把「查詢失敗」和
 * 「這個 key 沒設定過」壓成同一件事,兩者都回 fallback。對顯示欄位無所謂,但
 * shipping 的 fallback 是 fee_home=200 / free_threshold_home=10000,與線上實際
 * 設定(120 / 3000)不同 —— DB 一抖,客人就被收錯運費、免運門檻也錯,而且沒有
 * 任何痕跡。deadline_days 更會一路影響課程座位的保留期限。
 */
export type SettingResult<T> = { value: T; ok: boolean };

export async function getSettingResult<T>(key: string, fallback: T): Promise<SettingResult<T>> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      reportIssue("settings.load-failed", error, { key });
      return { value: fallback, ok: false };
    }
    return { value: (data?.value as T) ?? fallback, ok: true };
  } catch (err) {
    reportIssue("settings.load-threw", err, { key });
    return { value: fallback, ok: false };
  }
}

/**
 * fail-open 版本(行為與修改前逐字相同:讀不到就回 fallback)。
 * 差別只在錯誤不再無聲消失 —— getSettingResult 已經 reportIssue 過了。
 * 金流路徑請改用 *Result 版本自己判斷 ok。
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { value } = await getSettingResult(key, fallback);
  return value;
}

const COMPANY_PROFILE_FALLBACK: CompanyProfile = {
  name: "好日子 Good Days",
  tagline: "為懂得生活的人，典藏值得停留的時光",
  email: "",
  phone: "",
};

export async function getCompanyProfileResult(): Promise<SettingResult<CompanyProfile>> {
  return getSettingResult<CompanyProfile>("company_profile", COMPANY_PROFILE_FALLBACK);
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  return getSetting<CompanyProfile>("company_profile", COMPANY_PROFILE_FALLBACK);
}

export async function getRateCard(): Promise<{ note: string; items: RateCardItem[] }> {
  return getSetting("rate_card", { note: "", items: [] as RateCardItem[] });
}

export async function getQuoteConfig(): Promise<QuoteConfig> {
  return getSetting<QuoteConfig>("quote_config", {
    valid_days: 14,
    tax_rate: 0.05,
    followup_days: 3,
  });
}

const SHIPPING_FALLBACK: ShippingConfig = {
  fee_home: 200,
  free_threshold_home: 10000,
  deadline_days: 3,
};

export async function getShippingConfigResult(): Promise<SettingResult<ShippingConfig>> {
  return getSettingResult<ShippingConfig>("shipping", SHIPPING_FALLBACK);
}

export async function getShippingConfig(): Promise<ShippingConfig> {
  return getSetting<ShippingConfig>("shipping", SHIPPING_FALLBACK);
}
