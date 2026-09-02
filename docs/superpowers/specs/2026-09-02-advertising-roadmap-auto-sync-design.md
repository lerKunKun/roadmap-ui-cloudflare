# 广告系统 Roadmap 自动镜像设计

日期：2026-09-02

## 背景

`telljax.com` 与 `task.telljax.com` 继续使用独立的 Supabase 项目、管理员、运行时密钥和域名。现新增一个例外：源实例中 slug 为 `advertising-system` 的项目需要每小时单向镜像到 Task 实例。

本设计仅覆盖“广告系统”项目，取代《Task Roadmap 独立实例复制设计》中“不进行持续同步”这一非目标的对应部分。Task 新增的其他项目仍保持完全独立。

## 目标

- 每小时第 17 分钟从源 Supabase 向 Task Supabase 同步一次。
- Task 的 `advertising-system` 在成功同步后严格反映源项目当前内容。
- 源数据库全程只读，Task 不产生任何反向写入。
- Task 中其他项目及其条目、时间轴、图片、建议和投票不被读取或修改。
- 同步失败时保留 Task 上一次成功版本，并提供可查询的失败状态。
- 复用 Supabase 托管能力，不增加长期运行的服务器或 GitHub Actions 凭据。

## 非目标

- 不进行双向同步。
- 不保证实时同步；正常延迟上限为一小时。
- 不保留 Task“广告系统”中的本地建议、管理修改或投票。
- 不新增同步状态管理页面；状态通过数据库记录和本地命令查询。
- 不同步 Auth 用户、会话、限流记录、IP 哈希或项目级 Secrets。

## 方案选择

采用 Supabase 原生 Cron、`pg_net` 和目标 Edge Function：

1. Task 数据库中的 Cron 每小时调用目标 `sync-advertising` Edge Function。
2. 目标函数使用保存在 Edge Secrets 中的源服务端凭据读取源快照和私有图片。
3. 目标专用数据库 RPC 在事务中严格替换 Task 的“广告系统”关系数据。
4. 同步状态和待清理对象保存在目标专用表中。

不采用 GitHub Actions，因为它需要在 GitHub 长期保存跨项目数据库凭据，定时任务还可能延迟。不采用源库变更 Webhook，因为图片和批量状态变化会产生并发调用、排序争用和复杂的失败补偿。

Supabase 官方支持使用 `pg_cron`、`pg_net` 和 Vault 定时调用 Edge Function：

- <https://supabase.com/docs/guides/functions/schedule-functions>
- <https://supabase.com/docs/guides/cron>

## 同步身份与调度

Cron 表达式为：

```text
17 * * * *
```

目标数据库 Vault 保存：

- `advertising_sync_function_url`
- `advertising_sync_publishable_key`
- `advertising_sync_cron_secret`

目标 Edge Secrets 保存：

- `ADVERTISING_SYNC_CRON_SECRET`
- `SOURCE_SUPABASE_URL`
- `SOURCE_SUPABASE_SECRET_KEY`
- `SOURCE_SUPABASE_PROJECT_REF`
- `TARGET_SUPABASE_PROJECT_REF`

Cron 请求同时发送目标 Publishable Key 和 `x-roadmap-sync-secret`。Edge Function 使用常量时间比较验证专用密钥；失败返回 401，不读取源数据。函数以 `--no-verify-jwt` 部署，但 Publishable Key 不能代替专用同步密钥。

源 Secret Key 永远不写入数据库 Vault、浏览器构建、Pages 环境或日志。它只存在于目标 Edge Secrets 和本机 Git 忽略的部署文件中。

## 源快照契约

共享迁移新增 `public.export_advertising_roadmap_snapshot()`，仅授予 `service_role` 执行权限。函数在单个 PostgreSQL 语句快照中返回：

- 版本和捕获时间。
- 唯一 slug 为 `advertising-system` 的项目完整字段。
- 该项目全部 `roadmap_items` 字段。
- 每个条目的公开累计票数，作为目标 `vote_baseline`。
- 该项目全部状态时间轴，保留业务字段和源顺序。
- 该项目全部图片元数据。

