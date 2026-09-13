import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/web/vite.config.ts",
  {
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
      name: "api",
      root: "apps/api",
    },
  },
]);
