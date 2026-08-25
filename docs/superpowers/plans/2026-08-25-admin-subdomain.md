# Admin Subdomain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Roadmap 管理端发布到 `https://admin.telljax.com`，同时保持公开端 `https://telljax.com` 不变。

**Architecture:** 在现有 Cloudflare Pages 项目 `roadmap-ui` 上绑定第二个自定义域名，并以 Cloudflare Redirect Rule 将该子域名根路径 302 到 `/admin/`。管理端继续复用现有静态前端和 Supabase，不新增服务器、数据库或认证系统。

**Tech Stack:** Cloudflare Pages、Cloudflare DNS、Cloudflare Redirect Rules、Next.js 静态导出、Supabase、Git/GitHub CLI

**Spec:** `docs/superpowers/specs/2026-08-25-admin-subdomain-design.md`

## Global Constraints

- 公开端必须保持在 `https://telljax.com`，根路径不得跳转到管理端。
- 管理端必须使用 `https://admin.telljax.com`，根路径跳转目标必须是 `https://admin.telljax.com/admin/`。
- Cloudflare Pages 项目必须复用 `roadmap-ui`，Supabase 项目和管理员凭据不得复制或输出。
- DNS 必须是 Cloudflare 代理的 CNAME：`admin.telljax.com` 指向 `roadmap-ui.pages.dev`。
- GitHub 远端不存在时，创建私有仓库 `lerKunKun/roadmap-ui`；提交信息必须使用中文。
- 合并目标分支必须是 `master`，推送后主工作区必须干净。

---

### Task 1: 绑定 Pages 自定义域名并修正 DNS

**Files:**
- Modify: Cloudflare Pages 项目 `roadmap-ui` 的 Custom domains
- Modify: Cloudflare Zone `telljax.com` 的 `admin.telljax.com` DNS 记录

**Interfaces:**
- Consumes: `.env.deploy.local` 中的 Cloudflare Account ID、Zone ID、API Token 和 Pages Project 名称
- Produces: Pages 自定义域名 `admin.telljax.com` 与唯一的代理 CNAME 记录

- [ ] **Step 1: 读取现有 Pages 域名和精确 DNS 记录**

  使用 Cloudflare API 查询 `roadmap-ui` 项目和 `admin.telljax.com`，只输出记录类型、目标、代理状态和域名状态，不输出 Token。

- [ ] **Step 2: 精确删除冲突的旧 A 记录**

  仅删除查询结果中名称严格等于 `admin.telljax.com` 且类型为 `A` 的记录；删除后立即重新查询，期望 A 记录数量为 0。

- [ ] **Step 3: 绑定 Pages 自定义域名**

  调用 `POST /accounts/{account_id}/pages/projects/roadmap-ui/domains`，请求体为 `{"name":"admin.telljax.com"}`；如果域名已存在，则读取现有状态而不是重复创建。

- [ ] **Step 4: 验证 DNS 和域名状态**

  查询 DNS，期望存在唯一代理 CNAME `admin.telljax.com -> roadmap-ui.pages.dev`；轮询 Pages 域名状态，直到证书与域名状态均为 active，单次等待不超过 60 秒。

### Task 2: 配置管理端根路径重定向

**Files:**
- Modify: Cloudflare Zone `telljax.com` 的 Redirect Rule

**Interfaces:**
- Consumes: 已生效的 `admin.telljax.com` Pages 自定义域名
- Produces: 仅匹配管理子域名根路径的 302 重定向

- [ ] **Step 1: 创建精确匹配规则**

  在 Cloudflare Redirect Rules 中创建规则 `管理端根路径`，表达式为 `(http.host eq "admin.telljax.com" and http.request.uri.path eq "/")`，目标表达式为 `concat("https://admin.telljax.com", "/admin/")`，状态码为 302，并保留查询字符串。

- [ ] **Step 2: 验证规则作用域**

  使用不自动跟随跳转的 HTTP 请求确认管理子域名根路径返回 302 和正确 Location；同时确认 `https://telljax.com/` 返回 200 且无管理端 Location。

### Task 3: 记录生产配置并完成回归

**Files:**
- Modify: `docs/deployment.md`
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-08-25-admin-subdomain-design.md`
- Create: `docs/superpowers/plans/2026-08-25-admin-subdomain.md`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的已验证生产结果
- Produces: 可复现的域名/DNS 文档和可合并的功能分支

- [ ] **Step 1: 更新部署文档**

  在生产状态和 DNS 章节记录用户端 `https://telljax.com`、管理端 `https://admin.telljax.com`、CNAME 目标与根路径跳转行为。

- [ ] **Step 2: 执行完整验证**

  依次运行 `npm run test:run`、`npm run lint`、`npm run typecheck`、`npm run build`；再验证两个生产域名的 HTTPS、重定向、登录页、安全响应头和 Cloudflare active 状态。

- [ ] **Step 3: 使用中文提交**

  运行 `git add README.md docs/deployment.md docs/superpowers/specs/2026-08-25-admin-subdomain-design.md docs/superpowers/plans/2026-08-25-admin-subdomain.md` 和 `git commit -m "文档：记录管理端子域名上线配置"`。

### Task 4: 合并并推送

**Files:**
- Modify: Git 分支 `master`
- Modify: GitHub 私有仓库 `lerKunKun/roadmap-ui`

**Interfaces:**
- Consumes: 已验证且提交完成的 `feat/roadmap-cloud`
- Produces: 已推送的干净 `master`

- [ ] **Step 1: 准备私有远端**

  若 `lerKunKun/roadmap-ui` 已存在则设为 `origin`；否则运行 `gh repo create lerKunKun/roadmap-ui --private --source . --remote origin` 创建私有仓库，不执行首次推送。

- [ ] **Step 2: 合并到 master**

  在主工作树切换到 `master`，运行 `git merge --no-ff feat/roadmap-cloud -m "合并：上线 Roadmap 云端与管理端子域名"`。

- [ ] **Step 3: 验证合并结果**

  在 `master` 上重新运行 `npm run test:run`、`npm run lint`、`npm run typecheck` 和 `npm run build`，全部退出码必须为 0。

- [ ] **Step 4: 推送并清理**

  运行 `git push -u origin master`；确认远端 `master` 指向本地 HEAD 后，安全移除 `.worktrees/roadmap-cloud` 并删除本地 `feat/roadmap-cloud`，最后确认主工作区 `git status --short` 无输出。
