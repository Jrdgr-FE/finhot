// Feed folding: the reports of one occurrence show once in the public feed. Event grouping (group.ts)
// runs only for selected reports, so the ordinary summaries of a busy story (twenty outlets on one
// approval) would otherwise each take a row. Every public report is compared, by the same title-and-
// summary embedding the grouping uses, with the reports of the 48 hours around it; above
// FOLD_MIN_COSINE it joins the first report of the closest one's cluster. No chat model is called.
// The feed keeps one report per cluster (feedRepresentatives): a selected one first, else the first
// found. Folded reports stay public at their own address; only the feed list leaves them out.
import { sql } from "../db.ts";
import { embeddingsAvailable } from "../providers/embeddings.ts";
import { cosine32, reportTexts, vectorsFor } from "./group.ts";

/** group.ts merges without a second opinion from 0.85: the same bar marks one occurrence here. */
export const FOLD_MIN_COSINE = Number(process.env.FINHOT_FOLD_MIN_COSINE) || 0.85;
const FOLD_WINDOW_HOURS = 48;

export async function foldArticle(articleId: string): Promise<{ state: string; cluster?: string | null; score?: number; match?: string }> {
  if (!embeddingsAvailable()) return { state: "no-embeddings" };
  const [me] = await sql<{ id: string; primary_domain: string; at: Date }[]>`
    SELECT p.article_id AS id, p.primary_domain, coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p WHERE p.article_id = ${articleId} AND p.eligible AND p.visibility = 'public'`;
  if (!me) return { state: "not-public" };
  const hours = `${FOLD_WINDOW_HOURS} hours`;
  const peers = await sql<{ id: string; feed_cluster: string | null }[]>`
    SELECT p.article_id AS id, a.feed_cluster FROM publications p JOIN articles a ON a.id = p.article_id
    WHERE p.eligible AND p.visibility = 'public' AND p.article_id <> ${me.id} AND p.primary_domain = ${me.primary_domain}
      AND a.feed_folded_at IS NOT NULL
      AND coalesce(p.published_at, p.discovered_at) BETWEEN ${me.at}::timestamptz - ${hours}::interval AND ${me.at}::timestamptz + ${hours}::interval`;
  // A report never joins a cluster that it is itself the first of.
  const candidates = peers.filter((p) => p.feed_cluster !== me.id);
  const texts = await reportTexts([me.id, ...candidates.map((p) => p.id)]);
  const vectors = await vectorsFor([me.id, ...candidates.map((p) => p.id)].map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text));
  const mine = vectors.get(me.id);
  if (!mine) return { state: "no-text" };
  let best: { id: string; cluster: string; score: number } | null = null;
  for (const p of candidates) {
    const v = vectors.get(p.id);
    if (!v) continue;
    const score = cosine32(mine, v);
    if (score >= FOLD_MIN_COSINE && (!best || score > best.score)) best = { id: p.id, cluster: p.feed_cluster ?? p.id, score };
  }
  const cluster = best?.cluster ?? null;
  await sql`UPDATE articles SET feed_cluster = ${cluster}, feed_folded_at = now() WHERE id = ${me.id}`;
  return { state: cluster ? "folded" : "first", cluster, score: best ? Math.round(best.score * 1000) / 1000 : 0, match: best?.id };
}

export interface FoldRow { id: string; feed_cluster: string | null; story_id: number | null; selected: boolean; score: number | null; at: Date }

/**
 * The feed's ids, one per occurrence: reports of one cluster or one story count as one, and the
 * selected report with the highest score stands for them, else the first one found.
 */
export function feedRepresentatives(rows: FoldRow[]): Set<string> {
  const parent = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byStory = new Map<number, string>();
  for (const r of rows) {
    if (r.feed_cluster && parent.has(r.feed_cluster)) union(r.id, r.feed_cluster);
    if (r.story_id != null) { const first = byStory.get(r.story_id); if (first) union(r.id, first); else byStory.set(r.story_id, r.id); }
  }
  const best = new Map<string, FoldRow>();
  const better = (a: FoldRow, b: FoldRow) =>
    a.selected !== b.selected ? a.selected : a.selected && (a.score ?? 0) !== (b.score ?? 0) ? (a.score ?? 0) > (b.score ?? 0) : +a.at !== +b.at ? +a.at < +b.at : a.id < b.id;
  for (const r of rows) {
    const root = find(r.id), cur = best.get(root);
    if (!cur || better(r, cur)) best.set(root, r);
  }
  return new Set([...best.values()].map((r) => r.id));
}
