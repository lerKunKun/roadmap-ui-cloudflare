# Roadmap 全云部署手册

本项目使用 Cloudflare Pages 托管静态前端，Supabase 提供数据库、管理员登录和两个 Edge Functions。无需购买或维护服务器。

## 1. 上线前需要准备

- Supabase 项目的 `Project Ref`、`Project URL`、`Publishable Key`。
- 最终域名，建议使用 `roadmap.你的域名`。
- Supabase 与 Cloudflare 的部署权限。

以下值不能提交到 Git，也不要粘贴到公开聊天：Supabase Access Token、数据库密码、Secret/Service Role Key、管理员密码、`VOTE_IP_SALT`。

所有必填项已经集中在项目根目录的 `.env.deploy.local`。填写后运行：

```powershell
npm run deploy:check
```

只有看到“16 项检查通过”才进入部署。文件受 Git 忽略保护，检查结果只显示字段名，绝不会显示密码、Token 或密钥。Cloudflare 将使用 Pages Direct Upload，因此不强制要求 GitHub/GitLab 仓库。

## 2. 配置 Supabase

### 2.1 连接项目并应用数据库

在 Supabase Dashboard 的 Project Settings 中复制 Project Ref、Project URL 与 Publishable Key。然后在项目根目录执行：

```powershell
npx supabase login
$env:SUPABASE_PROJECT_REF = "你的-project-ref"
npx supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx supabase db push
```

数据库迁移会创建 `projects`、`roadmap_items`、`votes`、不可变状态历史及自动记录触发器，并初始化以下分类：广告系统、ks-alert、模板工具、其他。

### 2.2 创建管理员

先生成随机强密码：

```powershell
npm run admin-password
```

生成器只向终端输出一次，不会保存文件。立即放入密码管理器，然后在 Supabase Dashboard → Authentication → Users 中手动创建：

- Email：`roadmap-admin@internal.invalid`
- Password：刚生成的密码
- Auto Confirm User：开启

Authentication 设置要求：

- 保持 Email/Password Provider 开启，否则现有管理员也无法登录。
- 关闭面向公众的 “Allow new users to sign up”。
- Site URL 设置为最终生产地址，例如 `https://roadmap.example.com`。

管理员邮箱同时写入数据库 RLS 规则；如需修改邮箱，必须同步新增迁移，不能只改 Cloudflare 环境变量。

### 2.3 部署函数和私密变量

先准备允许调用匿名 Edge Functions 的公开端 Origin，不带末尾斜杠；多个来源使用英文逗号分隔。`VOTE_IP_SALT` 应是独立随机值，不能与管理员密码相同：

```powershell
$env:ROADMAP_ALLOWED_ORIGINS = "https://telljax.com,https://roadmap-ui.pages.dev"
$voteSalt = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx supabase secrets set "VOTE_IP_SALT=$voteSalt" "ALLOWED_ORIGINS=$env:ROADMAP_ALLOWED_ORIGINS"
Remove-Variable voteSalt

npx supabase functions deploy submit-suggestion --use-api --import-map supabase/functions/deno.json --no-verify-jwt --yes
npx supabase functions deploy vote --use-api --import-map supabase/functions/deno.json --no-verify-jwt --yes
```

`--import-map` 必须显式传入，否则服务端打包不会解析项目级 `deno.json` 中的 npm 导入别名。

内置的 Supabase Secret Key 由平台注入 Edge Functions，不需要复制到本地或 Cloudflare。两个函数虽然允许匿名调用，但会校验 Publishable Key 和精确 Origin；投票函数只保存客户端 IP 的加盐 HMAC，不保存明文 IP。匿名建议同样使用独立上下文的 HMAC-IP 做基础防刷，每个公网 IP 每小时最多提交 10 条。

`VOTE_IP_SALT` 必须长期稳定保存在 Function Secrets。更换它会让历史投票无法继续匹配同一 IP，相当于重置防重复基准；建议限流的新时间窗口也会从新哈希重新开始。

## 3. 配置 Cloudflare Pages

### 3.1 创建 Pages 项目

可以将仓库连接 GitHub/GitLab，也可以使用 Wrangler Direct Upload。当前部署采用 Direct Upload，后续需要自动持续部署时再连接 Git 仓库。

建议项目名：`roadmap-ui`。构建配置：

| 配置项 | 值 |
| --- | --- |
| Framework preset | Next.js (Static HTML Export) |
| Production branch | `master`（合并本功能分支后） |
| Root directory | 仓库根目录 |
| Build command | `npm run build` |
| Build output directory | `out` |
| Node.js | 22 |

在 Settings → Environment variables 同时配置 Production 和 Preview：

```text
NEXT_PUBLIC_SUPABASE_URL=https://你的-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_ADMIN_EMAIL=roadmap-admin@internal.invalid
NODE_VERSION=22
```

Publishable Key 可以放在浏览器环境；权限边界由 RLS 和 Edge Functions 控制。不要把 Secret Key 或 Service Role Key 放进 Cloudflare Pages。

### 3.2 域名与 DNS

