# Task Roadmap 独立实例复制设计

日期：2026-09-01

## 目标

在不影响现有 `telljax.com` Roadmap 的前提下，使用同一代码仓库部署一套运行时、数据和权限完全独立的新实例：

- 用户端：`https://task.telljax.com/`
- 管理端：`https://task.telljax.com/admin/`
- Cloudflare Pages 项目：`task-roadmap-ui`
- Supabase 项目：`task-roadmap`

新实例以当前生产数据的一次性快照为起点。上线后两个实例独立运行，不进行持续同步。

## 架构边界

代码继续由当前仓库的 `master` 分支维护，通过不同部署配置构建两个 Pages 项目。新实例使用独立的 Supabase 数据库、Auth、Storage、Edge Functions、运行时密钥、管理员密码、投票盐值和限流状态。

源实例除新增兼容性的历史票数基线字段外不做数据修改。该字段默认值为 0，因此源实例的公开票数、投票去重和现有行为保持不变。

## 历史票数基线

在 `public.roadmap_items` 增加：

```sql
vote_baseline bigint not null default 0 check (vote_baseline >= 0)
```

`public.roadmap_vote_count(uuid)` 改为返回：

```text
条目的 vote_baseline + 新实例 votes 表中的记录数
```

源实例迁移后所有条目的 `vote_baseline` 为 0。复制时读取源实例每个条目的公开票数，将其写入目标条目的 `vote_baseline`；目标 `votes` 表保持为空。因此新实例保留当前票数，但不携带任何原始或派生的旧 IP 哈希。新实例上线后的用户投票继续写入目标 `votes` 表，并叠加在基线上。

迁移必须增加 pgTAP 覆盖：默认基线为 0、基线与新增票数求和、负数被拒绝、删除条目仍级联删除新投票。

## 数据复制范围

复制：

- `projects`：保留 UUID、名称、slug、项目网址、排序和时间戳。
- `roadmap_items`：保留 UUID、项目关系、标题、说明、状态、排序和时间戳；新增 `vote_baseline` 使用源公开票数。
- `roadmap_status_history`：保留条目关系、状态变化和发生时间；目标可重新生成内部 identity ID。
- `roadmap_item_images`：保留图片 UUID、条目关系、Storage 路径、MIME、字节数、尺寸和创建时间。
- `roadmap-images` 中由图片元数据引用的对象：保留对象路径和内容。

不复制：

- `votes` 中的 IP 哈希及记录。
- `suggestion_rate_limits`。
- `suggestion_image_rate_limits`。
- `auth.users` 或任何会话。
- 源实例的数据库密码、管理员密码、Access Token、Secret Key 或 `VOTE_IP_SALT`。

## 复制流程

### 1. 源实例只读快照

在一个只读、可重复读数据库事务中读取项目、条目、状态历史、公开票数和图片元数据，并记录快照时间。随后只复制该快照引用的 Storage 对象，为每个对象计算 SHA-256，并记录对象数量、总字节数、MIME 和路径。若快照引用的对象在复制前已被源实例删除，本次复制失败并从新的数据库快照重新开始，不猜测或跳过对象。快照只保存在本机 Git 忽略的临时目录，日志不输出记录正文、哈希标识或密钥。

### 2. 创建目标基础设施

在当前 Supabase 组织中创建 `task-roadmap`，区域沿用源项目。为目标项目生成独立数据库强密码、管理员强密码和 64 位十六进制 `VOTE_IP_SALT`，写入 Git 忽略的 `.env.task.deploy.local`。

将仓库全部迁移应用到目标项目，确认 `roadmap-images` Bucket 为私有、单文件限制和 MIME 白名单正确。迁移默认创建的四个项目在导入事务中清除，然后由源快照覆盖。

### 3. 导入关系数据

在一个目标数据库事务中导入项目和 Roadmap 条目，并写入历史票数基线。条目插入触发器可能生成初始时间轴，因此导入事务在插入条目后清除目标自动生成的时间轴，再按源快照重新插入状态历史。内部 identity 序列由目标数据库重新维护。

目标 `votes`、建议限流和图片限流表必须保持为空。

### 4. 复制图片

使用源实例服务端凭据读取私有对象，逐个验证路径、MIME、字节数和 SHA-256 后，使用目标服务端凭据上传到目标私有 Bucket 的相同路径。所有对象上传成功后，再在目标数据库事务中插入图片元数据；容量触发器据此生成 `roadmap_image_storage_usage`。

