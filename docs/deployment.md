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

数据库迁移会创建 `projects`、`roadmap_items`、`votes`、不可变状态历史、建议图片元数据与容量计量，并初始化以下分类：广告系统、ks-alert、模板工具、其他。

### 2.2 建议图片存储与应用限制

迁移创建私有 Storage Bucket `roadmap-images`；`public` 必须保持为 `false`，浏览器不能通过公开 Storage URL 读取对象。应用、数据库约束与媒体代理共同执行以下边界：

- 每条建议最多一张图片，仅接受文件名扩展名与 MIME 同时匹配的 JPEG 或 PNG。
- 图片必须大于 0 字节且严格小于 `5,000,000` 字节；Bucket 的 `file_size_limit` 为 `5,000,000`，应用层仍以严格小于为准。
- 宽、高各为 1–12,000 像素，总像素不超过 40,000,000。
- 同一公网 IP 的不可逆 HMAC 标识在滚动 24 小时内最多消费 3 次图片提交额度；后续上传失败也不返还额度。纯文字建议不消费图片额度，也不调用 Storage。
- `roadmap_image_storage_usage` 按元数据原子预留和释放容量，逻辑上限为 `900,000,000` 字节（十进制 900 MB）。删除含图条目时必须先删除 Storage 对象，再删除条目并由级联触发器恢复用量。

不要把 Bucket 改为公开，也不要绕过 `submit-suggestion` Edge Function 直接写入元数据或对象。

### 2.3 创建管理员

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

### 2.4 部署函数和私密变量

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

内置的 Supabase Secret Key 由平台注入 Edge Functions，不需要为 Edge Functions 手工复制；Cloudflare Pages Function 是独立运行时，仍须按 3.1 节配置其加密 `SUPABASE_SECRET_KEY`。两个 Edge Functions 虽然允许匿名调用，但会校验 Publishable Key 和精确 Origin；投票函数只保存客户端 IP 的加盐 HMAC，不保存明文 IP。匿名建议同样使用独立上下文的 HMAC-IP 做基础防刷，每个公网 IP 每小时最多提交 10 条。

`VOTE_IP_SALT` 必须长期稳定保存在 Function Secrets。更换它会让历史投票无法继续匹配同一 IP，相当于重置防重复基准；建议限流的新时间窗口也会从新哈希重新开始。

## 3. 配置 Cloudflare Pages

### 3.1 创建 Pages 项目

可以将仓库连接 GitHub/GitLab，也可以使用 Wrangler Direct Upload。当前部署采用 Direct Upload，后续需要自动持续部署时再连接 Git 仓库。

建议项目名：`roadmap-ui`。构建配置：

| 配置项                 | 值                           |
| ---------------------- | ---------------------------- |
| Framework preset       | Next.js (Static HTML Export) |
| Production branch      | `master`（合并本功能分支后） |
| Root directory         | 仓库根目录                   |
| Build command          | `npm run build`              |
| Build output directory | `out`                        |
| Node.js                | 22                           |

在 Settings → Environment variables 同时配置 Production 和 Preview：

```text
NEXT_PUBLIC_SUPABASE_URL=https://你的-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_ADMIN_EMAIL=roadmap-admin@internal.invalid
NODE_VERSION=22
```

这些 `NEXT_PUBLIC_*` 值只供静态前端构建；Publishable Key 可以进入浏览器包，权限边界由 RLS 和 Edge Functions 控制。

Pages Function `/media/*` 还要求在 Production 和 Preview 两个环境分别配置以下运行时值：

| 变量                       | Cloudflare 类型 | 用途                                              |
| -------------------------- | --------------- | ------------------------------------------------- |
| `SUPABASE_URL`             | Text            | 服务端查询图片公开元数据与读取 Storage 的项目 URL |
| `SUPABASE_PUBLISHABLE_KEY` | Text            | 服务端查询 `roadmap_item_images_public`           |
| `SUPABASE_SECRET_KEY`      | Secret（加密）  | 服务端读取私有 `roadmap-images` 对象              |

`SUPABASE_SECRET_KEY` 仅允许存在于 Pages Function 的服务端运行时，必须使用 Cloudflare 加密 Secret；绝不能命名为 `NEXT_PUBLIC_SUPABASE_SECRET_KEY`、写入 `NEXT_PUBLIC_*`、提交到 Git、出现在构建日志或浏览器包中。不要在文档、命令历史或聊天中粘贴实际值。

