interface DenoRuntimeGlobal {
  Deno: {
    env: {
      get(name: string): string | undefined
    }
  }
}

export function getRuntimeEnv(name: string): string | undefined {
  return (globalThis as unknown as DenoRuntimeGlobal).Deno.env.get(name)
}
