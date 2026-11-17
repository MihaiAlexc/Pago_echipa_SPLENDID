import { defineConfig } from "vitest/config";

// Evaluarea cu modelul real (costă bani, cere GROQ_API_KEY sau ANTHROPIC_API_KEY în .env).
export default defineConfig({
  test: {
    include: ["tests/**/*.llm.test.ts"],
    environment: "node",
  },
});
