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
npm run supabase:test
npm run lint
npm run typecheck
npm run build
```

生成生产管理员强密码：

```powershell
npm run admin-password
```

不要提交 `.env.local`、管理员密码、Supabase Secret/Service Role Key 或 `VOTE_IP_SALT`。

完整的 Supabase、Cloudflare Pages、域名和 DNS 步骤见 [部署手册](docs/deployment.md)。
