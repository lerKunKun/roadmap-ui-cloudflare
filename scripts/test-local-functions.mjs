import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"

const LOCAL_API_URL = "http://127.0.0.1:54321"
const ALLOWED_ORIGIN =
  process.env.SUPABASE_FUNCTIONS_TEST_ORIGIN ?? "http://localhost:3000"
const explicitTestBaseUrl =
  process.env.SUPABASE_FUNCTIONS_TEST_BASE_URL?.replace(/\/+$/, "")
const functionsBaseUrl = explicitTestBaseUrl ?? `${LOCAL_API_URL}/functions/v1`
const require = createRequire(import.meta.url)
const supabaseCommand =
  process.platform === "win32"
    ? join(
        dirname(
          require.resolve(`@supabase/cli-windows-${process.arch}/package.json`)
        ),
        "bin",
        "supabase.exe"
      )
    : "npx"
const supabaseArgs = process.platform === "win32" ? [] : ["supabase"]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseStatusEnvironment() {
  const output = execFileSync(
    supabaseCommand,
    [...supabaseArgs, "status", "-o", "env"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }
  )
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
      .filter(Boolean)
  )
}

async function postFunction(name, body, options = {}) {
  const headers = { "Content-Type": "application/json" }
  if (options.key !== false) headers.apikey = options.publishableKey
  if (options.origin !== false)
    headers.Origin = options.origin ?? ALLOWED_ORIGIN
  if (options.ip) headers["cf-connecting-ip"] = options.ip

  const response = await fetch(`${functionsBaseUrl}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload }
}

async function postMultipartSuggestion(body, options = {}) {
  const headers = {}
  if (options.key !== false) headers.apikey = options.publishableKey
  if (options.origin !== false)
    headers.Origin = options.origin ?? ALLOWED_ORIGIN
  if (options.ip) headers["cf-connecting-ip"] = options.ip

  const formData = new FormData()
  formData.set("projectId", body.projectId)
  formData.set("title", body.title)
  formData.set("description", body.description)
  if (body.image) formData.set("image", body.image)

  const response = await fetch(`${functionsBaseUrl}/submit-suggestion`, {
    method: "POST",
    headers,
    body: formData,
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload }
}

function validPngFile(width, height) {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 2, 0, 0, 0], 24)
  return new File([bytes], "generated-proof.png", { type: "image/png" })
}

async function runChecks() {
  let publishableKey
  let projectId

  if (explicitTestBaseUrl) {
    publishableKey = process.env.SUPABASE_FUNCTIONS_TEST_PUBLISHABLE_KEY
    projectId = process.env.SUPABASE_FUNCTIONS_TEST_PROJECT_ID
    assert(
      publishableKey,
      "显式测试地址需要 SUPABASE_FUNCTIONS_TEST_PUBLISHABLE_KEY"
    )
    assert(projectId, "显式测试地址需要 SUPABASE_FUNCTIONS_TEST_PROJECT_ID")
  } else {
    const env = parseStatusEnvironment()
    publishableKey = env.PUBLISHABLE_KEY || env.ANON_KEY
    assert(publishableKey, "未找到本地 Supabase Publishable Key")

    const projectResponse = await fetch(
      `${LOCAL_API_URL}/rest/v1/projects?select=id&slug=eq.advertising-system&limit=1`,
      { headers: { apikey: publishableKey } }
    )
    const projects = await projectResponse.json()
    projectId = projects[0]?.id
    assert(projectId, "未找到数据库初始项目，请先执行 supabase db reset")
  }

  const fixture = {
    projectId,
    title: "函数黑盒验收",
    description: "本地自动化测试",
  }
  const noKey = await postFunction("submit-suggestion", fixture, {
    key: false,
    origin: ALLOWED_ORIGIN,
    ip: "2001:db8::1",
  })
  assert(
    noKey.status === 401,
    `缺少 Publishable Key 应返回 401，实际 ${noKey.status}`
  )

  const badOrigin = await postFunction("submit-suggestion", fixture, {
    publishableKey,
    origin: "https://not-allowed.example",
    ip: "2001:db8::1",
  })
  assert(
    badOrigin.status === 403,
    `非法 Origin 应返回 403，实际 ${badOrigin.status}`
  )

  const missingIp = await postFunction("submit-suggestion", fixture, {
    publishableKey,
    origin: ALLOWED_ORIGIN,
  })
  assert(
    missingIp.status === 400,
    `缺少可信 IP 应返回 400，实际 ${missingIp.status}`
  )

  const randomSuffix = randomBytes(8).toString("hex")
  const quotaIp = `2001:db8:1::${randomSuffix.slice(0, 4)}`
  const itemIds = []
  for (let index = 1; index <= 11; index += 1) {
    const result = await postFunction(
      "submit-suggestion",
      { ...fixture, title: `函数限流验收 ${randomSuffix}-${index}` },
      { publishableKey, origin: ALLOWED_ORIGIN, ip: quotaIp }
    )
    if (index <= 10) {
      assert(
        result.status === 201,
        `第 ${index} 次建议应成功，实际 ${result.status}`
      )
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
  const otherItemVote = await postFunction(
    "vote",
    { roadmapItemId: itemIds[1] },
    {
      publishableKey,
      origin: ALLOWED_ORIGIN,
      ip: "198.51.100.10",
    }
  )

  assert(
    firstVote.status === 200 && firstVote.payload.duplicate === false,
    "首次投票未成功"
  )
  assert(
    duplicateVote.payload.duplicate === true &&
      duplicateVote.payload.voteCount === 1,
    "重复投票未去重"
  )
  assert(
    otherIpVote.payload.duplicate === false &&
      otherIpVote.payload.voteCount === 2,
    "不同 IP 投票未计数"
  )
  assert(
    otherItemVote.payload.duplicate === false &&
      otherItemVote.payload.voteCount === 1,
    "同 IP 对不同条目未放行"
  )

  const concurrentIp = `2001:db8:2::${randomSuffix.slice(0, 4)}`
  const concurrent = await Promise.all([
    postFunction(
      "vote",
      { roadmapItemId: itemIds[2] },
      { publishableKey, origin: ALLOWED_ORIGIN, ip: concurrentIp }
    ),
    postFunction(
      "vote",
      { roadmapItemId: itemIds[2] },
      { publishableKey, origin: ALLOWED_ORIGIN, ip: concurrentIp }
    ),
  ])
  assert(
    concurrent.filter((result) => result.payload.duplicate === false).length ===
      1 &&
      concurrent.filter((result) => result.payload.duplicate === true)
        .length === 1,
    "并发重复投票未保持唯一"
  )

  const voteWithoutIp = await postFunction("vote", voteBody, {
    publishableKey,
    origin: ALLOWED_ORIGIN,
  })
  assert(
    voteWithoutIp.status === 400,
    `投票缺少可信 IP 应返回 400，实际 ${voteWithoutIp.status}`
  )

  const syncWithoutSecret = await postFunction(
    "sync-advertising",
    {},
    {
      publishableKey,
      origin: false,
    }
  )
  assert(
    syncWithoutSecret.status === 401,
    `同步缺少专用密钥应返回 401，实际 ${syncWithoutSecret.status}`
  )
  const syncGetResponse = await fetch(`${functionsBaseUrl}/sync-advertising`, {
    method: "GET",
    headers: { apikey: publishableKey },
  })
  assert(
    syncGetResponse.status === 405,
    `同步 GET 应返回 405，实际 ${syncGetResponse.status}`
  )

  let imageChecks = 0
  if (process.env.SUPABASE_FUNCTIONS_TEST_IMAGES === "1") {
    const validImage = await postMultipartSuggestion(
      {
        ...fixture,
        title: `函数图片验收 ${randomSuffix}`,
        image: validPngFile(2, 2),
      },
      {
        publishableKey,
        origin: ALLOWED_ORIGIN,
        ip: `2001:db8:3::${randomSuffix.slice(0, 4)}`,
      }
    )
    assert(
      validImage.status === 201,
      `合法 PNG 应成功，实际 ${validImage.status}`
    )

    const exactSizeImage = await postMultipartSuggestion(
      {
        ...fixture,
        title: `函数图片边界验收 ${randomSuffix}`,
        image: new File([new Uint8Array(5_000_000)], "exact.png", {
          type: "image/png",
        }),
      },
      {
        publishableKey,
        origin: ALLOWED_ORIGIN,
        ip: `2001:db8:4::${randomSuffix.slice(0, 4)}`,
      }
    )
    assert(
      exactSizeImage.status === 400 &&
        exactSizeImage.payload?.message === "图片必须严格小于 5MB",
      `5,000,000 字节图片应被拒绝，实际 ${exactSizeImage.status}`
    )
    imageChecks = 2
  }

  return 22 + imageChecks
}

async function main() {
  let checks
  try {
    checks = await runChecks()
  } finally {
    if (!explicitTestBaseUrl) {
      execFileSync(
        supabaseCommand,
        [...supabaseArgs, "db", "reset", "--local"],
        { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] }
      )
    }
  }
  process.stdout.write(
    `Edge Function HTTP integration: ${checks} checks passed\n`
  )
}

await main()
