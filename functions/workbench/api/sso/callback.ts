import { ssoCallback, type BridgeContext } from "../../../_workbench"
export const onRequestGet = ({ request, env }: BridgeContext) =>
  ssoCallback(request, env)
