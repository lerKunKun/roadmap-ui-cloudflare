# 管理端子域名设计

## 目标

在不复制前端项目、数据库或认证配置的前提下，为现有 Roadmap 增加独立管理入口 `https://admin.telljax.com`。

## 架构

- `telljax.com` 继续作为公开用户端，根路径和现有功能保持不变。
- `admin.telljax.com` 作为同一个 Cloudflare Pages 项目 `roadmap-ui` 的第二个自定义域名。
- `admin.telljax.com/` 通过 Cloudflare 单域名重定向规则返回 302，并以等价的动态目标表达式 `concat("https://admin.telljax.com", "/admin/")` 跳转到 `https://admin.telljax.com/admin/`。
- 管理端继续复用现有 Supabase 项目、管理员账号、RLS 与密码登录，不复制数据或密钥。
- DNS 使用 Cloudflare 代理的 CNAME，目标为 `roadmap-ui.pages.dev`；现有同名旧 A 记录必须在绑定前精确移除。

## 验收标准

1. `https://admin.telljax.com/` 返回 302 并跳转到 `/admin/`。
2. `https://admin.telljax.com/admin/` 返回 200，显示现有管理登录页。
3. `https://telljax.com/` 仍返回 200，且不会被重定向到管理端。
4. 两个域名均使用有效 HTTPS，Cloudflare Pages 自定义域名状态为 active。
5. 管理员能够通过现有强密码登录，公开用户无法获得管理权限。
6. 仓库文档记录公开端、管理端和 DNS 配置；提交信息使用中文。
7. 功能分支合并到 `master`，推送到私有 GitHub 远端，合并后工作区保持干净。
