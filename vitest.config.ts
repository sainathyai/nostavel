import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
    // src/**/*.int.test.ts matches the include pattern above too. Excluded
    // here on purpose (NOS-29 AC 2/3): those tests need a real Postgres and a
    // local Neon HTTP proxy (compose.test.yml) and run only through
    // `npm run test:int` (vitest.integration.config.ts). Without this
    // exclusion, `npm test` - and therefore `npm run verify` - would start
    // requiring Docker, and every job in .github/workflows/ci.yml (including
    // forked pull requests, which get no secrets) would break. Spread
    // configDefaults.exclude first so node_modules/.git stay excluded too -
    // setting `exclude` replaces Vitest's own default, it doesn't add to it.
    // Do not remove this exclusion.
    exclude: [...configDefaults.exclude, "src/**/*.int.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The real package throws on import outside Next's webpack build (which
      // special-cases it into a client-bundle error, not a runtime one). Tests
      // run in plain Node, so swap in its own no-op RSC build.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
