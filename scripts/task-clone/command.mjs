import { spawn } from "node:child_process"

export async function runCaptured(program, args, options = {}) {
  const operation = options.operation ?? program

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", () => {
      reject(new Error(`${operation}失败（无法启动进程）`))
    })
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`${operation}失败（退出码 ${exitCode ?? "未知"}）`))
        return
      }
      resolve({ stdout, stderr, exitCode: 0 })
    })

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    }
  })
}
