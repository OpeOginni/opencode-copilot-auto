import { Rpc } from "@opencode/plugin/rpc"

export const CopilotAuto = Rpc.define({
  id: "copilot-auto",
  methods: {},
  events: {
    /** Emitted when Copilot picks a model for a prompt. Only sent when `notifications` is enabled. */
    routed: {
      schema: {
        type: "object",
        properties: {
          model: { type: "string" },
          sessionID: { type: "string" },
        },
        required: ["model"],
        additionalProperties: false,
      },
    },
  },
})
