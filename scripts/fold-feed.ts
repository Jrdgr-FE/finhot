// Folds the public feed of a recent window (packages/backend/src/events/fold.ts).
//
//   node --env-file=.env scripts/fold-feed.ts --hours 72 --dry-run [--min 0.85] [--out fold.tsv]
//   node --env-file=.env scripts/fold-feed.ts --hours 72
//
// `--dry-run` embeds the window (stored vectors are reused; only missing ones are paid embedding calls)
// and prints the clusters the threshold would make, largest first, without writing anything. Without it,
// every public report of the window that has not been compared yet is folded in discovery order, as the
// worker would have done live.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { cosine32, reportTexts, vectorsFor } from "@aihot/backend/events/group";
import { FOLD_MIN_COSINE, foldArticle } from "@aihot/backend/events/fold";

const { values } = parseArgs({ options: { hours: { type: "string", default: "72" }, "dry-run": { type: "boolean", default: false }, min: { type: "string" }, out: { type: "string" } } });
const min = values.min ? Number(values.min) : FOLD_MIN_COSINE;

const rows = await sql<{ id: string; primary_domain: string; at: Date; selected: boolean; folded: boolean }[]>`
  SELECT p.article_id AS id, p.primary_domain, coalesce(p.published_at, p.discovered_at) AS at, p.selected, a.feed_folded_at IS NOT NULL AS folded
  FROM publications p JOIN articles a ON a.id = p.article_id
  WHERE p.eligible AND p.visibility = 'public' AND coalesce(p.published_at, p.discovered_at) > now() - ${`${Number(values.hours)} hours`}::interval
  ORDER BY a.discovered_at, a.id`;

if (values["dry-run"]) {
  const texts = await reportTexts(rows.map((r) => r.id));
  const vectors = new Map<string, Float32Array>();
  for (let i = 0; i < rows.length; i += 100) {
    const got = await vectorsFor(rows.slice(i, i + 100).map((r) => ({ id: r.id, text: texts.get(r.id) ?? "" })).filter((x) => x.text));
    for (const [id, v] of got) vectors.set(id, v);
  }
  const cluster = new Map<string, string>(), seen: typeof rows = [];
  for (const r of rows) {
    const v = vectors.get(r.id);
    let best: { id: string; score: number } | null = null;
    for (const p of seen) {
      const w = vectors.get(p.id);
      if (!v || !w || p.primary_domain !== r.primary_domain || Math.abs(+p.at - +r.at) > 48 * 3600_000) continue;
      const score = cosine32(v, w);
      if (score >= min && (!best || score > best.score)) best = { id: p.id, score };
    }
    cluster.set(r.id, best ? cluster.get(best.id)! : r.id);
    seen.push(r);
  }
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(cluster.get(r.id)!, [...(groups.get(cluster.get(r.id)!) ?? []), r.id]);
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  const lines = sorted.flatMap((ids, n) => ids.map((id) => `${n + 1}\t${ids.length}\t${id}\t${(texts.get(id) ?? "").split("。")[0]}`));
  console.log(`threshold ${min}: ${rows.length} reports -> ${groups.size} feed rows (${rows.length - groups.size} folded)`);
  if (values.out) writeFileSync(values.out, lines.join("\n") + "\n");
  else console.log(lines.filter((l) => Number(l.split("\t")[1]) > 1).join("\n"));
} else {
  let folded = 0;
  for (const r of rows.filter((x) => !x.folded)) {
    const result = await foldArticle(r.id);
    if (result.state === "folded") folded++;
    if (result.state === "no-embeddings") throw new Error("Embeddings are not available (EMBEDDING_API_KEY or DASHSCOPE_API_KEY, MODEL_CALLS_ENABLED)");
  }
  console.log(`${rows.length} reports in the window, ${folded} folded`);
}
await closeDb();
