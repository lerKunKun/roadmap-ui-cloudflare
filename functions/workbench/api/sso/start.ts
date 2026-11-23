import { ssoStart, type BridgeContext } from "../../../_workbench"
export const onRequestGet = ({ request, env }: BridgeContext) =>
  ssoStart(request, env)
