// Build the frontend locally before packaging. Never include credentials or macOS metadata.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const target = path.resolve(process.argv[2] ?? ".data/ops/ecs");
fs.mkdirSync(target, { recursive: true });
const release = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
const file = path.join(target, `finhot-${release}.tar.gz`);
execFileSync("tar", [
  "--no-xattrs", "--exclude=._*", "--exclude=node_modules", "--exclude=.env", "--exclude=.env.*",
  "--exclude=.dev.vars*", "--exclude=.data", "--exclude=.react-router", "--exclude=.cache",
  "-czf", file, "apps", "packages", "industry", "database", "scripts", "tests", "assets", "reference", "deploy", "package.json", "package-lock.json", "tsconfig.base.json", "LICENSE", "NOTICE",
], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(path.join(target, "release.json"), JSON.stringify({ release, remote: `/opt/finhot/releases/${release}`, file, sha256 }, null, 2));
console.log(JSON.stringify({ release, file, sha256, bytes: fs.statSync(file).size }));