若源项目不存在、存在多个匹配项目、字段不合法、图片元数据不完整或快照超过限制，函数调用失败。失败不得解释为空项目，也不得触发目标删除。

Edge Function 使用 Zod 再次校验快照，并设置以下上限：

- 项目必须恰好 1 个。
- 条目最多 5,000 个。
- 时间轴最多 50,000 条。
- 图片最多 5,000 张。
- 单张图片仍小于 5 MB，MIME 仅允许 JPEG 和 PNG。
- 图片逻辑总量不得超过目标 1 GB 限制。

Edge Function 另外验证 `SOURCE_SUPABASE_URL` 的主机名必须与 `SOURCE_SUPABASE_PROJECT_REF` 一致；源身份不依赖 payload 自报。

## 图片同步

源图片对象使用源 Secret Key 从私有 Bucket 读取。函数逐个验证路径、MIME、字节数，并计算 SHA-256。

目标沿用源 `storage_path`：

1. 目标路径不存在时，使用 `x-upsert: false` 上传并记录为本次新对象。
2. 目标路径已存在时，读取并计算哈希；只有内容完全一致才复用。
3. 同路径内容不同视为数据冲突，整次同步失败，不覆盖现有对象。
4. 任一图片失败时，删除本次已上传但尚未引用的新对象，不执行数据库替换。

成功替换数据库后，旧“广告系统”图片路径写入待清理队列。当前快照仍引用的路径从队列移除；其余路径由函数删除并确认。删除失败保留在队列中，下次同步重试。

## 目标事务

目标专用基础设施新增一个仅 `service_role` 可执行的应用 RPC。该 RPC 只部署到 Task Supabase，并在执行前验证目标复制标记中的 Project Ref。

RPC 接收已校验的快照和图片哈希，在单个事务中：

1. 获取固定 PostgreSQL advisory lock，拒绝并发同步。
2. 确认源 payload 的 slug 恰好为 `advertising-system`。
3. 定位 Task 当前“广告系统”项目并收集其图片路径到待清理队列。
4. 删除该项目的图片元数据、时间轴、投票、条目和项目记录。
5. 按源 UUID 和业务字段重新插入项目、条目、时间轴和图片元数据。
6. 将源公开累计票数写入 `vote_baseline`，目标对应 `votes` 保持为空。
7. 从清理队列移除当前快照仍引用的图片路径。
8. 写入最近成功状态、摘要和数量。

RPC 不允许使用 payload 指定任意 slug，不使用动态表名，也不接受目标 Project Ref 参数。任何校验、约束或写入失败都会回滚全部关系数据。

项目替换前必须确认源项目 UUID 未被 Task 其他项目占用。删除和插入均以“广告系统”项目 ID 范围限定。Task 其他项目不参与全表重排；项目 `sort_order` 可以与独立项目并存，不强制全局连续。

## 严格镜像语义

每次成功同步后：

- Task“广告系统”的项目字段、条目、状态、排序、说明、时间轴、图片内容和公开票数与源快照一致。
- Task 用户在该项目提交的建议会被删除。
- Task 管理员对该项目做出的修改会被覆盖。
- Task 该项目的本地投票记录会被删除，源累计票数成为新的基线。
- Task 其他项目的本地建议、管理修改、图片和投票保持不变。

源库只执行快照 RPC 和 Storage 读取。验收时必须证明源项目数量、条目数量、票数和图片摘要在同步前后没有因同步发生变化。

## 状态与可观测性

目标专用表 `roadmap_advertising_sync_state` 使用 singleton 行保存：

- `last_attempt_at`
- `last_success_at`
- `last_snapshot_digest`
- `last_counts`
- `last_duration_ms`
- `last_error_code`
- `last_error_message`

目标专用表 `roadmap_advertising_sync_object_cleanup` 保存待删除对象路径、入队时间、尝试次数和最近错误。两张表均启用 RLS，并撤销 `anon`、`authenticated` 的全部权限。

