# 轻元素·研发平台 · Netlify 部署包

一个能跑的最小闭环：**飞书免登识别身份 → 后端读多维表格 → 前端展示**。
只用了 Netlify Functions（无框架、无数据库、无 Redis），11 个文件里的核心就 3 个。

---

## 一、目录结构

```
netlify-研发平台/
├─ netlify.toml               # publish / functions 配置
├─ package.json               # 只声明 @netlify/functions 类型
├─ netlify/functions/
│  ├─ config.mts              # GET  /api/config   返回 appId（可公开）
│  ├─ session.mts             # POST /api/session  免登 code 换用户信息
│  └─ base.mts                # GET  /api/base?table=原料  读多维表格
└─ public/
   ├─ index.html              # 调试页：验证身份 + 逐表取数
   └─ _redirects              # SPA 兜底（注释掉的 /api/* 优先级说明在里面）
```

---

## 二、部署 5 步

1. **推仓库**：把整个 `netlify-研发平台/` 推到 Git（GitHub/GitLab/Gitee 都行）。
2. **建站点**：Netlify → Add new site → Import an existing project → 选仓库。
   Build 留空，Publish directory 填 `public`（`netlify.toml` 里已写好，通常会自动带出）。
3. **配环境变量**（Site configuration → Environment variables → 三个都设为 *Functions* 作用域，不要设成 `VITE_` 前缀）：

| 变量名 | 值 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | `cli_xxxxxxxx` | 应用凭证里复制 |
| `FEISHU_APP_SECRET` | `xxxxxxxx` | **只放这里，永远不进前端** |
| `BASE_APP_TOKEN` | `bascnXXXXXXXX` | 多维表格 URL 里 `/base/` 后面那串 |
| `BASE_TABLES` | 见下方 JSON | 表名 → table_id 映射 |

`BASE_TABLES` 直接粘这段，把 `tbl…` 换成你 14 张表的真实 id：

```json
{
  "产品": "tblXXXX01",
  "原料分类": "tblXXXX02",
  "原料": "tblXXXX03",
  "供应商": "tblXXXX04",
  "供应商版本": "tblXXXX05",
  "配方": "tblXXXX06",
  "配方版本": "tblXXXX07",
  "配方组成": "tblXXXX08",
  "成本附加项": "tblXXXX09",
  "营养成分表": "tblXXXX10",
  "营养标签": "tblXXXX11",
  "研发报告": "tblXXXX12",
  "配方提案": "tblXXXX13",
  "待补充原料需求": "tblXXXX14"
}
```

4. **Deploy**。拿到 `https://xxx.netlify.app`。
5. **回飞书后台填三处**（都要求 https，Netlify 默认给）：
   - 开发配置 → 安全设置 → 重定向 URL：`https://xxx.netlify.app/`
   - 应用功能 → 网页应用 → 桌面端主页 / 移动端主页：`https://xxx.netlify.app/`
   - H5 可信域名：`xxx.netlify.app`（不带协议）
   - 改完**创建版本 → 申请发布 → 管理员审核**，否则不生效。

---

本地自测（可选，装了 Netlify CLI 的话）：

```bash
npm install
npx netlify dev          # 起了 http://localhost:8888，/api/* 走真实函数
```

注意本地是 http，飞书免登那步不会生效（`tt.requestAccess` 需要客户端内 + https 域名），但 `/api/base` 取数可以正常验证。

## 三、验证顺序（不要跳）

```bash
# 1. 站点活着
curl https://xxx.netlify.app/api/config
# → {"appId":"cli_xxx"}

# 2. 表名映射进来了
curl "https://xxx.netlify.app/api/base"
# → {"tables":["产品","原料",...]}

# 3. 真正读一张表
curl "https://xxx.netlify.app/api/base?table=原料"
# → {"table":"原料","count":3,"rows":[{...}]}
```

第 3 步如果返回 `1254302`，是 Base 开了高级权限、应用没进权限组；
返回 `1254003` 是 `BASE_APP_TOKEN` 错；`1254004` 是某个 `table_id` 错。
报错里我把这几种都翻译成中文提示了，直接看 `hint` 字段。

---

## 四、为什么这么写（和你之前那版通用代码的差别）

| 差异 | 原因 |
|---|---|
| token 不进内存长期缓存，每次调用最多换一次 | 函数是临时容器，`let cache` 冷启动就没了；多实例也不共享 |
| 一次只读**一张表**，前端按需请求 | 同步函数约 10 秒超时，14 张表串行必被打断 |
| 分页最多 10 页（5000 条）就收手 | 单表上限 2 万条，全量拉会撞 6MB 响应上限 |
| 响应带 `Cache-Control: s-maxage=120` | 让 Netlify CDN 帮你挡住重复请求，函数调用次数直接降一个量级 |
| 免登只返回姓名/open_id，不把 user_access_token 下发 | 函数无状态，token 塞进前端等于裸奔；当前阶段读表用 tenant 身份 |
| 同域调用，不写 CORS | 页面和函数都在 `xxx.netlify.app`，跨域头是多余的 |

---

## 五、这套部署的真实短板（别忽略）

1. **国内访问与企业防火墙**：飞书官方放行的内网白名单只覆盖 `*.feishu.cn`、`*.feishucdn.com` 这类字节域名，`netlify.app` 需要公司 IT 单独放行，否则同事在办公网点开是白屏。
2. **数据出境**：员工姓名、open_id、成本单价会经过 Netlify 的海外节点。内部自用没问题，但如果公司有合规要求，这一条要提前说清楚。
3. **冷启动延迟**：长时间没人访问，第一个请求要多花 1~2 秒。用 `s-maxage` 缓存能大幅缓解。
4. **函数调用额度**：免费版有月度调用次数限制。按「14 张表 × 每人每天打开 3 次」估算，几十人团队够用，但别在前端做 30 秒轮询。

真要长期全公司用，建议路径是：**先在 Netlify 跑通验证业务口径，同时把自有域名绑上**（飞书后台填自有域名，日后把 DNS 切到国内 OSS/COS + 云函数时，飞书侧一行都不用改）。这一步现在做，成本最低。

---

## 六、后续要接的东西

- 成本汇总写回（`投料合计`、`原料成本`）：加一个 `POST /api/recalc`，用 `batch_update` 一次性写回，不要在 H5 里算。
- 按人看数据：把 `session.mts` 里换到的 `user_access_token` 存进 Netlify Blobs（`@netlify/blobs`，自带、免装 Redis），键用 open_id，读表时改用它，权限就跟着飞书高级权限走。
- 前端接你的原型：把 `public/index.html` 换成你那份 `轻元素研发平台-网页版.html`，只保留 `/api/base` 的取数层。
