import { readFile, writeFile } from "node:fs/promises"
import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/sdk.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: "dist",
  clean: true,
  // Ship only OpenCode's native Copilot SDK, not its host/plugin runtime.
  bundle: true,
  splitting: true,
  noExternal: ["@opencode/core"],
  sourcemap: true,
  // Lets ./dist be loaded as a plugin directory locally.
  async onSuccess() {
    const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      type: "module",
      main: "./index.js",
      exports: { ".": "./index.js" },
      dependencies: pkg.dependencies,
    }
    await writeFile(new URL("./dist/package.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
  },
})
