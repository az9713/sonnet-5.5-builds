// Runs every node test of the four scenes added after the original set (no GPU needed).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scenes = ["slimescape", "pelagicscape", "aurorascape", "cosmoscape"];
let failed = 0, total = 0;
for (const scene of scenes) {
  const dir = join(root, "scenes", scene, "tests");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const start = Date.now();
    const run = spawnSync(process.execPath, [join(dir, file)], { encoding: "utf8" });
    total++;
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    if (run.status === 0) console.log(`ok   ${scene}/${file} (${seconds}s)`);
    else { failed++; console.log(`FAIL ${scene}/${file} (${seconds}s)\n${run.stdout}${run.stderr}`); }
  }
}
console.log(`${total - failed}/${total} test files passed`);
process.exit(failed ? 1 : 0);