仓库的 `public/_routes.json` 必须保持：

```json
{
  "version": 1,
  "include": ["/media/*"],
  "exclude": []
}
```

这样只有 `/media/*` 消耗 Pages Function 请求；`/`、`/admin/` 和其他静态资源继续由 Pages 静态层直接响应。每次构建后都检查导出的 `out/_routes.json` 与上述内容一致。

### 3.2 域名与 DNS

先让第一次 Pages 部署成功，记下 Cloudflare 分配的准确地址。项目名可用时预计为：

```text
roadmap-ui.pages.dev
```

必须先进入 Pages 项目 → Custom domains → Set up a domain，填写最终域名；不要只在 DNS 中手工创建 CNAME，否则可能返回 522。

建议子域名解析：

| 类型  | 名称      | 目标                   |
| ----- | --------- | ---------------------- |
| CNAME | `roadmap` | `roadmap-ui.pages.dev` |

当前生产域名使用同一个 Pages 项目，DNS 配置如下：

| 用途   | 类型  | 名称                | 目标                   | 代理状态 |
| ------ | ----- | ------------------- | ---------------------- | -------- |
| 用户端 | CNAME | `telljax.com`       | `roadmap-ui.pages.dev` | 已代理   |
| 管理端 | CNAME | `admin.telljax.com` | `roadmap-ui.pages.dev` | 已代理   |

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

### 3.4 图片功能上线顺序

图片功能按以下顺序发布，不能颠倒：

