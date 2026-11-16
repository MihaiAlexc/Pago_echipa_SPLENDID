import { defineConfig } from "vitest/config";

// Evaluarea cu modelul real (costă bani, cere ANTHROPIC_API KEY în .env).
export default defineConfig({
  test: {
    include: ["tests/**/*.llm.test.ts"],
    environment: "node",
  },
});
