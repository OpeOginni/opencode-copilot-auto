import { Plugin } from "@opencode/plugin/tui"
import { CopilotAuto } from "./rpc.js"

export default Plugin.define({
  id: "opencode-copilot-auto.tui",
  setup(ctx) {
    const api = ctx.client.rpc(CopilotAuto)
    return api.events.on("routed", (event) => {
      const data = event.data as { model: string; sessionID?: string }
      ctx.ui.toast.show({
        title: "Copilot Auto",
        message: `Answering with ${data.model}`,
        variant: "info",
        sessionID: data.sessionID,
      })
    })
  },
})
