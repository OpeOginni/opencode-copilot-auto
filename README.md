# @opeoginni/opencode-copilot-auto

Adds GitHub Copilot's **Auto** model to OpenCode V1. Pick `github-copilot/auto` and Copilot chooses which of your available models handles each prompt, the same way Auto works in VS Code.

This is the **V1 support branch**, targeting OpenCode `1.18.32` and newer `1.x` releases. V2 development stays on [`main`](https://github.com/OpeOginni/opencode-copilot-auto/tree/main). V1 releases use `0.2.x` and the npm `v1` tag; do not install the unqualified package on V1.

## Setup

Connect GitHub Copilot in OpenCode (`/connect`), then add the plugin to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opeoginni/opencode-copilot-auto@v1"]
}
```

Restart OpenCode and select **Auto** under GitHub Copilot in the model picker. Copilot authentication remains managed by OpenCode; the plugin does not replace its auth provider.

## How it works

Auto uses the same routing policy as V2: plain Auto uses Copilot's session/intent endpoints; explicit tiers use `/auto` with a matching model/session-token pair. Native AI SDK implementations handle Chat Completions and Responses, including tools, images, usage, and streaming. Copilot's advertised endpoint takes priority; otherwise GPT-5 (except GPT-5-mini) and MAI use Responses, and other models use Chat Completions. Anthropic-only Messages endpoints fall back to Copilot's chat compatibility endpoint, as in V2.

Only Auto uses the plugin's SDK module. **`globalThis.fetch` is never replaced**, so Quota, authentication plugins, and unrelated requests remain untouched ([issue #4](https://github.com/OpeOginni/opencode-copilot-auto/issues/4)).

Routing happens once per user prompt; tool calls within the same turn reuse the choice.

## Auto tiers

Choose an Auto variant to set Copilot's routing preference:

| Variant | Preference |
| ------- | ---------- |
| `efficiency` | Favor cost-efficient models for straightforward tasks. |
| `balance` | Balance cost, quality, and speed for everyday work. |
| `intelligence` | Favor higher-quality models for complex tasks. |

For example: `opencode run --model github-copilot/auto --variant intelligence "Review this design"`. In the TUI, use the variant cycle key (`ctrl+t` by default).
Without a variant, routing stays automatic. Set the plugin option `"tier": "intelligence"` for a default preference; a selected variant overrides it. All tiers still adapt to the task and respect your plan and policies. Unavailable tiers report an error rather than silently switching. Changing tiers triggers fresh routing, even with `sticky` enabled.

See [GitHub's Auto tier documentation](https://docs.github.com/en/copilot/concepts/models/auto-model-selection#auto-tier-options).

## Options

```jsonc
{
  "plugin": [
    ["@opeoginni/opencode-copilot-auto@v1", { "sticky": true, "notifications": true }]
  ]
}
```

| Option          | Default | Description                                                                                                                          |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sticky`        | `false` | `false`: Copilot picks a model for every prompt. `true`: keep the first choice for the session; tier changes and tier-token refreshes reroute. |
| `notifications` | `false` | Show a toast naming the model Copilot picked whenever a fresh routing decision is made. Mostly useful while developing. |
| `tier` | unset | Default Auto tier: `efficiency`, `balance`, or `intelligence`. A selected variant takes precedence. |

OpenCode does not record which model answered on the message itself, so the toast is the only place the choice is visible.

### Migrating from 0.1.x

The global fetch adapter, hand-written protocol/SSE converters, projection bus, and `/copilot-refresh`, `/copilot-autorefresh`, `/copilot-notify` commands have been removed. Routing is per prompt by default, with tool continuations reusing the choice; use `sticky: true` to retain a choice across a session. Notifications are off by default. No model-banner text is injected into the assistant's output.

## Development

```sh
bun install
bun run check
bun test
bun run build
```

To try the plugin locally without publishing, build and start OpenCode V1 with the example config:

```sh
bun run build
OPENCODE_CONFIG="$PWD/opencode.example.jsonc" opencode
```

The example points at `./dist/index.js`; rebuild after changes and run it with a V1 binary. `OPENCODE_CONFIG` does not disable your global config; use an isolated environment if you need to test without other plugins.

An optional end-to-end test checks the built package with a real V1 binary, fake credentials, a local Copilot server, and quota-style accounting in both plugin orders:

```sh
bun run build
OPENCODE_V1_BINARY=/path/to/opencode-v1 bun test test/v1.integration.test.ts
```

The build bundles the same native Copilot SDK used by V2, not the OpenCode host. `@opencode/core` is a build-only dependency; V1 users do not install a V2 host or plugin runtime.

Before publishing a V1 release, run `bun run publish:dry-run`. `bun run release` publishes under the `v1` tag, leaving the V2 `latest` tag unchanged.
