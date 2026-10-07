# @opeoginni/opencode-copilot-auto

Adds GitHub Copilot's **Auto** model to OpenCode V2. Pick `github-copilot/auto` and Copilot chooses which of your available models handles each prompt, the same way Auto works in VS Code.

Requires OpenCode `2.x`. For OpenCode 1, use `0.1.x`.

## Setup

Connect GitHub Copilot in OpenCode (`/connect`), then add the plugin to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@opeoginni/opencode-copilot-auto"]
}
```

Restart OpenCode and select **Auto** under GitHub Copilot in the model picker. It only appears once Copilot is connected.

## How it works

Each request to `auto` is sent to Copilot's routing endpoint, which picks a model from those available on your plan. The plugin then makes the real request with that model over its native protocol (Responses for GPT-5 and newer, Chat Completions otherwise), so tools, images and reasoning behave exactly as they do when you select the model directly.

Routing happens once per user prompt; tool calls within the same turn reuse the choice.

## Auto tiers

Choose an Auto variant to set Copilot's routing preference:

| Variant | Preference |
| ------- | ---------- |
| `efficiency` | Favor cost-efficient models for straightforward tasks. |
| `balance` | Balance cost, quality, and speed for everyday work. |
| `intelligence` | Favor higher-quality models for complex tasks. |

For example: `opencode run --model github-copilot/auto#intelligence "Review this design"`.
Without a variant, routing stays automatic. Set the plugin option `"tier": "intelligence"` for a default preference; a selected variant overrides it. All tiers still adapt to the task and respect your plan and policies. Unavailable tiers report an error rather than silently switching. Changing tiers triggers fresh routing, even with `sticky` enabled.

See [GitHub's Auto tier documentation](https://docs.github.com/en/copilot/concepts/models/auto-model-selection#auto-tier-options).

## Options

```jsonc
{
  "plugins": [
    {
      "package": "@opeoginni/opencode-copilot-auto",
      "options": { "sticky": true, "notifications": true }
    }
  ]
}
```

| Option          | Default | Description                                                                                                                          |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sticky`        | `false` | `false`: Copilot picks a model for every prompt. `true`: keep the first choice for the session; tier changes and tier-token refreshes reroute. |
| `notifications` | `false` | Show a toast naming the model Copilot picked whenever a fresh routing decision is made. Mostly useful while developing. |
| `tier` | unset | Default Auto tier: `efficiency`, `balance`, or `intelligence`. A selected variant takes precedence. |

OpenCode does not record which model answered on the message itself, so the toast is the only place the choice is visible.

## Development

```sh
bun install
bun run check
bun test
bun run build
```

To try the plugin locally without publishing, copy the example config, build, and start an isolated OpenCode in this directory:

```sh
cp opencode.example.jsonc opencode.jsonc
bun run build
opencode --standalone
```

`opencode.jsonc` points at `./dist`, so rebuild after changes. Running with `--standalone` keeps the test server separate from your regular OpenCode service.
