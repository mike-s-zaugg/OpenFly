import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// OpenFly's own tests (run from openfront/ so OpenFront's packages resolve):
//   cd openfront && npx vitest run --config ../fly/vitest.config.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root,
  resolve: {
    // OpenFront's own tsconfig path aliases.
    alias: [
      { find: /^resources\//, replacement: `${root}/openfront/resources/` },
      { find: /^src\//, replacement: `${root}/openfront/src/` },
    ],
  },
  test: {
    include: ["fly/tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
