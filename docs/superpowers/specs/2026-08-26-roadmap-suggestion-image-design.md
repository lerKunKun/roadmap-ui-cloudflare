# Roadmap 建议图片上传与 Cloudflare 缓存设计

## 背景

公开端当前只提交项目、标题和详细说明，`submit-suggestion` Edge Function 接收 JSON 后创建待处理条目。用户希望每条建议可选传一张图片，在管理员审核通过后于详情弹窗展示，并由 Cloudflare 缓存公开图片，避免每次查看都消耗 Supabase Storage 流量。

Supabase Free Plan 当前包含 1 GB Storage、5 GB Cached Egress，单文件平台上限为 50 MB。本项目在应用层将图片严格限制为小于 5,000,000 字节，并将可计量的建议图片总量限制在 900,000,000 字节。Cloudflare Pages Function 请求计入 Workers Free 每日 100,000 次额度，因此只有 `/media/*` 进入 Function，现有静态页面继续使用 Pages 免费静态分发。

## 目标

- 每条公开建议可选上传一张图片。
- 仅接受扩展名与实际内容均为 JPEG 或 PNG 的文件：`.jpeg`、`.jpg`、`.png`。
- 文件大小必须严格小于 5,000,000 字节；等于上限也拒绝。
- 图片宽、高各不超过 12,000 像素，总像素不超过 40,000,000。
- 待处理与已拒绝图片不向公众返回；管理员可以审核查看。
- 已批准、进行中、已完成的图片在公开详情弹窗中加载。
- 公开图片通过同域 `/media/{imageId}` 加载，Cloudflare 缓存命中时不访问 Supabase。
- 每个公网 IP 每 24 小时最多提交 3 张图片；纯文字建议继续使用每小时 10 条限制。
- 建议图片累计达到 900,000,000 字节后暂停图片上传，但不影响纯文字建议。
- 删除 Roadmap 条目时同步删除对应 Storage 对象并释放计量容量。
- 视觉严格复用当前线上 UI 的组件、设计令牌与暗色模式，不引入新的视觉体系。

## 非目标

- 不支持一条建议上传多张图片。
- 不支持 GIF、SVG、WebP、视频、PDF 或其他附件。
- 不允许管理端创建、替换或编辑图片；管理端只负责审核查看和随条目删除。
- 不进行图片压缩、裁切、格式转换、EXIF 清除或 Supabase Image Transformation。
- 不为缓存增加 Cloudflare KV、R2、Images 或付费功能。
- 首版不接入第三方内容识别，也不提供图片独立审核结论。
- 首版不调用 Cloudflare 全局 Purge API；已公开图片在状态回退或删除后，旧 URL 最长可能继续命中 24 小时缓存。

## 方案选择

采用“私有 Supabase Storage + 审核可见性视图 + Cloudflare Pages Function 缓存网关”。

私有 Bucket 保证待审核图片不能通过 Storage 公共地址直接访问。公开端只获得已通过审核的图片 ID；Pages Function 先查询边缘缓存，未命中时再通过公开安全视图验证图片是否可公开，并使用仅存在于 Cloudflare 运行时的 Supabase Secret Key 读取私有对象。

不采用以下方案：

- 公共 Bucket + 随机路径：实现简单，但一旦路径泄露就能绕过审核状态直接访问。
- 浏览器直接使用签名 URL：签名参数会拆分缓存键，难以形成稳定的共享边缘缓存。
- Cloudflare R2：可进一步降低源站流量，但会引入第二套存储，与使用现有 Supabase 云项目的目标不一致。

## 数据模型与容量计量

新增私有 Bucket `roadmap-images`：

- `public = false`。
- Bucket 文件大小上限为 5,000,000 字节。
- Bucket MIME 白名单为 `image/jpeg`、`image/png`。
- 对象路径由服务端生成：`suggestions/{itemId}/{imageId}.{jpg|png}`。
- 不保存或复用用户原始文件名，避免路径注入和文件名中的个人信息。

新增 `public.roadmap_item_images`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `uuid` | 图片公开标识，服务端随机生成 |
| `roadmap_item_id` | `uuid unique` | 一对一关联 `roadmap_items(id)`，条目删除时级联删除 |
| `storage_path` | `text unique` | 私有 Bucket 对象路径 |
| `mime_type` | `text` | 仅 `image/jpeg` 或 `image/png` |
| `size_bytes` | `integer` | 大于 0 且严格小于 5,000,000 |
| `width` | `integer` | 大于 0 且不超过 12,000 |
| `height` | `integer` | 大于 0 且不超过 12,000 |
| `created_at` | `timestamptz` | 上传记录创建时间 |

表约束同时要求 `width * height <= 40,000,000`。建立 `roadmap_item_id` 唯一约束和 `storage_path` 唯一约束，数据库本身保证每条建议最多一张图片。

