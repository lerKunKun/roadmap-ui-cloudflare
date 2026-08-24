# Roadmap 产品与技术设计

日期：2026-08-24

## 1. 目标与范围

构建一套无需自建服务器的 Roadmap 应用：用户端公开访问，管理端使用单一强密码登录。每个项目拥有独立 Roadmap 与项目网址，用户可以切换项目、提交建议和投票，管理员可以维护项目及 Roadmap 条目。

首期预置“广告系统”“ks-alert”“模板工具”“其他”四个顶层项目，不增加第二层分类；“其他”的项目网址允许为空。项目后续可以通过管理端 CRUD。

### 用户端

- 无需登录即可访问、切换项目和打开项目网址。
- 按待处理、已批准、进行中、已完成、已拒绝五个固定阶段浏览 Roadmap。
- 查看条目详情、匿名提交建议和投票。
- 新建议固定进入“待处理”。
- 同一公网 IP 对同一条目最多投一票。

### 管理端

- 路径为 `/admin`，未登录时只展示密码框。
- 使用唯一 Supabase 管理员账号，不开放注册、找回密码或普通用户账号。
- CRUD 项目名称、唯一标识、项目网址、排序及 Roadmap 条目。
- 调整条目状态和同状态内排序，查看条目票数与创建时间，安全退出。

### 首期不做

- 普通用户账号、用户中心、评论、附件、通知和订阅。
- 第二层分类、标签、自定义 Roadmap 状态。
- 多管理员、多角色和精细权限配置。
- 账号级防刷、设备指纹，以及代理或换 IP 的高级反作弊。

## 2. 技术架构

基于仓库现有 Next.js 16.2.6、React 19、Tailwind CSS 4 与 shadcn/ui 继续开发。

- 前端：Next.js App Router，静态导出。
- 托管：Cloudflare Pages，绑定用户自有域名并自动提供 HTTPS。
- 数据：Supabase Postgres。
- 管理认证：Supabase Auth 单一管理员账号。
- 权限：Supabase Row Level Security（RLS）。
- 匿名写入：Supabase Edge Functions。
- 部署：Git 触发 Cloudflare Pages 自动构建，不运行自建 Node.js 服务。

用户端和管理端使用同一域名，根路径为用户端，`/admin` 为管理端。Supabase 使用其托管 API 域名，无需购买 Supabase 自定义域名。

## 3. 界面与交互

现有 UI 的 Inter 字体、蓝色主题、圆角和 shadcn/ui 组件是视觉基线，不引入另一套视觉风格。

### 用户端

- 顶部包含产品名称、项目切换器、当前项目网址入口和“提交建议”按钮。
- 主体沿用参考截图的五列看板，每列展示状态名称和条目数量。
- 卡片展示标题、简短说明、票数和详情入口；详情使用侧边面板或弹窗。
- 桌面端横向展示五列；移动端保留可读列宽并横向滑动。
- 空状态说明当前阶段没有条目，不使用虚构内容填充。

建议表单包含项目、标题和详细说明。前后端执行长度校验和空白清理；提交失败时保留内容，成功后新条目出现在“待处理”。

### 管理端

- 登录后进入管理工作台，提供项目切换、项目设置、Roadmap 看板和条目编辑面板。
- 状态调整同时支持拖动和下拉选择，兼顾触屏与键盘操作。
- 删除需要二次确认；项目下存在条目时禁止直接删除，避免误删整套 Roadmap。

## 4. 数据模型

### `projects`

- `id` UUID 主键；`name` 项目名称；`slug` 唯一标识。
- `project_url` 可空；`sort_order` 排序。
- `created_at`、`updated_at` 时间戳。

### `roadmap_items`

- `id` UUID 主键；`project_id` 外键。
- `title` 标题；`description` 纯文本说明。
- `status` 固定为 `pending`、`approved`、`in_progress`、`completed`、`rejected`。
- `sort_order` 同状态内排序；`created_at`、`updated_at` 时间戳。

### `votes`

- `id` UUID 主键；`roadmap_item_id` 外键，条目删除时级联删除。
- `ip_hash` 为来源公网 IP 的 HMAC-SHA-256 结果。
- `created_at` 时间戳。
- 唯一约束为 `(roadmap_item_id, ip_hash)`。

票数由 `votes` 聚合计算，不接受客户端提交的票数。

## 5. 每 IP 一票

浏览器不能提供可信公网 IP，因此投票不得直接写表或接受客户端传入的 IP：

