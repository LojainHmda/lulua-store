// `npm run dev`: start the local Firebase emulators (the app's database,
// auth and storage — see firebase.lulua.json / .env.local), wait until
// they're accepting connections, then start Vite. If the emulators are
// already running (e.g. from another terminal), they're reused.
//
// Ctrl+C stops both. The emulators receive Ctrl+C directly from the
// terminal, so `--export-on-exit` still saves data back to ./emulator-data.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { saveData } from "./save-data.mjs";

const config = JSON.parse(readFileSync(new URL("../firebase.lulua.json", import.meta.url), "utf8"));
const ports = [config.emulators.firestore.port, config.emulators.auth.port, config.emulators.storage.port];
// Importing a large emulator-data export can take a few minutes.
const TIMEOUT_MS = 600_000;
// Autosave: the emulators' own --export-on-exit is unreliable on Windows
// (see save-data.mjs), so save every few minutes while running.
const AUTOSAVE_MS = 5 * 60_000;

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function allListening() {
  const results = await Promise.all(ports.map(isListening));
  return results.every(Boolean);
}

function run(script) {
  return spawn("npm", ["run", script], { stdio: "inherit", shell: true });
}

const children = [];

if (await allListening()) {
  console.log("[dev] Firebase emulators already running — reusing them.");
} else {
  // Some ports taken but not all: a leftover emulator from a run that
  // didn't shut down cleanly. Starting another one would just fail.
  const busy = [];
  for (const p of ports) if (await isListening(p)) busy.push(p);
  if (busy.length) {
    console.error(`[dev] Port(s) ${busy.join(", ")} still held by an old emulator. Stop it first, e.g. in PowerShell:`);
    console.error(`      Get-NetTCPConnection -LocalPort ${busy[0]} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`);
    console.error("      then run `npm run dev` again.");
    process.exit(1);
  }
  console.log("[dev] Starting Firebase emulators…");
  const emulators = run("emulators");
  children.push(emulators);

  const started = Date.now();
  while (!(await allListening())) {
    if (Date.now() - started > TIMEOUT_MS) {
      console.error("[dev] Emulators did not start within 10 minutes. Is Java installed and the ports free?");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`[dev] Emulators ready (UI: http://127.0.0.1:${config.emulators.ui.port}).`);
}

children.push(run("dev:web"));

setInterval(() => saveData({ quiet: true }), AUTOSAVE_MS);

// Exit only once every child is done, so the emulators finish exporting.
let remaining = children.length;
for (const child of children) {
  child.on("exit", () => {
    if (--remaining === 0) process.exit(0);
  });
}

// Let children handle Ctrl+C themselves (they share the terminal), and
// just keep this process alive until they've finished shutting down.
process.on("SIGINT", () => {});