新增单行计量表 `public.roadmap_image_storage_usage`，保存 `used_bytes`，上限固定为 900,000,000：

- 插入图片元数据前，触发器锁定计量行并原子增加 `size_bytes`；超过上限时整次插入失败。
- 删除图片元数据后，触发器原子减去 `size_bytes`，结果不得小于 0。
- 图片元数据在实际对象上传前写入，用于先预留容量；对象上传失败时删除条目，级联删除元数据并释放容量。
- 计量表及修改函数不向浏览器角色开放直接写权限。

新增独立的图片提交事件表 `public.suggestion_image_rate_limits` 和消费 RPC，使用 `suggestion-image:{VOTE_IP_SALT}` 命名空间生成不可逆 IP HMAC：

- RPC 对同一哈希获取事务级 advisory lock，统计当前时刻向前滚动 24 小时内的事件；已有 3 条时拒绝，否则插入一条新事件。
- 图片校验通过后、创建条目前消费额度。
- 上传后续失败不返还额度，避免利用失败请求绕过防刷。
- 超过 48 小时的旧事件随消费操作清理，保留覆盖完整滚动窗口的余量。

## 权限与审核可见性

- `roadmap_item_images` 启用 RLS。
- 匿名用户不能直接读取图片元数据或 `storage.objects`。
- 已登录管理员可以读取图片元数据，并对 `roadmap-images` Bucket 创建短时签名地址和删除对象。
- Edge Function 使用平台注入的管理员客户端上传对象和写入元数据。
- Cloudflare 运行时保存 `SUPABASE_SECRET_KEY`，变量不得以 `NEXT_PUBLIC_` 开头，也不得进入静态构建产物、日志或 Git。

新增安全调用视图 `public.roadmap_item_images_public`，只返回状态为以下值的图片：

- `approved`
- `in_progress`
- `completed`

视图只包含 `id`、`storage_path`、`mime_type` 和 `size_bytes`，用于 Cloudflare Function 在缓存 MISS 时验证公开资格。待处理和已拒绝记录不出现在该视图中。

扩展 `roadmap_items_public`：

- `has_image`：是否存在图片，用于待处理详情显示审核提示。
- `image_id`：只有状态允许公开时返回图片 ID，否则为 `null`。

公开视图仍不返回私有 Storage 路径。

## 建议提交流程

前端 `SuggestionInput` 增加可选 `image: File | null`。新版客户端使用 `multipart/form-data` 调用现有 `submit-suggestion`，不手工设置 multipart 的 `Content-Type` boundary。

Edge Function 同时支持两种请求，保证前后端滚动上线期间不中断：

- `application/json`：沿用纯文字建议解析。
- `multipart/form-data`：读取 `projectId`、`title`、`description` 和可选 `image`。

含图片请求按以下顺序执行：

1. 校验精确 Origin、Publishable Key、项目、文字字段和来源 IP。
2. 消费现有每小时 10 条建议额度。
3. 校验文件非空且严格小于 5,000,000 字节。
4. 校验文件名扩展名与浏览器 MIME 的对应关系。
5. 读取文件头：JPEG 必须以合法 JPEG 标记开始；PNG 必须包含标准 PNG 签名和有效 IHDR。
6. 从 JPEG 段或 PNG IHDR 解析宽高，校验单边与 40MP 上限。
7. 消费每日 3 张图片额度。
8. 创建 `pending` Roadmap 条目。
9. 生成图片 UUID、扩展名和私有对象路径，插入图片元数据并预留容量。
10. 上传 Storage 对象，禁止覆盖同名文件。
11. 返回现有 `{ itemId }` 201 响应。

若图片元数据或 Storage 上传失败，函数删除已经创建的 Roadmap 条目；外键级联删除图片元数据并释放容量。若对象已经写入，则同时尝试删除该对象。失败响应不得包含内部路径、密钥、IP 或数据库错误详情。

纯文字请求不消费图片额度、不检查图片总容量，也不触发 Storage API。

## Cloudflare 图片缓存网关

新增根目录 Pages Function `functions/media/[imageId].ts`，路由为 `/media/{uuid}`。新增 `public/_routes.json`，只包含 `/media/*`，避免其他静态页面触发 Function 计费。

GET 请求处理顺序：

1. 验证路径参数是 UUID，忽略或拒绝非预期查询参数。
2. 使用去除查询参数后的同域 URL 作为 Cache API 键。
3. 调用 `caches.default.match`；命中后直接返回，不访问 Supabase。
4. MISS 时使用 Supabase Publishable Key 查询 `roadmap_item_images_public`。
5. 记录不存在时返回 404 与 `Cache-Control: no-store`。
6. 记录存在时使用 Cloudflare 运行时 `SUPABASE_SECRET_KEY` 读取私有 Storage 对象。
7. 校验上游状态为 200、Content-Type 与元数据一致、Content-Length 未超过应用上限。
8. 将响应写入 Cache API，并向用户返回流式图片响应。

