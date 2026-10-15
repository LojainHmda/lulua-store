import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const PROJECT_ID = "sisley-rules-test";

let envPromise: Promise<RulesTestEnvironment> | null = null;

export function getTestEnv(): Promise<RulesTestEnvironment> {
  if (!envPromise) {
    envPromise = initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
        host: "127.0.0.1",
        port: Number(process.env.RULES_EMULATOR_PORT) || 8080,
      },
    });
  }
  return envPromise;
}

export async function clearFirestore(): Promise<void> {
  const env = await getTestEnv();
  await env.clearFirestore();
}

export async function teardownTestEnv(): Promise<void> {
  if (envPromise) {
    const env = await envPromise;
    await env.cleanup();
    envPromise = null;
  }
}
