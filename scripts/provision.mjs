#!/usr/bin/env node
/**
 * 好日子 Good Days 一鍵佈建腳本
 *
 * 用你的平台 token 自動完成:
 *   1. Supabase:建立專案 → 跑 migrations → 關閉 email 確認 → 建立管理員帳號
 *   2. Vercel:建立專案並綁定 GitHub repo(push 即自動部署)→ 設定環境變數 → 觸發首次部署
 *   3. Railway:建立專案 + api 服務(綁定 GitHub repo)→ 設定環境變數 → 產生網域
 *
 * 使用方式(在 repo 根目錄):
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx \
 *   VERCEL_TOKEN=xxx \
 *   RAILWAY_TOKEN=xxx \
 *   RESEND_API_KEY=re_xxx \
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=你的密碼 \
 *   node scripts/provision.mjs
 *
 * 選填:GEMINI_API_KEY(AI 報價)、SUPABASE_ORG_ID、GITHUB_REPO、PROJECT_NAME
 * 冪等:重複執行會沿用既有資源,不會重複建立。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENV = {
  SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
  PAYUNI_MER_ID: process.env.PAYUNI_MER_ID ?? "",
  PAYUNI_HASH_KEY: process.env.PAYUNI_HASH_KEY ?? "",
  PAYUNI_HASH_IV: process.env.PAYUNI_HASH_IV ?? "",
  // 未設定時故意不寫這個變數 → 線上讀到 undefined → payuni.ts 判定為沙盒(安全側)。
  PAYUNI_SANDBOX: process.env.PAYUNI_SANDBOX ?? "",
  PAYUNI_WEBHOOK_SECRET: process.env.PAYUNI_WEBHOOK_SECRET ?? "",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  SUPABASE_ORG_ID: process.env.SUPABASE_ORG_ID ?? "",
  GITHUB_REPO: process.env.GITHUB_REPO ?? "LaiQuan-tech/goodday",
  PROJECT_NAME: process.env.PROJECT_NAME ?? "goodday",
  SUPABASE_REGION: process.env.SUPABASE_REGION ?? "ap-northeast-1",
};

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exitCode = 1;
};

async function api(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= Supabase =================
const SB = "https://api.supabase.com";
const sbHeaders = () => ({ Authorization: `Bearer ${ENV.SUPABASE_ACCESS_TOKEN}` });

async function provisionSupabase() {
  log("Supabase:檢查組織…");
  const orgs = await api(`${SB}/v1/organizations`, { headers: sbHeaders() });
  if (!orgs.ok) throw new Error(`無法取得 Supabase 組織(${orgs.status}):${orgs.text}`);
  const orgId = ENV.SUPABASE_ORG_ID || orgs.json?.[0]?.id;
  if (!orgId) throw new Error("找不到 Supabase 組織,請確認 token 權限");

  // 沿用既有專案或建立新專案
  const projects = await api(`${SB}/v1/projects`, { headers: sbHeaders() });
  let project = (projects.json ?? []).find((p) => p.name === ENV.PROJECT_NAME);
  let dbPassword = "";

  if (project) {
    ok(`Supabase 專案已存在:${project.id}`);
  } else {
    dbPassword = crypto.randomBytes(18).toString("base64url");
    log(`Supabase:建立專案 ${ENV.PROJECT_NAME}(${ENV.SUPABASE_REGION})…`);
    const created = await api(`${SB}/v1/projects`, {
      method: "POST",
      headers: sbHeaders(),
      body: {
        name: ENV.PROJECT_NAME,
        organization_id: orgId,
        region: ENV.SUPABASE_REGION,
        db_pass: dbPassword,
      },
    });
    if (!created.ok) throw new Error(`Supabase 專案建立失敗(${created.status}):${created.text}`);
    project = created.json;
    ok(`Supabase 專案建立:${project.id}(DB 密碼已寫入 .provision-output.json)`);
  }

  const ref = project.id;

  // 等待專案就緒
  log("Supabase:等待專案就緒…");
  for (let i = 0; i < 60; i++) {
    const detail = await api(`${SB}/v1/projects/${ref}`, { headers: sbHeaders() });
    if (detail.json?.status === "ACTIVE_HEALTHY") break;
    await sleep(5000);
    if (i === 59) throw new Error("Supabase 專案遲遲未就緒,請稍後重跑此腳本");
  }
  ok("Supabase 專案就緒");

  // 取 API keys
  const keys = await api(`${SB}/v1/projects/${ref}/api-keys`, { headers: sbHeaders() });
  if (!keys.ok) throw new Error(`無法取得 API keys:${keys.text}`);
  const anonKey = keys.json.find((k) => k.name === "anon")?.api_key;
  const serviceKey = keys.json.find((k) => k.name === "service_role")?.api_key;
  if (!anonKey || !serviceKey) throw new Error("API keys 不完整");
  const supabaseUrl = `https://${ref}.supabase.co`;

  // 跑 migrations(冪等:記錄在 _migrations 表)
  log("Supabase:套用 migrations…");
  const runSql = async (query) =>
    api(`${SB}/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: sbHeaders(),
      body: { query },
    });

  await runSql(
    `create table if not exists public._migrations (name text primary key, applied_at timestamptz default now());`
  );
  const migrationDir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const done = await runSql(
      `select 1 from public._migrations where name = '${file}';`
    );
    if (Array.isArray(done.json) && done.json.length > 0) {
      ok(`migration 已套用過:${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationDir, file), "utf8");
    const result = await runSql(sql);
    if (!result.ok) throw new Error(`migration ${file} 失敗:${result.text}`);
    await runSql(`insert into public._migrations (name) values ('${file}');`);
    ok(`migration 套用:${file}`);
  }

  // Auth 設定:自動確認 email(免設 SMTP 即可註冊)
  const siteUrl = `https://${ENV.PROJECT_NAME}.vercel.app`;
  await api(`${SB}/v1/projects/${ref}/config/auth`, {
    method: "PATCH",
    headers: sbHeaders(),
    body: { mailer_autoconfirm: true, site_url: siteUrl },
  });
  ok("Supabase Auth:已開啟註冊自動確認");

  // 建立管理員
  if (ENV.ADMIN_EMAIL && ENV.ADMIN_PASSWORD) {
    log(`Supabase:建立管理員 ${ENV.ADMIN_EMAIL}…`);
    const createUser = await api(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: {
        email: ENV.ADMIN_EMAIL,
        password: ENV.ADMIN_PASSWORD,
        email_confirm: true,
      },
    });
    if (createUser.ok || createUser.status === 422) {
      // 422 = 已存在
      await runSql(
        `update public.profiles set role = 'admin' where email = '${ENV.ADMIN_EMAIL.replace(/'/g, "''")}';`
      );
      ok(`管理員已設定:${ENV.ADMIN_EMAIL}(可登入 /admin)`);
    } else {
      warn(`管理員建立失敗(${createUser.status}):${createUser.text}`);
    }
  } else {
    warn("未提供 ADMIN_EMAIL / ADMIN_PASSWORD,略過管理員建立(之後可在 SQL editor 手動把 profiles.role 改成 admin)");
  }

  return { ref, supabaseUrl, anonKey, serviceKey, dbPassword, siteUrl };
}

// ================= Vercel =================
const VC = "https://api.vercel.com";
const vcHeaders = () => ({ Authorization: `Bearer ${ENV.VERCEL_TOKEN}` });

async function provisionVercel(sb) {
  log("Vercel:檢查專案…");
  let project;
  const existing = await api(`${VC}/v9/projects/${ENV.PROJECT_NAME}`, {
    headers: vcHeaders(),
  });
  if (existing.ok) {
    project = existing.json;
    ok(`Vercel 專案已存在:${project.id}`);
  } else {
    log("Vercel:建立專案並綁定 GitHub repo…");
    const created = await api(`${VC}/v11/projects`, {
      method: "POST",
      headers: vcHeaders(),
      body: {
        name: ENV.PROJECT_NAME,
        framework: "nextjs",
        rootDirectory: "web",
        gitRepository: { type: "github", repo: ENV.GITHUB_REPO },
      },
    });
    if (!created.ok) {
      if (/github/i.test(created.text)) {
        warn(
          `Vercel 無法綁定 GitHub repo(${created.status})。請先到 https://vercel.com/account/git 安裝 Vercel GitHub App 並授權 ${ENV.GITHUB_REPO},再重跑此腳本。`
        );
        // 退而求其次:先建不綁 git 的專案,讓環境變數先就位
        const bare = await api(`${VC}/v11/projects`, {
          method: "POST",
          headers: vcHeaders(),
          body: { name: ENV.PROJECT_NAME, framework: "nextjs", rootDirectory: "web" },
        });
        if (!bare.ok) throw new Error(`Vercel 專案建立失敗:${bare.text}`);
        project = bare.json;
      } else {
        throw new Error(`Vercel 專案建立失敗(${created.status}):${created.text}`);
      }
    } else {
      project = created.json;
      ok(`Vercel 專案建立:${project.id}(push main 即自動部署)`);
    }
  }

  // 專案名可能已被其他帳號佔用,Vercel 會另配網域(如 interval-livid.vercel.app)——
  // 一律以 API 回傳的實際網域為準,不可用專案名推測
  let prodUrl = `https://${ENV.PROJECT_NAME}.vercel.app`;
  const domainsRes = await api(`${VC}/v9/projects/${project.id}/domains`, { headers: vcHeaders() });
  const assigned = (domainsRes.json?.domains ?? []).find((d) => d.verified);
  if (assigned) prodUrl = `https://${assigned.name}`;

  // 環境變數(upsert)
  log("Vercel:設定環境變數…");
  const envs = [
    ["NEXT_PUBLIC_SUPABASE_URL", sb.supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", sb.anonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", sb.serviceKey],
    ["NEXT_PUBLIC_SITE_URL", prodUrl],
    ["RESEND_API_KEY", ENV.RESEND_API_KEY],
    ["RESEND_FROM", "好日子 Good Days <no-reply@gathertaiwan.com>"],
    ["CONTACT_NOTIFY_TO", ENV.ADMIN_EMAIL],
    ["GEMINI_API_KEY", ENV.GEMINI_API_KEY],
    ["PAYUNI_MER_ID", ENV.PAYUNI_MER_ID],
    ["PAYUNI_HASH_KEY", ENV.PAYUNI_HASH_KEY],
    ["PAYUNI_HASH_IV", ENV.PAYUNI_HASH_IV],
    ["PAYUNI_SANDBOX", ENV.PAYUNI_SANDBOX],
    ["PAYUNI_WEBHOOK_SECRET", ENV.PAYUNI_WEBHOOK_SECRET],
  ].filter(([, v]) => v);

  const upsert = await api(`${VC}/v10/projects/${project.id}/env?upsert=true`, {
    method: "POST",
    headers: vcHeaders(),
    body: envs.map(([key, value]) => ({
      key,
      value,
      type: key.startsWith("NEXT_PUBLIC_") ? "plain" : "encrypted",
      target: ["production", "preview", "development"],
    })),
  });
  if (!upsert.ok) warn(`Vercel 環境變數設定部分失敗:${upsert.text}`);
  else ok("Vercel 環境變數完成");

  // 若已綁 git,觸發首次部署
  const repoId = project.link?.repoId;
  if (repoId) {
    log("Vercel:觸發首次部署…");
    const deploy = await api(`${VC}/v13/deployments`, {
      method: "POST",
      headers: vcHeaders(),
      body: {
        name: ENV.PROJECT_NAME,
        project: project.id,
        target: "production",
        gitSource: { type: "github", repoId, ref: "main" },
      },
    });
    if (deploy.ok) ok(`部署觸發:${deploy.json?.url ? `https://${deploy.json.url}` : "已排入佇列"}`);
    else warn(`首次部署觸發失敗(push 一個 commit 到 main 也會自動部署):${deploy.text}`);
  }

  return { projectId: project.id, prodUrl };
}

// ================= Railway =================
const RW = "https://backboard.railway.app/graphql/v2";

async function railwayGql(query, variables = {}) {
  const res = await api(RW, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.RAILWAY_TOKEN}` },
    body: { query, variables },
  });
  if (res.json?.errors?.length) {
    throw new Error(`Railway GraphQL:${JSON.stringify(res.json.errors)}`);
  }
  if (!res.ok) throw new Error(`Railway API(${res.status}):${res.text}`);
  return res.json.data;
}

async function provisionRailway(sb, vercel) {
  log("Railway:檢查專案…");

  // me.projects 已廢棄(回傳恆為空,會導致每次重跑都新建專案)——必須從 workspaces 查
  const me = await railwayGql(
    `query { me { workspaces { id projects { edges { node { id name } } } } } }`
  );
  const allProjects = (me.me.workspaces ?? []).flatMap((w) =>
    w.projects.edges.map((e) => e.node)
  );
  let project = allProjects.find((p) => p.name === ENV.PROJECT_NAME);

  if (project) {
    ok(`Railway 專案已存在:${project.id}`);
  } else {
    // Railway API 現在要求 workspaceId,取 token 所屬的第一個 workspace
    const ws = await railwayGql(`query { me { workspaces { id name } } }`);
    const workspaceId = ws.me.workspaces?.[0]?.id;
    if (!workspaceId) throw new Error("Railway:找不到 workspace,請確認 token 權限");
    const created = await railwayGql(
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`,
      { input: { name: ENV.PROJECT_NAME, workspaceId } }
    );
    project = created.projectCreate;
    ok(`Railway 專案建立:${project.id}`);
  }

  const envData = await railwayGql(
    `query($id: String!) { project(id: $id) {
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      } }`,
    { id: project.id }
  );
  const environment =
    envData.project.environments.edges.map((e) => e.node).find((e) => e.name === "production") ??
    envData.project.environments.edges[0]?.node;
  let service = envData.project.services.edges.map((e) => e.node).find((s) => s.name === "api");

  if (!service) {
    log("Railway:建立 api 服務並綁定 GitHub repo…");
    try {
      const created = await railwayGql(
        `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
        {
          input: {
            projectId: project.id,
            name: "api",
            source: { repo: ENV.GITHUB_REPO },
          },
        }
      );
      service = created.serviceCreate;
      ok(`Railway api 服務建立:${service.id}(push main 即自動部署)`);
    } catch (err) {
      warn(
        `Railway 服務綁 GitHub 失敗:${err.message}\n  → 請到 https://railway.app/account 連結 GitHub 帳號並授權 ${ENV.GITHUB_REPO},再重跑此腳本。`
      );
      return { projectId: project.id, apiUrl: "" };
    }
  } else {
    ok(`Railway api 服務已存在:${service.id}`);
  }

  // 環境變數
  log("Railway:設定環境變數…");
  const jobSecret = crypto.randomBytes(24).toString("base64url");
  await railwayGql(
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: project.id,
        environmentId: environment.id,
        serviceId: service.id,
        variables: {
          SUPABASE_URL: sb.supabaseUrl,
          SUPABASE_SERVICE_ROLE_KEY: sb.serviceKey,
          RESEND_API_KEY: ENV.RESEND_API_KEY,
          RESEND_FROM: "好日子 Good Days <no-reply@gathertaiwan.com>",
          SITE_URL: vercel.prodUrl,
          JOB_SECRET: jobSecret,
          QUOTE_FOLLOWUP_DAYS: "3",
          TZ: "Asia/Taipei",
        },
      },
    }
  );
  ok("Railway 環境變數完成");

  // 產生對外網域
  let apiUrl = "";
  try {
    const domains = await railwayGql(
      `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
         domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
           serviceDomains { domain }
         }
       }`,
      { projectId: project.id, environmentId: environment.id, serviceId: service.id }
    );
    const existing = domains.domains?.serviceDomains?.[0]?.domain;
    if (existing) {
      apiUrl = `https://${existing}`;
    } else {
      const created = await railwayGql(
        `mutation($input: ServiceDomainCreateInput!) {
           serviceDomainCreate(input: $input) { domain }
         }`,
        { input: { environmentId: environment.id, serviceId: service.id } }
      );
      apiUrl = `https://${created.serviceDomainCreate.domain}`;
    }
    ok(`Railway 網域:${apiUrl}`);
  } catch (err) {
    warn(`Railway 網域設定略過:${err.message}`);
  }

  return { projectId: project.id, apiUrl, jobSecret };
}

// ================= Resend =================
async function checkResend() {
  if (!ENV.RESEND_API_KEY) {
    warn("未提供 RESEND_API_KEY,email 通知將停用");
    return;
  }
  const res = await api("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${ENV.RESEND_API_KEY}` },
  });
  if (!res.ok) {
    warn(`Resend key 驗證失敗(${res.status}),請確認 key 是否有效`);
    return;
  }
  const domains = res.json?.data ?? [];
  if (domains.length === 0) {
    warn(
      "Resend 尚未驗證自有網域 — 目前使用 onboarding@resend.dev 寄信(只能寄給你自己的信箱)。正式上線請到 https://resend.com/domains 加入網域後,把 RESEND_FROM 換成自有網域。"
    );
  } else {
    ok(`Resend 已驗證網域:${domains.map((d) => d.name).join(", ")}`);
  }
}

// ================= main =================
async function main() {
  console.log("\n=== 好日子 Good Days 一鍵佈建 ===\n");

  const missing = ["SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN", "RAILWAY_TOKEN"].filter(
    (k) => !ENV[k]
  );
  if (missing.length) {
    fail(`缺少必要環境變數:${missing.join(", ")}`);
    return;
  }

  const output = { generatedAt: new Date().toISOString() };

  try {
    const sb = await provisionSupabase();
    output.supabase = {
      projectRef: sb.ref,
      url: sb.supabaseUrl,
      anonKey: sb.anonKey,
      serviceRoleKey: "(保密,已直接寫入 Vercel/Railway)",
      dbPassword: sb.dbPassword || "(沿用既有專案)",
    };

    const vc = await provisionVercel(sb);
    output.vercel = { projectId: vc.projectId, url: vc.prodUrl };

    // Supabase auth site_url 在 Vercel 之前只能用推測值,拿到實際網域後回頭修正
    if (vc.prodUrl !== sb.siteUrl) {
      await api(`${SB}/v1/projects/${sb.ref}/config/auth`, {
        method: "PATCH",
        headers: sbHeaders(),
        body: { site_url: vc.prodUrl },
      });
      ok(`Supabase Auth site_url 已修正為實際網域:${vc.prodUrl}`);
    }

    const rw = await provisionRailway(sb, vc);
    output.railway = { projectId: rw.projectId, apiUrl: rw.apiUrl };

    await checkResend();

    writeFileSync(
      join(ROOT, ".provision-output.json"),
      JSON.stringify({ ...output, supabase: { ...output.supabase } }, null, 2)
    );

    console.log(`
=== 佈建完成 🎉 ===

  網站(Vercel):   ${vc.prodUrl}
  API(Railway):   ${rw.apiUrl || "(待 GitHub 授權後重跑)"}
  Supabase:        https://supabase.com/dashboard/project/${sb.ref}
  後台:            ${vc.prodUrl}/admin${ENV.ADMIN_EMAIL ? `(帳號 ${ENV.ADMIN_EMAIL})` : ""}

之後只要 push 到 ${ENV.GITHUB_REPO} 的 main 分支,Vercel 與 Railway 就會自動部署。
細節已寫入 .provision-output.json(已列入 .gitignore,請勿提交)。
`);
  } catch (err) {
    fail(err.message);
    console.error("\n可以直接重跑此腳本(冪等),或依錯誤訊息處理後再試。");
  }
}

main();