1. **数据库**：先执行 additive migration，确认私有 Bucket、表、视图、RLS、容量触发器和滚动额度 RPC 已存在。
2. **Edge Function**：再部署兼容 JSON 纯文字请求与 multipart 图片请求的 `submit-suggestion`；先做一条经过允许 Origin 的纯文字 smoke，确认旧客户端仍可用。
3. **Cloudflare 运行时**：在 Production 与 Preview 同时配置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` 和加密的 `SUPABASE_SECRET_KEY`，只检查变量是否存在，不打印值。
4. **Pages**：最后构建并部署静态输出与 `/media/*` Function，确认部署产物的 `_routes.json` 只包含 `/media/*`。

在数据库、Edge Function 和 Pages 全部完成前，不进行真实用户图片 smoke；发布期间纯文字 JSON 路径保持兼容。

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

图片功能再执行一组可清理的 smoke，使用生成的小 PNG，不使用客户截图，并记录测试前的图片元数据数量与逻辑用量：

1. 提交含图建议后，公开待处理行只返回 `has_image = true`、`image_id = null`；详情显示审核提示，且不会请求 `/media/*`。猜测对象路径或直接访问 Storage URL 均不能读取私有对象。
2. 管理端通过短时签名 URL 看见待审核预览，并可正常调整状态。
3. 批准后重新查询公开列表获得 `image_id`，公开详情通过 `/media/{imageId}` 显示图片。
4. 第一次媒体响应的 `X-Roadmap-Cache` 为 `MISS`，第二次为 `HIT`；两次都具备约定的缓存与安全响应头。确认 HIT 不新增 Supabase 图片视图查询或 Storage 读取。
5. 通过产品流程删除含图测试条目，确认先删除 Storage 对象，再删除条目，元数据数量与 `roadmap_image_storage_usage.used_bytes` 恢复到测试前值。
6. 另建一条纯文字建议并删除，确认整个流程没有任何 Storage 请求。

Supabase Logs 中可检查函数状态；不要记录或输出原始 IP、密码或 Secret Key。

## 当前生产状态（2026-08-26）

- Supabase migrations：`20260824000000_roadmap.sql`、`20260825090000_roadmap_status_history.sql`、`20260826090000_roadmap_suggestion_images.sql`
- Edge Functions：`submit-suggestion`、`vote`
- Cloudflare Pages：`https://roadmap-ui.pages.dev`
- 用户端：`https://telljax.com`（Cloudflare Pages 状态 active）
- 管理端：`https://admin.telljax.com`（根路径 302 到 `/admin/`，Cloudflare Pages 状态 active）

## 5. 回滚与免费额度注意事项

- 前端异常：Cloudflare Pages → Deployments 选择上一个正常版本并回滚。
- 函数异常：重新部署上一个 Git 提交中的函数目录。
- 图片功能回滚边界：可以安全回滚到上一版 Pages 部署，并重新部署上一版 Edge Function 代码，因为服务端仍支持原有 JSON 纯文字请求；additive 图片数据库迁移保持原位，不随代码回滚，也不要重置或手工删除生产表与 Bucket。
- 数据库迁移：生产迁移只向前执行；确需移除数据结构时先备份，再编写并单独审核显式逆向迁移，不要直接重置生产数据库。
- Supabase Free 项目低活跃约一周可能被自动暂停；收到预警后访问 Dashboard 或让应用产生正常数据库请求。暂停后可在 Dashboard 点击 Resume project，官方当前说明恢复窗口最长为一年。
- 当前 Free Plan 包含两个活跃免费项目及一定的数据库、流量和 Edge Function 调用额度；超额或需要避免休眠时再升级，不需要购买钉钉 API。

## 6. Task Roadmap 独立实例

`Task Roadmap` 与当前 `telljax.com` 使用同一份 `master` 代码，但运行资源完全隔离：

| 项目             | 地址或名称                        |
| ---------------- | --------------------------------- |
| 用户端           | `https://task.telljax.com/`       |
| 管理端           | `https://task.telljax.com/admin/` |
| Cloudflare Pages | `task-roadmap-ui`                 |
| Supabase         | `task-roadmap`                    |

目标实例拥有独立数据库、Auth 用户、私有 `roadmap-images` Bucket、Edge Functions、数据库密码、管理员密码和 `VOTE_IP_SALT`。除下文明确列出的“广告系统”单向严格镜像外，两个实例不共享运行数据。

### 6.1 本机配置

源实例继续读取 `.env.deploy.local`。自动准备目标项目后会原子生成 `.env.task.deploy.local`，其中只保存目标项目运行所需值；Supabase Access Token 与 Cloudflare API Token 继续从源部署文件临时读取，不复制到目标文件。

两个文件都匹配仓库的 `.env*` 忽略规则，不能提交、上传或粘贴到日志。检查过程只输出字段名、数量和布尔结果，不输出密码、Token、Secret Key 或盐值。

### 6.2 一次性复制范围

复制以下快照数据：

- 项目、项目网址、Roadmap 条目及 UUID、状态、排序和时间戳；
- 状态时间轴；
- 建议图片元数据及其引用的私有 Storage 对象；
- 当前公开票数，写入目标条目的 `vote_baseline`。

不复制 `votes`、`suggestion_rate_limits`、`suggestion_image_rate_limits`、任何 IP 哈希、源 Auth 用户、会话、密码、密钥或源 `VOTE_IP_SALT`。目标 `votes` 从空表开始，新投票在历史票数基线上继续累加。

### 6.3 自动化命令与顺序

所有命令在仓库根目录执行：

```powershell
npm run deploy:task:prepare
npm run deploy:task:copy
npm run deploy:task:deploy
npm run deploy:task:smoke -- --base-url https://task-roadmap-ui.pages.dev
npm run deploy:task:domain
npm run deploy:task:smoke -- --base-url https://task.telljax.com
npm run deploy:task:check
```

- `prepare` 创建目标 Supabase、生成独立强凭据、应用全部共享迁移，再通过受 Ref 保护的目标专用 SQL 初始化复制标记并确认私有 Bucket 为空；复制标记不进入共享 migration，因此不会在源项目出现。
- `copy` 使用只读可重复读事务抓取源快照，校验图片 MIME、字节数和 SHA-256，拒绝覆盖目标对象，在目标事务中导入并逐字段对账。数据库事务内标记与本机无密钥回执会共同绑定源/目标 Ref、对象摘要和 Git 提交；成功后不能再次运行，两个实例从此独立变化。
- `deploy` 创建或复用唯一目标管理员，关闭公开注册，设置目标 Edge Secrets，部署两个 Edge Functions，创建 Pages 项目，同时配置 Production/Preview 运行时变量并发布当前提交。
- 第一次 `smoke` 在稳定 `pages.dev` 域名验证公开读取、管理员登录、文字/图片建议、图片审核、缓存 MISS/HIT、同 IP 重复投票和清理。浏览器只能访问目标 Supabase 主机；任何源或第三方 Supabase 主机会立即中止测试。
- `domain` 先检查同名 DNS 与其他 Pages 绑定；有冲突时不修改任何记录。无冲突时添加 Pages Custom Domain 并等待证书为 `active`。
- 第二次 `smoke` 验证最终域名。每次冒烟都使用预先分配的唯一前缀，在 `finally` 中按 Storage 对象优先的顺序清理，精确恢复冒烟前的票数与限流运行态，并再次核对源计数。
- 最后的 `check` 要求复制回执、数据库事务标记、图片对象摘要、管理员、关闭注册配置、最终冒烟回执和当前 Git 提交全部一致；只返回就绪状态与数量，不输出任何凭据。

Edge Functions 的目标 Origin 必须保持：

```text
https://task.telljax.com,https://task-roadmap-ui.pages.dev
```

管理端与用户端共用 `task.telljax.com`，不创建额外管理子域名或重定向规则。

### 6.4 域名与 DNS

域名由 Cloudflare Pages Custom Domain 流程绑定。自动化会先精确查询 `task.telljax.com` 的 DNS 记录；若不存在冲突，Pages 在同一 Cloudflare Zone 中创建所需代理记录。不要提前手工添加指向其他源站的 A、AAAA 或 CNAME。

若必须人工核对，最终逻辑目标应是：

| 类型  | 名称   | 目标                        | 代理   |
| ----- | ------ | --------------------------- | ------ |
| CNAME | `task` | `task-roadmap-ui.pages.dev` | 已代理 |

### 6.5 回滚与恢复

在稳定 `pages.dev` 冒烟通过前不绑定 `task.telljax.com`。若目标 Pages 或 Edge Function 异常，只回滚 `task-roadmap-ui` 的部署；若一次性导入失败，自动化会清理本次目标对象并恢复未开放的目标数据，不操作源项目。

域名开放后发现问题时，先从 `task-roadmap-ui` 移除或暂停 `task.telljax.com`，保留目标 Supabase 供排查。不得删除、重置或迁移源 `telljax.com` 的数据库、Pages 项目或管理员。目标管理员密码仅保存在本机 `.env.task.deploy.local`，最终交付时只输出一次。

### 6.6 广告系统单向自动同步

自动同步固定为 `telljax.com` 对应 Supabase → `task.telljax.com` 对应 Supabase，且仅处理 slug 为 `advertising-system` 的一个项目。Task 的其他项目、条目、时间轴、投票和图片不会被同步触碰；没有反向同步。Task 侧对“广告系统”的本地新增、编辑和投票会在下一次成功同步时被源快照严格覆盖。

目标 Supabase 在每小时第 17 分钟运行一次，Cron 表达式为 `17 * * * *`，正常可见延迟不超过约一小时。首次安装保持停用，必须完成两轮可逆隔离验收后才能启用：

```powershell
npm run sync:advertising:install
npm run sync:advertising:trigger
npm run sync:advertising:acceptance
npm run sync:advertising:status
npm run sync:advertising:enable
```

日常检查和紧急停用：

```powershell
npm run sync:advertising:status
npm run sync:advertising:disable
```

状态中的 `lastSuccessAt`、摘要前缀和数量表示最近一次成功镜像；`busy=true` 表示已有租约中的任务；`lastErrorCode` 非空表示最近一次失败；`cleanupCount` 必须为 0。存在对象清理队列时先保持 Cron 停用，核对 Storage 对象和函数日志，再手动触发一次让清理队列重试。函数采用失败关闭：源快照、图片、身份、租约或目标事务任一环节不通过，都不会报告成功或启用 Cron。

轮换源 Secret Key 时，先在目标 Edge Secrets 更新 `SOURCE_SUPABASE_SECRET_KEY` 并手动触发验证，再撤销旧 Key。轮换专用 Cron Secret 时，先同时更新目标 Edge Secret 和 Vault 中的 `advertising_sync_cron_secret`，手动触发并验收后再恢复 Cron。任何密钥都不能写入仓库、SQL 明文、命令输出或验收回执。

回滚时先执行 `npm run sync:advertising:disable`，确认 Cron inactive，再回滚 `sync-advertising` 函数或相关 RPC；不要删除最后一次成功写入的 Task 广告数据。源项目的导出 RPC 始终只读且仅 `service_role` 可调用。
