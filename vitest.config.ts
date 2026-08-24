import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.admin.toml" }
    })
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/unit/config.test.ts"]
  }
});
