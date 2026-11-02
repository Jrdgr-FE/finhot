// Ops one-off (2026-10-22): how the new and dropped sources are doing. Read-only.
// node --env-file=/etc/finhot/worker.env scripts/ops-sources-status.ts <plan.json>
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";

const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { drop: string[]; add: { id: string }[] };
const ids = [...plan.add.map((s) => s.id), ...plan.drop];
const rows = await sql`
  SELECT s.id, s.enabled, s.participation_mode AS mode, s.health, s.fail_count, s.last_ok_at, left(coalesce(s.last_error,''),120) AS last_error,
    (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '1 hour')::int AS new_1h,
    (SELECT count(*) FROM articles a WHERE a.source_id = s.id)::int AS total
  FROM sources s WHERE s.id IN ${sql(ids)} ORDER BY s.enabled DESC, s.id`;
for (const r of rows) console.log(JSON.stringify(r));
console.log(`missing in DB: ${ids.filter((id) => !rows.some((r) => r.id === id)).join(", ") || "none"}`);
await closeDb();
