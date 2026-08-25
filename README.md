# Roadmap

面向用户公开、管理员密码登录的多项目 Roadmap。每个项目拥有独立看板，支持匿名建议、按公网 IP 去重投票，以及项目和条目的完整管理。

## 技术架构

- Next.js 16 静态导出，部署到 Cloudflare Pages。
- Supabase Postgres + RLS 存储项目、条目和匿名投票。
- Supabase Auth 提供单一管理员密码登录。
- Supabase Edge Functions 处理匿名建议限流和 IP 去重投票。

## 本地开发

复制 `.env.example` 为 `.env.local`，填入公开的 Supabase URL、Publishable Key 和固定管理员邮箱，然后：

```powershell
npm install
npx supabase start
npm run dev
```

常用检查：

```powershell
npm run test:run
npm run test:e2e
npm run test:functions
npm run supabase:test
npm run lint
npm run typecheck
npm run build
```

`test:functions` 需要本地 Supabase 已启动，并已按部署手册创建
`supabase/.env.local`；它会自动启动和关闭 Edge Functions 本地运行时。

生成生产管理员强密码：

```powershell
npm run admin-password
```

不要提交 `.env.local`、管理员密码、Supabase Secret/Service Role Key 或 `VOTE_IP_SALT`。

完整的 Supabase、Cloudflare Pages、域名和 DNS 步骤见 [部署手册](docs/deployment.md)。

生产上线前只需填写本地私密文件 `.env.deploy.local`，然后运行：

```powershell
npm run deploy:check
```

该文件受 `.gitignore` 保护，校验命令也不会输出任何配置值。

## 生产部署

- Pages：<https://roadmap-ui.pages.dev>
- 自定义域名：<https://telljax.com>
- Supabase migration：`20260824000000_roadmap.sql`
- Edge Functions：`submit-suggestion`、`vote`
