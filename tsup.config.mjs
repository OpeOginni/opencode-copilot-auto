import { readFile, writeFile } from "node:fs/promises"
import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: "dist",
  clean: true,
  bundle: false,
  sourcemap: true,
  // Lets `./dist` be loaded as a plugin directory locally, with the TUI half discoverable via `./tui`.
  async onSuccess() {
    const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      type: "module",
      main: "./index.js",
      exports: { ".": "./index.js", "./rpc": "./rpc.js", "./tui": "./tui.js" },
      dependencies: pkg.dependencies,
    }
    await writeFile(new URL("./dist/package.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
  },
})
