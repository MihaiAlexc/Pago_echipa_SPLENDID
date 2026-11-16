import { defineConfig } from "vitest/config";

// Un singur loc din care rulează toate testele din proiect.
export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
