import { forwardFeedback, type BridgeContext } from "../../_workbench"
export const onRequestPost = ({ request, env }: BridgeContext) =>
  forwardFeedback(request, env)
