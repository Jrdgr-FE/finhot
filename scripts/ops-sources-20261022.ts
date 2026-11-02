// Ops one-off (2026-10-22): disables the dropped sources and runs the new AI sources like the existing AI trial.
// Run from the release root after scripts/seed.ts:  node --env-file=/etc/finhot/worker.env scripts/ops-sources-20261022.ts <plan.json>
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";

const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { drop: string[]; add: { id: string }[] };
const off = await sql`UPDATE sources SET enabled = false, updated_at = now() WHERE id IN ${sql(plan.drop)} AND enabled RETURNING id`;
console.log(`disabled: ${off.map((r) => r.id).join(", ") || "none"}`);
const [trial] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = 'ai-openai-news'`;
const ai = plan.add.map((s) => s.id).filter((id) => id.startsWith("ai-"));
if (trial && ai.length) {
  const moved = await sql`UPDATE sources SET participation_mode = ${trial.participation_mode}, updated_at = now() WHERE id IN ${sql(ai)} AND participation_mode <> ${trial.participation_mode} RETURNING id`;
  console.log(`new AI sources set to ${trial.participation_mode} (like ai-openai-news): ${moved.length}`);
}
await closeDb();