函数日志只输出运行 ID、阶段、数量、摘要前缀和错误码，不输出条目正文、图片内容、Secret、管理员信息或完整凭据。

本地新增命令：

```text
npm run sync:advertising:trigger
npm run sync:advertising:status
```

手动触发与 Cron 使用同一端点、密钥和 advisory lock，不提供第二套写入路径。

## 失败处理

- 源 RPC 或网络读取失败：最多重试一次；仍失败则记录错误并保留目标旧数据。
- 快照校验失败：不重试，不复制图片，不修改目标。
- 图片复制失败：清理本次新对象，不执行目标事务。
- 目标事务失败：数据库自动回滚；清理本次新对象。
- 旧对象删除失败：数据库同步仍视为成功，将对象留在重试队列。
- 并发触发：后到请求返回 409，不排队执行第二次同步。
- 源项目为空或缺失：失败关闭，不把目标项目清空。

下一次每小时任务会重新处理同步和清理队列。系统不因一次失败自动缩短调度间隔。

## 部署结构

共享迁移包含源快照 RPC，并应用到源、目标 Supabase。目标专用 SQL 由 Task 部署流程应用，包含：

- 状态表和对象清理队列表。
- 目标应用 RPC。
- `pg_cron`、`pg_net` 和 Vault 配置。
- 名为 `sync-advertising-roadmap-hourly` 的幂等 Cron Job。

新增 `supabase/functions/sync-advertising/index.ts`，只加入 Task Edge Function 部署列表。现有 `submit-suggestion`、`vote`、用户端和管理端行为不变。

部署顺序：

1. 应用源只读快照迁移并验证现有页面无变化。
2. 应用目标专用基础设施。
3. 配置目标 Edge Secrets 和 Vault。
4. 部署 `sync-advertising`。
5. 手动触发一次并完成隔离验收。
6. 创建或更新每小时 Cron Job。

Cron 仅在首次手动同步和完整验收通过后启用。

## 测试

### 单元测试

- 快照 schema、上限和唯一 slug 校验。
- 同步密钥验证和失败响应。
- 图片路径、MIME、大小、哈希和复制补偿。
- 摘要稳定性及敏感字段不进入日志。
- 手动触发与状态命令的目标身份保护。

### 数据库测试

- 源 RPC 只导出“广告系统”。
- 目标 RPC 严格替换项目数据和票数基线。
- Task 其他项目的所有关系数据保持不变。
- 缺失源项目、错误 slug、UUID 冲突和非法 payload 全部回滚。
- 图片清理队列正确入队、保留当前路径并支持确认删除。
- advisory lock 阻止并发执行。
- `anon` 和 `authenticated` 无权读取状态或调用同步 RPC。

### 线上验收

1. 在 Task 创建一个非广告项目哨兵，包含条目、投票和可选图片。
2. 记录源“广告系统”和 Task 哨兵的字段、数量及对象摘要。
3. 手动触发同步。
4. 逐字段核对源与目标“广告系统”，核对图片 SHA-256 和公开票数。
5. 确认 Task 哨兵完全不变。
6. 确认源库计数、摘要和运行态未被同步修改。
7. 在 Task“广告系统”创建本地建议和投票，再次同步并确认它们被严格覆盖。
8. 验证状态表成功、清理队列为空、Cron Job 为 active。
9. 运行单元测试、数据库测试、Edge Function 测试、E2E、lint、类型检查和生产构建。

## 回滚与密钥轮换

出现异常时先停用 `sync-advertising-roadmap-hourly` Cron Job；这不会删除现有数据。随后可回滚 Edge Function 或目标 RPC，并使用最近一次已验证快照手动恢复“广告系统”。Task 其他项目不参与回滚。

轮换源 Secret Key 或同步密钥时，先更新 Edge Secrets 和 Vault，再手动触发一次验证，最后撤销旧密钥。任何密钥不得写入 Git、日志、同步状态表或错误正文。
