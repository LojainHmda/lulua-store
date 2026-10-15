import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/rules/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    // Every test file shares one Firestore emulator project and calls
    // clearFirestore() in beforeEach — running files concurrently lets one
    // file's clear wipe another's in-flight fixtures mid-test, causing
    // spurious failures (a doc set up right before an assertion vanishing,
    // or a bootstrap doc disappearing and re-opening self-serve creation).
    fileParallelism: false,
  },
});
