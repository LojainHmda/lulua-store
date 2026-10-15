import { defineConfig } from "vitest/config";

// Plain, no-emulator unit tests for pure logic (matching/ranking, etc.) —
// separate from vitest.rules.config.ts, which needs the Firestore emulator
// and runs its files sequentially against shared emulator state. Nothing
// here touches Firestore or Firebase Auth at all.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
