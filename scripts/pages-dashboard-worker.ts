import { onRequest as media } from "../functions/media/[imageId]"
import {
  consumeSession,
  forwardFeedback,
  ssoCallback,
  ssoStart,
  type BridgeContext,
} from "../functions/_workbench"

type Env = BridgeContext["env"] &
  Parameters<typeof media>[0]["env"] & {
    ASSETS: { fetch(request: Request): Promise<Response> }
  }

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ) {
    const path = new URL(request.url).pathname
    if (path.startsWith("/media/")) {
      const imageId = path.slice("/media/".length)
      if (!imageId || imageId.includes("/"))
        return new Response(null, { status: 404 })
      return media({
        request,
        params: { imageId },
        env,
        waitUntil: (promise) => ctx.waitUntil(promise),
      })
    }
    if (path.startsWith("/workbench/api/")) {
      switch (`${request.method} ${path}`) {
        case "GET /workbench/api/sso/start":
          return ssoStart(request, env)
        case "GET /workbench/api/sso/callback":
          return ssoCallback(request, env)
        case "POST /workbench/api/sso/session":
          return consumeSession(request, env)
        case "POST /workbench/api/feedback":
          return forwardFeedback(request, env)
        default:
          return new Response(null, { status: 404 })
      }
    }
    return env.ASSETS.fetch(request)
  },
}

export default worker