若对象复制中途失败，只清理本次已上传到目标的新对象，不修改源对象，也不写入目标图片元数据。若元数据事务失败，清理本次目标对象并保留失败报告。

## 管理员与权限

目标 Supabase Auth 关闭公开注册，Site URL 设置为 `https://task.telljax.com`。创建独立管理员：

- Email：`roadmap-admin@internal.invalid`
- Password：新生成的至少 32 位强密码
- Auto Confirm User：开启

管理员邮箱与现有 RLS 规则一致；账号存在于不同 Supabase 项目，因此与源管理员完全隔离。最终只向用户输出一次管理端地址、邮箱和密码，密码同时保存在 `.env.task.deploy.local` 供本机恢复，不提交 Git。

## Edge Functions

将 `submit-suggestion` 和 `vote` 部署到目标 Supabase。目标 Secrets 使用独立 `VOTE_IP_SALT`，并设置：

```text
ALLOWED_ORIGINS=https://task.telljax.com,https://task-roadmap-ui.pages.dev
```

新实例的匿名建议、图片额度和投票去重从空状态开始。源实例的 Edge Function Secrets 不修改。

## Cloudflare Pages 与域名

创建 Pages 项目 `task-roadmap-ui`，使用当前 `master` 的静态导出产物，但在构建时注入目标 Supabase 的公开 URL 和 Publishable Key。

Production 和 Preview 均配置目标项目的：

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- 加密 `SUPABASE_SECRET_KEY`

`/media/*` Function 只访问目标 Supabase，并继续使用 Cloudflare Cache API。完成 Pages 首次部署和运行时配置后，将 `task.telljax.com` 添加为 Custom Domain。DNS 位于同一 Cloudflare 账号时优先由 Pages 自动创建代理记录；若存在冲突记录，停止并在修改前报告准确记录。

管理端使用 `https://task.telljax.com/admin/`，不创建额外管理子域名，也不增加重定向规则。

## 对账与验收

域名开放前必须满足：

1. 源与目标项目数量、项目字段和 UUID 一致。
2. 源与目标条目数量、字段、UUID、状态和排序一致。
3. 源与目标每个条目的公开票数一致，且目标 `votes` 表为空。
4. 状态时间轴的条目关系、状态变化和时间一致。
5. 图片元数据数量、路径、MIME、尺寸、字节数和 UUID 一致。
6. 每个目标图片对象的 SHA-256 与源对象一致。
7. 目标逻辑图片用量等于目标图片元数据字节数总和。
8. 目标 Auth 只有新管理员，公开注册关闭。
9. 数据库 pgTAP、单元测试、相关 E2E、lint、类型检查和生产构建通过。
10. 目标 `pages.dev` 上完成可清理 smoke：公开读取、管理登录、文字建议、图片审核与缓存、同 IP 重复投票、删除测试数据。
11. `task.telljax.com` 返回 200，`/admin/` 可登录，CSP 与媒体缓存响应头正确。

验收脚本生成的建议、投票和图片必须在结束后从目标实例清理，不影响复制数据。

## 发布顺序

1. 提交并推送 `vote_baseline` 迁移和测试。
2. 将兼容迁移应用到源 Supabase，确认源公开票数不变。
3. 创建目标 Supabase，应用全部迁移并创建目标管理员。
4. 执行一次性数据和图片复制，完成对账。
5. 部署目标 Edge Functions 和独立 Secrets。
6. 创建并部署 `task-roadmap-ui`，配置 Production/Preview 运行时变量。
7. 在目标 `pages.dev` 完成 smoke。
8. 添加 `task.telljax.com` Custom Domain 并验证证书、DNS 和产品流程。
9. 输出管理员登录信息，确认 Git 分支干净且与远端同步。

## 回滚

在目标实例验收通过前不绑定生产域名。若 Pages 或 Edge Function 异常，回滚目标部署；若数据复制不一致，删除目标中的导入数据或重建尚未开放的目标项目后重试。任何回滚操作都不得重置、删除或修改源 Supabase 数据。

域名开放后若发现问题，先从目标 Pages 移除或暂停 `task.telljax.com`，保留目标 Supabase 供排查。源 `telljax.com` 始终保持在线且不参与目标回滚。

## 非目标

- 不建立两个实例之间的实时或定时同步。
- 不复制旧投票 IP 哈希、限流哈希或 Auth 用户。
- 不创建第二份长期分叉的应用代码。
- 不修改当前 `telljax.com` 的域名、Pages 项目或管理员入口。
