import { join } from "node:path";
import { defineConfig } from "vitest/config";

if (process.env.XDG_CONFIG_HOME === undefined && process.env.TEMP !== undefined) {
  process.env.XDG_CONFIG_HOME = join(
    process.env.TEMP,
    "cancerculture-watchdog-wrangler",
  );
}
const { cloudflareTest } = await import("@cloudflare/vitest-pool-workers");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
