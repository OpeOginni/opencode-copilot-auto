# @opeoginni/opencode-copilot-auto

Adds GitHub Copilot's **Auto** model to OpenCode. Copilot selects the appropriate available model for every request.

## Install

Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opeoginni/opencode-copilot-auto"]
}
```

Restart OpenCode, authenticate GitHub Copilot if necessary with `opencode auth login`, then select `github-copilot/auto`.

The plugin uses the existing OpenCode GitHub Copilot authentication and sends the prompt to Copilot's routing endpoint solely to select a model.

## Development

```sh
bun install
bun run check
bun run test
bun run build
```
