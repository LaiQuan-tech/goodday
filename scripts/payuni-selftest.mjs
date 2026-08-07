#!/usr/bin/env node
// PayUni 加解密自檢 —— 不需要任何真實金鑰。
//
// 用官方文件的測試向量,驗證 web/src/lib/payments/payuni.ts 的
// encryptInfo / hashInfo / decryptInfo 三個函式。
//
// ⚠️ 這支腳本刻意「直接 import 產線那份 payuni.ts」(靠 Node 原生 TypeScript 型別剝離,
// 不經 bundler),不複製一份加解密邏輯 —— 複製品驗過了不代表產線那份是對的。
// 這是在沒有商店金鑰的情況下,唯一能證明加解密實作正確的方法。
//
// 執行:node scripts/payuni-selftest.mjs
// 需求:Node >= 22.6(型別剝離)。專案 engines 寫 >=20,故此處明確檢查並提示。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `✗ 需要 Node >= 22.6 才能直接 import TypeScript 原始碼(目前 ${process.versions.node})`
  );
  process.exit(1);
}

// ── 官方測試向量 ──────────────────────────────────────────────────────────
const KEY = "12345678901234567890123456789012"; // 32 chars
const IV = "1234567890123456"; // 16 chars
const PARAMS = { MerID: "AAA", MerTradeNO: "BBB", Prod: "商品說明" };
const EXPECT_PLAINTEXT = "MerID=AAA&MerTradeNO=BBB&Prod=%E5%95%86%E5%93%81%E8%AA%AA%E6%98%8E";
const EXPECT_HASHINFO =
  "E97180D78C8378D64A188D292938B9D2717034F292B626019B01DF160AEFC0B7";

// verifyHashInfo() 沒有 override 參數(產線上不該有),用環境變數餵測試金鑰。
process.env.PAYUNI_HASH_KEY = KEY;
process.env.PAYUNI_HASH_IV = IV;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "web/src/lib/payments/payuni.ts");

let mod;
try {
  mod = await import(`file://${MODULE_PATH}`);
} catch (err) {
  console.error(`✗ 無法載入 ${MODULE_PATH}`);
  console.error(err);
  process.exit(1);
}

const {
  toPlaintext,
  encryptInfo,
  hashInfo,
  decryptInfo,
  decryptInfoRaw,
  verifyHashInfo,
} = mod;

// ── 迷你測試框架 ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const okay = actual === expected;
  if (okay) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

function checkTrue(name, actual) {
  check(name, actual === true, true);
}

function checkThrows(name, fn) {
  try {
    fn();
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}(預期會 throw,實際沒有)`);
  } catch {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  }
}

console.log("\nPayUni 加解密自檢(官方測試向量,不需真實金鑰)");
console.log(`模組:${MODULE_PATH}\n`);

// ── 1. 明文組成 ───────────────────────────────────────────────────────────
console.log("[1] 明文 = x-www-form-urlencoded query string");
check("toPlaintext 與官方明文逐字相符", toPlaintext(PARAMS), EXPECT_PLAINTEXT);

// ── 2. encryptInfo ────────────────────────────────────────────────────────
console.log("\n[2] encryptInfo(aes-256-gcm → base64密文:::base64tag → hex)");
const enc = encryptInfo(PARAMS, KEY, IV);
checkTrue("EncryptInfo 是小寫 hex", /^[0-9a-f]+$/.test(enc));
check(
  "hex 解回來含 ::: 分隔且切成 2 段",
  Buffer.from(enc, "hex").toString("utf8").split(":::").length,
  2
);
// GCM 在 key/iv/明文固定時是決定性的,所以密文可逐字比對。
const encAgain = encryptInfo(PARAMS, KEY, IV);
check("同輸入產生同 EncryptInfo(決定性)", encAgain, enc);

// ── 3. hashInfo(官方測試向量的關鍵斷言)──────────────────────────────────
console.log("\n[3] hashInfo = SHA256(HashKey + EncryptInfo + HashIV) 大寫 hex");
const hash = hashInfo(enc, KEY, IV);
check("HashInfo 與官方測試向量相符", hash, EXPECT_HASHINFO);

// ── 4. decryptInfo ────────────────────────────────────────────────────────
console.log("\n[4] decryptInfo(hex → :::切分 → base64 → AES-GCM 驗 tag 解密)");
check("decryptInfoRaw 還原出原始明文", decryptInfoRaw(enc, KEY, IV), EXPECT_PLAINTEXT);
const parsed = decryptInfo(enc, KEY, IV);
check("decryptInfo.MerID", parsed.MerID, "AAA");
check("decryptInfo.MerTradeNO", parsed.MerTradeNO, "BBB");
check("decryptInfo.Prod(中文正確還原)", parsed.Prod, "商品說明");

// ── 5. 完整性保護:被竄改的密文必須解不開 ────────────────────────────────
console.log("\n[5] GCM authTag 完整性保護");
const raw = Buffer.from(enc, "hex").toString("utf8");
const [ctB64, tagB64] = raw.split(":::");
const ctBuf = Buffer.from(ctB64, "base64");
ctBuf[0] ^= 0xff; // 竄改密文第一個 byte
const tampered = Buffer.from(
  `${ctBuf.toString("base64")}:::${tagB64}`
).toString("hex");
checkThrows("密文被竄改 → decryptInfo throw", () => decryptInfo(tampered, KEY, IV));

const badTag = Buffer.from(
  `${ctB64}:::${Buffer.from("0".repeat(16)).toString("base64")}`
).toString("hex");
checkThrows("authTag 錯誤 → decryptInfo throw", () => decryptInfo(badTag, KEY, IV));
checkThrows("非法 hex → decryptInfo throw", () => decryptInfo("zzzz", KEY, IV));
checkThrows("缺少 ::: 分隔 → decryptInfo throw", () =>
  decryptInfo(Buffer.from("nope").toString("hex"), KEY, IV)
);

// ── 6. 驗簽 ───────────────────────────────────────────────────────────────
console.log("\n[6] verifyHashInfo(webhook 第一道:先驗簽才解密)");
checkTrue("正確 HashInfo 通過", verifyHashInfo(enc, EXPECT_HASHINFO));
checkTrue("小寫 HashInfo 也通過(比對前正規化)", verifyHashInfo(enc, EXPECT_HASHINFO.toLowerCase()));
check("錯誤 HashInfo 被拒", verifyHashInfo(enc, "A".repeat(64)), false);
check("空 HashInfo 被拒", verifyHashInfo(enc, ""), false);
check("長度不符的 HashInfo 被拒", verifyHashInfo(enc, "ABC"), false);

// ── 7. 金鑰長度守門 ───────────────────────────────────────────────────────
console.log("\n[7] 金鑰長度檢查(32 / 16 bytes)");
checkThrows("HashKey 長度錯誤 → throw", () => encryptInfo(PARAMS, "tooshort", IV));
checkThrows("HashIV 長度錯誤 → throw", () => encryptInfo(PARAMS, KEY, "short"));

// ── 結果 ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過:${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ 有失敗:${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(1);
}