成功响应头：

- `Cache-Control: public, max-age=3600, s-maxage=86400`
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline`
- `X-Roadmap-Cache: HIT` 或 `MISS`

缓存中保存的基础响应不固定写入 HIT/MISS 值；每次返回时克隆响应并添加诊断头。404、405、上游异常、类型不一致和超限响应均使用 `no-store`，不得写入 Cache API。

图片内容不可替换，因此同一图片 ID 在生命周期内内容稳定。条目状态从公开阶段回退、改为拒绝或被删除后，公开列表立即停止返回 `image_id`，已知旧 URL 的 Cloudflare 或浏览器副本最多保留 24 小时；首版接受这一明确边界。

## 管理端查看与删除

管理员打开已有条目的编辑弹窗时，按条目 ID 查询图片元数据：

- 无图片时不渲染图片区。
- 有图片时创建短时签名 URL，直接从 Supabase 加载私有预览；审核访问量低，不进入公开 Cloudflare 缓存。
- 签名或加载失败只影响图片区域，标题、说明和状态仍可编辑，并提供重试。

删除含图片条目时：

1. 读取管理员可见的 Storage 路径。
2. 使用当前管理员会话删除私有对象。
3. Storage 删除成功或确认对象已不存在后，再删除 Roadmap 条目。
4. 条目删除级联删除图片元数据，触发器释放计量容量。
5. Storage 删除失败时保留条目，显示错误并允许重试。

管理员把状态改为待处理或已拒绝时不删除图片，保留审核依据；图片不再由公开视图返回。管理员需要释放空间时删除整个条目。

## 用户界面

视觉以当前线上 UI 为唯一基准。浏览器核对结果为 Inter 字体、白色或浅灰表面、现有蓝色主色、10 px 控件圆角、14 px 弹窗圆角、细边框、轻阴影和现有状态语义色。不得新增字体、调色板、渐变、纹理、重阴影或独立动画体系。

### 建议弹窗

- 保持现有 `Dialog`、`sm:max-w-lg`、标题图标、字段间距和底部提交按钮。
- 新增 `Label`“附加图片（可选）”。
- 选择区使用现有 `rounded-lg`、`border-dashed`、`border-input`、`bg-muted/30` 和 `ImagePlus` Lucide 图标。
- 辅助文字为“仅支持 JPEG、PNG，严格小于 5MB”。
- 选择按钮使用现有 `Button variant="outline"`，不设计新的按钮样式。
- 选中后显示小尺寸等比缩略图、文件名、格式化文件大小和 `ghost` 移除按钮。
- 客户端立即校验扩展名、MIME、大小和图片尺寸；错误使用现有 `role="alert"` 与 destructive token。
- 弹窗设置视口最大高度和内部滚动，桌面与移动端不溢出。
- 提交时按钮显示“正在上传…”，整个表单避免重复提交。
- 成功、移除、替换、关闭或组件卸载时释放 `URL.createObjectURL`。

### 公开详情弹窗

- 保持现有 `sm:max-w-3xl`、顶部标题区、左侧详情、右侧时间轴和底部免责声明。
- 可公开图片位于左侧“详细说明”标题上方，使用 `rounded-lg border bg-muted/30` 容器。
- `<img>` 使用 `loading="lazy"`、等比 `object-contain` 和受限最大高度，不裁切内容。
- 加载时使用现有 `Skeleton`；失败时在同一区域显示提示和 `Button variant="outline"` 的“重新加载”。
- 待处理且 `has_image = true` 时显示“图片正在审核，通过后将在此显示”。
- 已拒绝且 `has_image = true` 时显示“图片未通过审核，不对外显示”。
- 无图片条目不新增空白区域，保持当前详情布局。

### 管理端编辑弹窗

- 复用公开端图片框的边框、圆角、骨架和失败状态。
- 图片区域标注“建议图片”，使用签名 URL 查看原图。
- 不提供上传、替换或单独删除按钮。

### 安全头与暗色模式

- `img-src` 保持同域、`data:`、`blob:`，并增加 `https://*.supabase.co` 供管理员签名预览。
- 公开详情只使用同域 `/media/*`。
- 所有新增组件只使用现有 CSS 变量和 dark variant，不写新的固定品牌色。

## 错误处理

