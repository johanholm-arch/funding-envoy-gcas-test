import { defineConfig } from "vitest/config";
// Database-backed test files share one Postgres and reseed the demo tenant, so files run one at a time.
export default defineConfig({ test: { include: ["packages/**/test/**/*.test.ts", "apps/api/test/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false } });
