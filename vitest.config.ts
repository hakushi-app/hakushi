import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Markdown pipeline tests run in node; editor tests opt into jsdom via
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: "node",
  },
});
