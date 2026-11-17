import type { Config } from "@netlify/functions";

/**
 * POST /api/session   body: { "code": "从 tt.requestAccess 拿到的预授权码" }
 * 返回：{ name, open_id, email, department_ids, avatar_url }
 *
 * 注意：这里**不下发** user_access_token。函数是无状态的，token 塞给前端等于裸奔。
 * 当前阶段读表用 tenant 身份（见 base.mts）；等要「按人授权看数据」时，
 * 再用 Netlify Blobs 把 token 存在服务端，键用 open_id。
 */

const FEISHU = "https://open.feishu.cn/open-apis";

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Netlify 环境变量 ${key} 未设置`);
  return v;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ error: "只接受 POST" }, { status: 405 });
  }

  let code = "";
  try {
    const body: any = await req.json();
    code = body?.code ?? "";
  } catch {
    return Response.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  if (!code) return Response.json({ error: "缺少 code" }, { status: 400 });

  try {
    // 1) code 换 user_access_token（v2 接口；code 有效期 3 分钟且只能用一次）
    const tokenRes = await fetch(`${FEISHU}/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: env("FEISHU_APP_ID"),
        client_secret: env("FEISHU_APP_SECRET"),
        code,
      }),
    });
    const tokenJson: any = await tokenRes.json();
    if (tokenJson.code !== 0 || !tokenJson.access_token) {
      return Response.json(
        { error: `换 user_access_token 失败 ${tokenJson.code} ${tokenJson.msg ?? ""}` },
        { status: 502 }
      );
    }

    // 2) 取当前用户身份
    const infoRes = await fetch(`${FEISHU}/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(4000),
    });
    const infoJson: any = await infoRes.json();
    if (infoJson.code !== 0) {
      return Response.json(
        { error: `取用户信息失败 ${infoJson.code} ${infoJson.msg}` },
        { status: 502 }
      );
    }

    const d = infoJson.data ?? {};
    return Response.json(
      {
        name: d.name,
        en_name: d.en_name,
        open_id: d.open_id,
        union_id: d.union_id,
        email: d.enterprise_email ?? d.email,
        employee_no: d.employee_no,
        department_ids: d.department_ids,
        avatar_url: d.avatar_url,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return Response.json({ error: e.message ?? String(e) }, { status: 502 });
  }
};

export const config: Config = { path: "/api/session", method: "POST" };
