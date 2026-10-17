// `npm run dev`: start the Lulua API (services/api) against the Neon
// database in .env.local (DATABASE_URL), wait until it answers, then start
// Vite pointed at it (VITE_API_URL). Ctrl+C stops both.
//
// .env.local:
//   DATABASE_URL=postgresql://...neon.tech/...   (Neon connection string)
//   VITE_API_URL=http://localhost:8787
// Without DATABASE_URL the API uses a local in-memory Postgres (empty data).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

const root = new URL("..", import.meta.url);
const envFile = new URL(".env.local", root);
const env = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]])
    )
  : {};

const PORT = 8787;
const apiUrl = env.VITE_API_URL || `http://localhost:${PORT}`;
if (!env.DATABASE_URL) console.warn("[dev] DATABASE_URL not set in .env.local — using an empty in-memory database.");

const healthy = () =>
  fetch(`http://localhost:${PORT}/healthz`).then(
    (r) => r.ok,
    () => false
  );
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

const children = [];
if (await healthy()) {
  console.log(`[dev] An API is already running on :${PORT} — reusing it.`);
} else {
  if (await portBusy(PORT)) {
    console.error(`[dev] Port ${PORT} is taken by something that isn't the API. Stop it first (PowerShell):`);
    console.error(`      Get-NetTCPConnection -LocalPort ${PORT} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`);
    process.exit(1);
  }
  const api = spawn("node", ["--watch", "src/server.ts"], {
    cwd: new URL("services/api", root),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env, PORT: String(PORT) },
  });
  children.push(api);
  const started = Date.now();
  while (!(await healthy())) {
    if (Date.now() - started > 60_000) {
      console.error("[dev] API did not start within 60s (see the error above).");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log(`[dev] API ready on ${apiUrl}`);

if (await portBusy(5176)) {
  console.error("[dev] Port 5176 is taken — another `npm run dev` is probably still running. Stop it first (PowerShell):");
  console.error("      Get-NetTCPConnection -LocalPort 5176 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }");
  process.exit(1);
}
children.push(spawn("npm", ["run", "dev:web"], { stdio: "inherit", shell: true, env: { ...process.env, VITE_API_URL: apiUrl } }));

let remaining = children.length;
for (const child of children) {
  child.on("exit", () => {
    if (--remaining === 0) process.exit(0);
  });
}
process.on("SIGINT", () => {});
