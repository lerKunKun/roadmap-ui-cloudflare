import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join } from "node:path"

const API_URL = "http://127.0.0.1:54321"
const ALLOWED_ORIGIN = "http://localhost:3000"
const require = createRequire(import.meta.url)
const supabaseCommand = process.platform === "win32"
  ? join(
      dirname(require.resolve(`@supabase/cli-windows-${process.arch}/package.json`)),
      "bin",
      "supabase.exe",
    )
  : "npx"
const supabaseArgs = process.platform === "win32" ? [] : ["supabase"]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseStatusEnvironment() {
  const output = execFileSync(supabaseCommand, [...supabaseArgs, "status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=")
        if (separator < 1) return null
        const key = line.slice(0, separator)
        const rawValue = line.slice(separator + 1)
        if (!/^[A-Z_]+$/.test(key)) return null
        return [key, rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue]
      })
      .filter(Boolean),
  )
}

async function waitForRuntime(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Edge Functions 本地运行时启动超时")),
      60_000,
    )
    const inspect = (chunk) => {
      if (String(chunk).includes("Serving functions on")) {
        clearTimeout(timeout)
        resolve()
      }
    }
    child.stdout.on("data", inspect)
    child.stderr.on("data", inspect)
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Edge Functions 本地运行时提前退出：${code}`))
    })
  })
}

async function postFunction(name, body, options = {}) {
  const headers = { "Content-Type": "application/json" }
  if (options.key !== false) headers.apikey = options.publishableKey
  if (options.origin !== false) headers.Origin = options.origin ?? ALLOWED_ORIGIN
  if (options.ip) headers["cf-connecting-ip"] = options.ip

  const response = await fetch(`${API_URL}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload }
}

async function main() {
  const env = parseStatusEnvironment()
  const publishableKey = env.PUBLISHABLE_KEY || env.ANON_KEY
  assert(publishableKey, "未找到本地 Supabase Publishable Key")

  const runtime = spawn(
    supabaseCommand,
    [...supabaseArgs, "functions", "serve", "--env-file", "supabase/.env.local"],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  try {
    await waitForRuntime(runtime)

    const projectResponse = await fetch(
      `${API_URL}/rest/v1/projects?select=id&slug=eq.advertising-system&limit=1`,
      { headers: { apikey: publishableKey } },
    )
    const projects = await projectResponse.json()
    const projectId = projects[0]?.id
    assert(projectId, "未找到数据库初始项目，请先执行 supabase db reset")

    const fixture = { projectId, title: "函数黑盒验收", description: "本地自动化测试" }
    const noKey = await postFunction("submit-suggestion", fixture, {
      key: false,
      origin: ALLOWED_ORIGIN,
      ip: "2001:db8::1",
    })
    assert(noKey.status === 401, `缺少 Publishable Key 应返回 401，实际 ${noKey.status}`)

    const badOrigin = await postFunction("submit-suggestion", fixture, {
      publishableKey,
      origin: "https://not-allowed.example",
      ip: "2001:db8::1",
    })
    assert(badOrigin.status === 403, `非法 Origin 应返回 403，实际 ${badOrigin.status}`)

    const missingIp = await postFunction("submit-suggestion", fixture, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
    })
    assert(missingIp.status === 400, `缺少可信 IP 应返回 400，实际 ${missingIp.status}`)

    const randomSuffix = randomBytes(8).toString("hex")
    const quotaIp = `2001:db8:1::${randomSuffix.slice(0, 4)}`
    const itemIds = []
    for (let index = 1; index <= 11; index += 1) {
      const result = await postFunction(
        "submit-suggestion",
        { ...fixture, title: `函数限流验收 ${randomSuffix}-${index}` },
        { publishableKey, origin: ALLOWED_ORIGIN, ip: quotaIp },
      )
      if (index <= 10) {
        assert(result.status === 201, `第 ${index} 次建议应成功，实际 ${result.status}`)
        itemIds.push(result.payload.itemId)
      } else {
        assert(result.status === 429, `第 11 次建议应限流，实际 ${result.status}`)
      }
    }

    const voteBody = { roadmapItemId: itemIds[0] }
    const firstVote = await postFunction("vote", voteBody, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
      ip: "198.51.100.10",
    })
    const duplicateVote = await postFunction("vote", voteBody, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
      ip: "198.51.100.10",
    })
    const otherIpVote = await postFunction("vote", voteBody, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
      ip: "198.51.100.11",
    })
    const otherItemVote = await postFunction("vote", { roadmapItemId: itemIds[1] }, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
      ip: "198.51.100.10",
    })

    assert(firstVote.status === 200 && firstVote.payload.duplicate === false, "首次投票未成功")
    assert(duplicateVote.payload.duplicate === true && duplicateVote.payload.voteCount === 1, "重复投票未去重")
    assert(otherIpVote.payload.duplicate === false && otherIpVote.payload.voteCount === 2, "不同 IP 投票未计数")
    assert(otherItemVote.payload.duplicate === false && otherItemVote.payload.voteCount === 1, "同 IP 对不同条目未放行")

    const concurrentIp = `2001:db8:2::${randomSuffix.slice(0, 4)}`
    const concurrent = await Promise.all([
      postFunction("vote", { roadmapItemId: itemIds[2] }, { publishableKey, origin: ALLOWED_ORIGIN, ip: concurrentIp }),
      postFunction("vote", { roadmapItemId: itemIds[2] }, { publishableKey, origin: ALLOWED_ORIGIN, ip: concurrentIp }),
    ])
    assert(
      concurrent.filter((result) => result.payload.duplicate === false).length === 1 &&
        concurrent.filter((result) => result.payload.duplicate === true).length === 1,
      "并发重复投票未保持唯一",
    )

    const voteWithoutIp = await postFunction("vote", voteBody, {
      publishableKey,
      origin: ALLOWED_ORIGIN,
    })
    assert(voteWithoutIp.status === 400, `投票缺少可信 IP 应返回 400，实际 ${voteWithoutIp.status}`)

    process.stdout.write("Edge Function HTTP integration: 20 checks passed\n")
  } finally {
    if (runtime.exitCode === null && runtime.signalCode === null) {
      const exited = new Promise((resolve) => runtime.once("exit", resolve))
      runtime.kill()
      await exited
    }
  }
}

await main()
