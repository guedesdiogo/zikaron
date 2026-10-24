import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Os testes trocam o backend do GitHub por um em memória; o segredo do webhook é de verdade.
      miniflare: { bindings: { GITHUB_WEBHOOK_SECRET: "webhook-secret-for-tests" } },
    }),
  ],
  test: {
    // Devolve o backend falso e apaga os cofres depois de cada teste, em todo arquivo.
    setupFiles: ["./test/setup.ts"],
    // A CI falha abaixo de 80% em qualquer destas métricas, em todo workspace.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    // O primeiro teste de cada arquivo espera o workerd subir, o que leva segundos numa máquina
    // ocupada. Estes prazos cobrem a subida, não testes lentos.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
