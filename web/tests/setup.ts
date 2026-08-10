// 測試一律 hermetic:連外的嘗試要**當場炸掉**,而不是安靜地逾時、或真的打出去。
//
// 為什麼需要這道保險:vi.mock 是逐個模組手動假掉的,漏掉一個(例如某支 lib 之後
// 新增了一個 fetch 呼叫)不會有任何徵兆 —— 測試照樣綠,只是變慢,或在 CI 上因為
// 網路不通而間歇性紅。把 fetch / net.connect / dns.lookup 換成會 throw 的版本之後,
// 「有東西想連外」立刻變成一個訊息明確的失敗。
//
// ⚠️ 這個檔案刻意不叫 *.test.ts:CI 有一道 glob 漂移檢查會比對磁碟上的 *.test.ts
// 檔數與 vitest 實跑檔數,setup 檔混進去會讓兩邊對不上。
import dns from "node:dns";
import net from "node:net";

function deny(what: string): () => never {
  return () => {
    throw new Error(
      `[hermetic] 測試不得連外(${what})。請用 vi.mock 把這個相依假掉,不要讓它真的送出請求。`
    );
  };
}

globalThis.fetch = deny("fetch") as unknown as typeof globalThis.fetch;

net.connect = deny("net.connect") as unknown as typeof net.connect;
net.createConnection = deny("net.createConnection") as unknown as typeof net.createConnection;

dns.lookup = deny("dns.lookup") as unknown as typeof dns.lookup;
dns.promises.lookup = deny("dns.promises.lookup") as unknown as typeof dns.promises.lookup;
