// Feed folding: the reports of one occurrence show once in the public feed. Event grouping (group.ts)
// runs only for selected reports, so the ordinary summaries of a busy story (twenty outlets on one
// approval) would otherwise each take a row. Every public report is compared, by the same title-and-
// summary embedding the grouping uses, with the reports of the 48 hours around it; above
// FOLD_MIN_COSINE it joins the first report of the closest one's cluster. Without embeddings the
// titles are compared by shared character pairs weighted by rarity in the window (titleSimilarity),
// which only catches near-identical wording. No chat model is called.
// The feed keeps one report per cluster (feedRepresentatives): a selected one first, else the first
// found. Folded reports stay public at their own address; only the feed list leaves them out.
import { sql } from "../db.ts";
import { embeddingsAvailable } from "../providers/embeddings.ts";
import { cosine32, reportTexts, vectorsFor } from "./group.ts";

/** group.ts merges without a second opinion from 0.85: the same bar marks one occurrence here. */
export const FOLD_MIN_COSINE = Number(process.env.FINHOT_FOLD_MIN_COSINE) || 0.85;
/** Rarity-weighted title overlap; calibrated on 2026-10-19..22 titles (one false merge at 0.40, none at 0.45). */
export const FOLD_MIN_TITLE = Number(process.env.FINHOT_FOLD_MIN_TITLE) || 0.45;
const FOLD_WINDOW_HOURS = 48;

const titleGrams = (s: string) => {
  const chars = [...s.replace(/[\s\p{P}\p{S}]+/gu, "")];
  return new Set(chars.map((_c, i) => chars.slice(i, i + 2).join("")).filter((g) => g.length === 2));
};

/**
 * Weighted Jaccard of title character pairs, each pair weighted by log(N/df) over the given titles:
 * template words ("预计前三季度净利润", "发布三季度报告") weigh little, names and numbers much.
 */
export function titleSimilarity(titles: string[]): (a: number, b: number) => number {
  const grams = titles.map(titleGrams), df = new Map<string, number>();
  for (const set of grams) for (const g of set) df.set(g, (df.get(g) ?? 0) + 1);
  const weight = (g: string) => Math.log(titles.length / (df.get(g) ?? 1));
  return (a, b) => {
    const A = grams[a]!, B = grams[b]!;
    let shared = 0, total = 0;
    for (const g of new Set([...A, ...B])) { const w = weight(g); total += w; if (A.has(g) && B.has(g)) shared += w; }
    return total ? shared / total : 0;
  };
}

export async function foldArticle(articleId: string): Promise<{ state: string; cluster?: string | null; score?: number; match?: string }> {
  const [me] = await sql<{ id: string; primary_domain: string; at: Date; title: string }[]>`
    SELECT p.article_id AS id, p.primary_domain, coalesce(p.published_at, p.discovered_at) AS at, p.title
    FROM publications p WHERE p.article_id = ${articleId} AND p.eligible AND p.visibility = 'public'`;
  if (!me) return { state: "not-public" };
  const hours = `${FOLD_WINDOW_HOURS} hours`;
  const peers = await sql<{ id: string; feed_cluster: string | null; title: string }[]>`
    SELECT p.article_id AS id, a.feed_cluster, p.title FROM publications p JOIN articles a ON a.id = p.article_id
    WHERE p.eligible AND p.visibility = 'public' AND p.article_id <> ${me.id} AND p.primary_domain = ${me.primary_domain}
      AND a.feed_folded_at IS NOT NULL
      AND coalesce(p.published_at, p.discovered_at) BETWEEN ${me.at}::timestamptz - ${hours}::interval AND ${me.at}::timestamptz + ${hours}::interval`;
  // A report never joins a cluster that it is itself the first of.
  const candidates = peers.filter((p) => p.feed_cluster !== me.id);
  let best: { id: string; cluster: string; score: number } | null = null;
  if (!embeddingsAvailable()) {
    // Rarity is counted over the whole window, the reports already compared and this one.
    const similar = titleSimilarity([me.title, ...peers.map((p) => p.title)]);
    for (const [i, p] of peers.entries()) {
      if (p.feed_cluster === me.id) continue;
      const score = similar(0, i + 1);
      if (score >= FOLD_MIN_TITLE && (!best || score > best.score)) best = { id: p.id, cluster: p.feed_cluster ?? p.id, score };
    }
    return settle(me.id, best);
  }
  const texts = await reportTexts([me.id, ...candidates.map((p) => p.id)]);
  const vectors = await vectorsFor([me.id, ...candidates.map((p) => p.id)].map((id) => ({ id, text: texts.get(id) ?? "" })).filter((x) => x.text));
  const mine = vectors.get(me.id);
  if (!mine) return { state: "no-text" };
  for (const p of candidates) {
    const v = vectors.get(p.id);
    if (!v) continue;
    const score = cosine32(mine, v);
    if (score >= FOLD_MIN_COSINE && (!best || score > best.score)) best = { id: p.id, cluster: p.feed_cluster ?? p.id, score };
  }
  return settle(me.id, best);
}

async function settle(id: string, best: { id: string; cluster: string; score: number } | null) {
  const cluster = best?.cluster ?? null;
  await sql`UPDATE articles SET feed_cluster = ${cluster}, feed_folded_at = now() WHERE id = ${id}`;
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
