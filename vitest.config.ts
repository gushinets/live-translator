import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/web/vite.config.ts",
      {
        test: {
          environment: "node",
          include: ["test/**/*.test.ts", "src/**/*.test.ts"],
          name: "api",
          root: "apps/api",
          setupFiles: ["test/setup.ts"],
        },
      },
    ],
  },
});
