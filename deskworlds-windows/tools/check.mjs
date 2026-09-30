// Cross-platform replacement for the shell loop that ran `node --check` on every module.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = ["serve.mjs"];
for (const dir of readdirSync(join(root, "scenes"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const src = join("scenes", dir.name, dir.name === "shared" ? "" : "src");
  for (const f of readdirSync(join(root, src)))
    if (f.endsWith(".js")) files.push(join(src, f));
}
for (const f of readdirSync(join(root, "ui"))) if (f.endsWith(".js")) files.push(join("ui", f));

for (const f of files) execFileSync(process.execPath, ["--check", join(root, f)], { stdio: "inherit" });
console.log(`syntax ok: ${files.length} files`);
