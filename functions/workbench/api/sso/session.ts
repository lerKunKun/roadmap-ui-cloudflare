import { consumeSession, type BridgeContext } from "../../../_workbench"
export const onRequestPost = ({ request, env }: BridgeContext) =>
  consumeSession(request, env)
