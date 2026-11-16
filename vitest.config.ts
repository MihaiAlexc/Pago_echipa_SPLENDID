import { defineConfig } from "vitest/config";

// Testele deterministe (fără LLM real). Rulează cu `npm test`.
// Evaluarea cu modelul real (*.llm.test.ts) rulează separat: `npm run test:llm`.
export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.llm.test.ts"],
    environment: "node",
  },
});