1. 浏览器调用公开 `vote` Edge Function，只提交 `roadmap_item_id`。
2. 函数从 Supabase/Cloudflare 可信网关提供的 `cf-connecting-ip` 请求头读取来源 IP；缺少该头时拒绝投票。
3. 函数规范化 IPv4/IPv6，使用 Supabase Function Secret `VOTE_IP_SALT` 计算 HMAC-SHA-256。
4. 数据库只保存 `ip_hash`，不记录或输出明文 IP。
5. 唯一约束保证并发或重复请求不能产生第二票。
6. 重复投票提示“当前网络已投过票”。

同一公司、家庭或运营商 NAT 下的用户可能共享公网 IP，因此同一条目只能产生一票；换网络、代理或 IPv6 地址变化后仍可能再次投票。这是“每 IP 一票”的固有边界。`VOTE_IP_SALT` 必须长期稳定保存，更换它相当于重置历史防重复规则。

## 6. 认证与授权

- Supabase Auth 中只创建一个管理员账号并关闭公开注册。
- 页面只展示密码框；固定登录标识由应用内部使用，不属于安全凭证。
- 管理密码随机生成，至少 24 位，包含大小写字母、数字和符号。
- 密码只写入 Supabase Auth，不进入 Git、前端代码、构建日志或公开环境变量。
- 匿名访问者可读取项目、条目和安全的票数聚合结果，不能直接修改业务表。
- 建议提交与投票只能经过对应 Edge Function。
- 只有唯一管理员账号的 JWT 可以执行项目和条目写操作。
- 所有权限最终由 RLS 和函数校验，不能依赖前端隐藏按钮。

前端按纯文本渲染说明，不使用未经清洗的 HTML。Cloudflare Pages 配置 CSP、`X-Content-Type-Options` 和 Referrer Policy。Supabase Secret Key、Service Role Key 与投票盐只存在于 Function Secret；前端仅使用 Publishable Key。

## 7. Edge Functions

### `submit-suggestion`

- 允许匿名调用，校验项目、请求结构和字段长度。
- 服务端强制状态为 `pending`，忽略客户端状态字段。
- 以最小权限写入建议。

### `vote`

- 允许匿名调用，读取可信来源 IP 并执行加盐哈希。
- 插入投票、处理唯一约束冲突，返回最新票数和是否重复。

管理 CRUD 由 Supabase 客户端直接执行，通过管理员 JWT 与 RLS 保护。

## 8. 错误处理与安全

- 网络、Supabase 或函数异常时显示可重试提示，不伪造成功状态。
- 无效项目或条目返回未找到，不泄露数据库错误。
- 管理会话过期时回到登录页，并保留尚未提交的表单内容。
- 所有公开表单限制长度并显示字段级错误。
- 函数日志不得输出密码、Service Role Key、明文 IP 或完整投票哈希。
- Edge Function CORS 只允许生产域名和明确的本地开发地址。

## 9. 测试与验收

### 自动化测试

- 组件：项目切换、五列分组、空状态、提交表单、投票状态和管理登录。
- 数据库：匿名只读、管理员 CRUD、非管理员写入被拒绝、项目删除保护。
- Edge Function：IP 规范化、HMAC 稳定性、同 IP 同条目重复投票、同 IP 不同条目、不同 IP 同条目及缺少可信 IP。
- 端到端：匿名提交、票数更新、管理员登录、项目 CRUD、状态调整和退出。

### 验收标准

- 四个初始项目可以切换并展示各自独立 Roadmap。
- 项目网址正确跳转，“其他”允许没有网址。
- 匿名建议只能进入待处理。
- 同一公网 IP 对同一条目的并发或重复投票只产生一条记录。
- 管理员可完成项目和条目 CRUD，匿名访问者无法绕过 UI 写入。
- 桌面与移动端都能完整浏览五个阶段。
- `lint`、类型检查、测试和生产构建全部通过。

## 10. 部署与运维

- Cloudflare Pages 绑定自有域名，生产环境仅使用 HTTPS。
- Pages 配置公开的 Supabase URL、Publishable Key 和固定管理员登录标识。
- Supabase 创建唯一管理员、关闭注册、执行迁移并部署两个 Edge Functions。
- Function Secrets 保存 Service Role Key、`VOTE_IP_SALT` 和允许的生产域名。
- 数据库迁移、RLS 策略和函数代码进入 Git；真实密钥和密码不进入仓库。
- 免费 Supabase 项目可能因低活跃暂停，部署说明包含恢复步骤；若要求持续可用，应升级到不会自动暂停的计划。