- 客户端校验用于即时反馈，服务端重复执行全部安全校验，不能信任浏览器结果。
- 图片问题只显示图片相关错误；纯文字建议仍可在移除图片后提交。
- 总量达到 900 MB 时提示“图片存储空间已满，可移除图片后继续提交文字建议”。
- 滚动 24 小时图片额度耗尽时提示“当前网络过去 24 小时图片提交次数已达上限”。
- 详情图片加载失败不关闭弹窗、不隐藏说明、不影响投票或时间轴。
- 管理端签名 URL 失败不阻止状态或文字编辑。
- Cloudflare 缺少运行时密钥时返回 503 与 `no-store`，不回退为公开 Bucket。
- 不把 Supabase Secret Key、签名 URL、私有 Storage 路径、IP 或 HMAC 写入客户端日志和响应错误。

## 测试策略

### 数据库 pgTAP

- Bucket 为私有，大小和 MIME 限制正确。
- 图片表一对一约束、尺寸约束、RLS 和权限正确。
- 匿名用户不能读取私有元数据或 Storage 对象。
- 管理员可读取元数据并删除对象。
- 公开图片视图只包含已批准、进行中、已完成条目。
- `roadmap_items_public` 对待处理只返回 `has_image = true` 和 `image_id = null`。
- 并发安全的容量触发器不能超过 900,000,000 字节，删除后正确释放。
- 滚动 24 小时内图片额度第 1 至 3 次成功，第 4 次拒绝；最早事件超过 24 小时后恢复一次额度。

### Edge Function 与验证单元测试

- 旧 JSON 纯文字请求继续成功。
- multipart 纯文字与合法 JPEG、PNG 成功。
- 5,000,000 字节、超限、空文件、错误扩展名、错误 MIME、伪造文件头拒绝。
- JPEG/PNG 宽高解析正确，单边或 40MP 超限拒绝。
- 图片额度和总容量错误返回稳定中文提示。
- 元数据或上传失败时调用清理路径，纯文字请求不调用 Storage。

### Cloudflare Function 测试

- 非 UUID、非 GET、不可公开图片和上游错误不缓存。
- Cache HIT 直接返回且 Supabase 查询和 Storage fetch 调用次数均为 0。
- Cache MISS 验证公开记录、读取私有对象、写入缓存并返回安全响应头。
- 缺少密钥、类型不一致和对象超限返回 `no-store`。
- `_routes.json` 只匹配 `/media/*`。

### 前端组件与端到端测试

- 图片字段只允许单文件并显示现有 UI 风格的预览、大小、移除和错误状态。
- object URL 在替换、移除、成功和卸载时释放。
- 提交使用 FormData 并保留现有标题与说明校验。
- 待处理详情显示审核提示但不请求 `/media/*`。
- 审核通过详情显示图片骨架、成功和重试状态，不破坏投票与时间轴。
- 管理端可以查看待处理签名预览，失败不阻止编辑。
- 桌面、390 px 移动视口和暗色模式不横向溢出。

## 部署与回滚

上线顺序：

1. 应用数据库迁移，创建私有 Bucket、表、视图、计量和限流函数。
2. 部署兼容 JSON 与 multipart 的 `submit-suggestion`。
3. 在 Cloudflare Pages Production/Preview 配置运行时 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`，并把 `SUPABASE_SECRET_KEY` 设置为 Secret。
4. 使用 Wrangler Direct Upload 部署 Pages Function、`_routes.json` 和静态前端。
5. 验证纯文字建议、图片建议、管理员待审核预览、批准后公开图片以及第二次请求的缓存诊断头。
6. 删除生产验收条目与 Storage 对象，确认容量恢复。

前端或 Function 异常时回滚到上一个 Cloudflare Pages 部署。数据库迁移只向前；回滚前端后 Edge Function 继续兼容旧 JSON 请求，新表和私有 Bucket 可以保留，不影响旧客户端。

## 验收标准

1. 每条建议最多一张 `.jpeg`、`.jpg` 或 `.png`，严格小于 5,000,000 字节。
2. 伪造格式、异常尺寸和超限文件在服务端被拒绝。
3. 每 IP 滚动 24 小时图片额度与 900 MB 总容量限制在并发下有效，纯文字建议不受图片容量影响。
4. 待处理与已拒绝图片不出现在匿名数据或公开详情中，管理员可以审核查看。
5. 已批准、进行中、已完成图片在详情弹窗中按现有 UI 风格展示。
6. Cloudflare Cache HIT 不查询 Supabase 数据库，也不读取 Supabase Storage。
7. 只有 `/media/*` 触发 Pages Function，静态页面不计入 Function 请求。
8. 删除含图片条目会删除 Storage 对象并释放计量容量。
9. 旧版 JSON 纯文字提交在滚动上线和回滚期间保持可用。
10. 数据库、单元、组件、E2E、类型、Lint 和生产构建全部通过，两个正式域名完成生产验收。
