// Local preview uses .env and keeps all listeners on loopback.
// npm run start:local; add -- --worker only when ready to run background jobs.
import { spawn } from "node:child_process";
import { REPO_ROOT } from "@aihot/backend/config";

const roles = ["apps/api/src/main.ts", "apps/web/server.ts"];
if (process.argv.includes("--worker")) roles.push("apps/worker/src/main.ts");
const children = roles.map((script) => spawn(process.execPath, [script], {
  cwd: REPO_ROOT, stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", WEB_HOST: "127.0.0.1", TRUST_PROXY: "false" },
}));
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
}
for (const [index, child] of children.entries()) {
  child.on("error", (error) => { console.error(`${roles[index]}: ${error.message}`); stop(1); });
  child.on("exit", (code) => { if (!stopping) stop(code || 1); });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
console.log(`FinHot: http://localhost:${process.env.WEB_PORT || 3000} (${process.argv.includes("--worker") ? "后台任务已启动" : "网页预览；后台任务未启动"})`);
