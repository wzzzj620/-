import type { Config } from "@netlify/functions";

/**
 * GET /api/base?table=原料
 * GET /api/base?table=原料&fields=原料编码,通用原料名称,状态
 * GET /api/base                     -> 列出已配置的表名
 *
 * 设计约束（Netlify 特有，别改）：
 * 1) 函数是临时容器，token 只能在单次调用内复用，模块级 cache 仅对"热"实例有效；
 * 2) 同步函数约 10 秒超时，所以一次只读一张表，且总耗时超过 8 秒就带着已有数据返回；
 * 3) 响应体有上限，fields 参数用来在前端裁掉不需要的列。
 */

const FEISHU = "https://open.feishu.cn/open-apis";
const PAGE_SIZE = 500;
const MAX_PAGES = 10; // 最多 5000 条，防止撞超时
const TIME_BUDGET_MS = 8000;

const ERR_HINT: Record<number, string> = {
  1254003: "BASE_APP_TOKEN 不对：去多维表格 URL 里 /base/ 后面那段重新复制",
  1254004: "table_id 不对：这张表的 tbl 开头 id 和 BASE_TABLES 里的对不上",
  1254005: "view_id 不对",
  1254018: "筛选参数格式不对",
  1254302: "多维表格开了高级权限：去「高级权限」建一个包含本应用的权限组，给只读或读写",
  1254301: "该多维表格不支持/未开启高级权限",
  1254103: "记录数超过 2 万条上限",
  99991679: "应用权限没开通或开通后没发布审核：权限管理勾 bitable:app:readonly 后创建版本并发版",
  1254290: "请求太快被限流，稍后重试（飞书限 20 次/秒）",
};

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Netlify 环境变量 ${key} 未设置`);
  return v;
}

let tokenCache: { token: string; exp: number } | null = null;

async function tenantToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 30_000) return tokenCache.token;

  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env("FEISHU_APP_ID"), app_secret: env("FEISHU_APP_SECRET") }),
  });
  const j: any = await res.json();
  if (j.code !== 0) throw new Error(`换 token 失败 ${j.code} ${j.msg}`);

  tokenCache = { token: j.tenant_access_token, exp: Date.now() + (j.expire ?? 7200) * 1000 };
  return tokenCache.token;
}

/** 飞书每类字段返回结构都不同，这里统一压成「字符串 / 数字 / 字符串数组」 */
function flatten(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return v;

  if (v.length === 0) return null;
  const first = v[0] as any;
  if (first && typeof first === "object") {
    if (typeof first.text === "string") return v.map((s: any) => s.text ?? "").join("");
    if (Array.isArray(first.link_record_ids)) return v.flatMap((l: any) => l.link_record_ids);
    if (typeof first.name === "string") return v.map((s: any) => s.name);
  }
  return v;
}

function looksLikeTimeKey(k: string): boolean {
  return /时间|日期|created_at|updated_at/.test(k);
}

/** 毫秒时间戳按北京时间输出，避免前端拿到 UTC 串显示成前一天 */
function toBeijingTime(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function normalize(fields: Record<string, unknown>, only?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(fields ?? {})) {
    if (only && !only.includes(k)) continue;
    const v = flatten(raw);
    out[k] =
      looksLikeTimeKey(k) && typeof v === "number" && v > 1e11 && v < 1e13
        ? toBeijingTime(v)
        : v;
  }
  return out;
}

async function listAll(tableId: string, token: string, only?: string[]) {
  const started = Date.now();
  const rows: any[] = [];
  let pageToken = "";
  let partial = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      partial = true;
      break;
    }
    const q = new URLSearchParams({ page_size: String(PAGE_SIZE), text_field_as_array: "false" });
    if (pageToken) q.set("page_token", pageToken);

    const res = await fetch(
      `${FEISHU}/bitable/v1/apps/${env("BASE_APP_TOKEN")}/tables/${tableId}/records?${q}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      }
    );
    const j: any = await res.json();
    if (j.code !== 0) {
      throw new Error(`[${j.code}] ${j.msg}${ERR_HINT[j.code] ? " → " + ERR_HINT[j.code] : ""}`);
    }

    for (const item of j.data?.items ?? []) {
      rows.push({ record_id: item.record_id, ...normalize(item.fields, only) });
    }

    if (!j.data?.has_more) return { rows, partial };
    pageToken = j.data.page_token;
  }
  return { rows, partial: true };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const fieldsParam = url.searchParams.get("fields");
  const only = fieldsParam ? fieldsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  let tables: Record<string, string> = {};
  try {
    tables = JSON.parse(env("BASE_TABLES"));
  } catch (e: any) {
    return Response.json(
      { error: `BASE_TABLES 不是合法 JSON：${e.message}` },
      { status: 500 }
    );
  }

  // 不带 table 就返回可用表名，方便自检
  if (!table) {
    return Response.json(
      { tables: Object.keys(tables), hint: "加 ?table=表名 取数据" },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  }

  const tableId = tables[table];
  if (!tableId) {
    return Response.json(
      { error: `未知表名「${table}」`, tables: Object.keys(tables) },
      { status: 400 }
    );
  }

  try {
    const { rows, partial } = await listAll(tableId, await tenantToken(), only);
    return Response.json(
      { table, count: rows.length, partial, rows },
      {
        // CDN 缓存：重复请求不打函数，省调用次数也快
        headers: { "Cache-Control": "public, max-age=30, s-maxage=120, stale-while-revalidate=600" },
      }
    );
  } catch (e: any) {
    return Response.json({ error: e.message ?? String(e) }, { status: 502 });
  }
};

export const config: Config = { path: "/api/base" };
