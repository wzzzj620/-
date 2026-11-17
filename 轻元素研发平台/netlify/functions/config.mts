import type { Config } from "@netlify/functions";

/** GET /api/config -> { appId }  前端免登要用的 App ID（可公开，secret 绝不能放这里） */
export default async () => {
  const appId = process.env.FEISHU_APP_ID ?? "";
  return Response.json(
    { appId, ok: Boolean(appId) },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
};

export const config: Config = { path: "/api/config" };
