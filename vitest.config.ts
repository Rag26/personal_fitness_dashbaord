import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for unit tests on pure lib/* functions.
 *
 * Scope intentionally narrow: we test pure functions (no Prisma, no fetch).
 * API routes + UI flows are verified via manual QA per the plan. The `@/`
 * path alias mirrors tsconfig.json so test files can import the same way
 * source code does.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
