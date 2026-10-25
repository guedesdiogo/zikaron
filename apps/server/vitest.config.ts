import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests swap the GitHub backend for an in-memory one; the webhook secret is real.
      // Identity is synthetic: a test Access team and application, and the clients of ADR-0001 §7's
      // starting configuration, plus a client with none of the flags.
      miniflare: {
        bindings: {
          GITHUB_WEBHOOK_SECRET: "webhook-secret-for-tests",
          ACCESS_TEAM_DOMAIN: "https://time-teste.cloudflareaccess.com",
          ACCESS_AUD: "aud-teste",
          ZIKARON_CLIENTS: JSON.stringify({
            "id-do-noah.access": {
              name: "noah",
              exposed: true,
              privileged: false,
              ownerClaims: true,
            },
            "id-do-alan.access": {
              name: "alan",
              exposed: false,
              privileged: true,
              ownerClaims: false,
            },
            "id-do-mac.access": {
              name: "mac",
              exposed: false,
              privileged: true,
              ownerClaims: false,
            },
            "id-do-kelpie.access": {
              name: "kelpie",
              exposed: false,
              privileged: false,
              ownerClaims: false,
            },
          }),
        },
      },
    }),
  ],
  test: {
    // Resets the fake backend and deletes the vaults after each test, in every file.
    setupFiles: ["./test/setup.ts"],
    // CI fails below 80% on any of these metrics, in every workspace.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    // The first test in each file waits for workerd to start, which takes seconds on a busy
    // machine. These timeouts cover the startup, not slow tests.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
