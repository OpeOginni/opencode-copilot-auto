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

### Remove the latest PR commit

To remove the latest commit from a PR branch while preserving unrelated working-tree changes, reset with `--keep` and force-push with a lease:

```sh
git reset --keep HEAD^
git push --force-with-lease=refs/heads/<branch>:<previous-tip> \
  <fork-url> HEAD:refs/heads/<branch>
```

Replace `<branch>`, `<previous-tip>`, and `<fork-url>` with the PR source branch, its current remote commit SHA, and the fork URL. The lease prevents overwriting changes pushed by someone else.
