import { initializeTestEnvironment, type RulesTestEnvironment } from "./testing";

let envPromise: Promise<RulesTestEnvironment> | null = null;

export function getTestEnv(): Promise<RulesTestEnvironment> {
  if (!envPromise) envPromise = initializeTestEnvironment();
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