先让第一次 Pages 部署成功，记下 Cloudflare 分配的准确地址。项目名可用时预计为：

```text
roadmap-ui.pages.dev
```

必须先进入 Pages 项目 → Custom domains → Set up a domain，填写最终域名；不要只在 DNS 中手工创建 CNAME，否则可能返回 522。

建议子域名解析：

| 类型 | 名称 | 目标 |
| --- | --- | --- |
| CNAME | `roadmap` | `roadmap-ui.pages.dev` |

当前生产域名使用同一个 Pages 项目，DNS 配置如下：

| 用途 | 类型 | 名称 | 目标 | 代理状态 |
| --- | --- | --- | --- | --- |
| 用户端 | CNAME | `telljax.com` | `roadmap-ui.pages.dev` | 已代理 |
| 管理端 | CNAME | `admin.telljax.com` | `roadmap-ui.pages.dev` | 已代理 |

- 如果域名的 DNS 已托管在同一个 Cloudflare 账号，确认 Custom domain 后 Cloudflare 会自动创建记录，无需再手工添加。
- 如果 DNS 在其他服务商，添加上表 CNAME；目标必须替换为 Pages 实际分配的 `*.pages.dev` 地址。
- 如果使用根域名而非子域名，需要先把整个域名 Zone/Nameserver 接入 Cloudflare。
- 若已有严格 CAA 记录，需确认允许 Cloudflare 支持的 CA 签发证书。

域名确认后分别核对 Supabase 配置：

- Edge Functions 的 `ALLOWED_ORIGINS` 保持为公开用户端来源 `https://telljax.com,https://roadmap-ui.pages.dev`，供匿名建议和投票使用。
- Authentication Site URL 保持为 `https://telljax.com`。
- 不把 `https://admin.telljax.com` 加入 `ALLOWED_ORIGINS`：管理端使用 Supabase Auth 与受 RLS 保护的数据接口，不调用匿名 Edge Functions。

### 3.3 管理端独立入口

将 `admin.telljax.com` 添加为 `roadmap-ui` 的第二个 Custom domain。为避免管理子域名根路径仍显示用户端，在 Cloudflare → Rules → Redirect Rules 中创建并启用规则“管理端根路径”：

```text
匹配条件：(http.host eq "admin.telljax.com" and http.request.uri.path eq "/")
目标表达式：concat("https://admin.telljax.com", "/admin/")
状态码：302
保留查询字符串：开启
```

该规则只处理 `admin.telljax.com/`，不会改变 `telljax.com/` 或 `admin.telljax.com/admin/`。管理端仍复用同一份静态前端、Supabase 项目和管理员账号。

## 4. 上线验收

逐项检查：

1. `/` 能看到四个初始项目和五个阶段。
2. 切换项目后只显示该项目的 Roadmap。
3. 在管理端为“广告系统”“ks-alert”“模板工具”填写真实项目网址；匿名建议进入“待处理”，同一网络第 11 次小时内提交会被拒绝。
4. 同一公网 IP 对同一条目第一次投票成功，第二次提示已经投过，票数不增加。
5. `/admin/` 只显示密码输入框；错误密码不能登录。
6. 管理员可新增/编辑/删除项目和条目、调整状态、退出登录。
7. 匿名用户直接对 `projects` 或 `roadmap_items` 发起写请求会被 RLS 拒绝。
8. 响应包含 CSP、`nosniff`、禁止嵌入、Referrer 与 Permissions Policy 安全头。
9. 手机宽度下页面不整体横向溢出，看板内部可横向滚动。
10. “查看详情”使用居中弹窗；状态时间轴精确到日，每次打开都会刷新，管理端变更状态后会自动新增历史记录。

Supabase Logs 中可检查函数状态；不要记录或输出原始 IP、密码或 Secret Key。

## 当前生产状态（2026-08-25）

- Supabase migrations：`20260824000000_roadmap.sql`、`20260825090000_roadmap_status_history.sql`
- Edge Functions：`submit-suggestion`、`vote`
- Cloudflare Pages：`https://roadmap-ui.pages.dev`
- 用户端：`https://telljax.com`（Cloudflare Pages 状态 active）
- 管理端：`https://admin.telljax.com`（根路径 302 到 `/admin/`，Cloudflare Pages 状态 active）

## 5. 回滚与免费额度注意事项

- 前端异常：Cloudflare Pages → Deployments 选择上一个正常版本并回滚。
- 函数异常：重新部署上一个 Git 提交中的函数目录。
- 数据库迁移：生产迁移只向前执行；需要回退时先备份，再编写显式逆向迁移，不要直接重置生产数据库。
- Supabase Free 项目低活跃约一周可能被自动暂停；收到预警后访问 Dashboard 或让应用产生正常数据库请求。暂停后可在 Dashboard 点击 Resume project，官方当前说明恢复窗口最长为一年。
- 当前 Free Plan 包含两个活跃免费项目及一定的数据库、流量和 Edge Function 调用额度；超额或需要避免休眠时再升级，不需要购买钉钉 API。
