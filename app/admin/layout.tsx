import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "管理端 · Roadmap",
  description: "Roadmap 项目与条目管理",
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
