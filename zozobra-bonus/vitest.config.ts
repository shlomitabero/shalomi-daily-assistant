import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "supabase/functions/_shared"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["supabase/functions/_shared/**/*.test.ts", "src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
