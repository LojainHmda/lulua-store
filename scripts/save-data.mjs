// `npm run save-data`: saves the running emulators' data (database, logins,
// files) to ./emulator-data, which `npm run dev` loads on the next start.
//
// Why not just `--export-on-exit`: on this Windows setup the emulator hub
// writes the export to a temp folder in the project and then RENAMES it into
// place, and that rename fails with EPERM -- so the export is silently lost.
// Here the temp folder is picked up and COPIED into place instead.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = `${root}emulator-data`;

export function saveData({ quiet = false } = {}) {
  const startedAt = Date.now() - 1000;
  const tempTarget = `${root}emulator-data-saving`;
  const res = spawnSync("npx", ["firebase", "emulators:export", tempTarget, "--config", "firebase.lulua.json", "--project", "demo-lulua", "--force"], {
    cwd: root,
    shell: true,
    encoding: "utf8",
  });

  // Success: the export landed in tempTarget. Failure (EPERM): it's in the
  // newest firebase-export-* folder the hub created in the project root.
  let source = existsSync(`${tempTarget}/firebase-export-metadata.json`) ? tempTarget : null;
  if (!source) {
    const fresh = readdirSync(root)
      .filter((n) => n.startsWith("firebase-export-"))
      .map((n) => ({ n, t: statSync(`${root}${n}`).mtimeMs }))
      .filter((x) => x.t >= startedAt && existsSync(`${root}${x.n}/firebase-export-metadata.json`))
      .sort((a, b) => b.t - a.t)[0];
    if (fresh) source = `${root}${fresh.n}`;
  }
  if (!source) {
    console.error("[save-data] Export failed -- emulator-data left unchanged.\n" + (res.stdout || "") + (res.stderr || ""));
    return false;
  }

  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  rmSync(source, { recursive: true, force: true });
  if (!quiet) console.log(`[save-data] Saved to emulator-data (${new Date().toLocaleTimeString()}).`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(saveData() ? 0 : 1);
}
