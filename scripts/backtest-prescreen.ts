// Offline replay of the rule pre-screen (industry/prescreen.ts) on exported production analyses.
// Reads files only: no database, no model call.
// node scripts/backtest-prescreen.ts <articles.jsonl> [scores.jsonl]
//   articles.jsonl: one article per line (id, source_id, title, briefed, relevant, scored, selected, by_purpose)
//   scores.jsonl:   the latest scored analysis per article (id, scores [first, second], threshold, selected)
import { readFileSync } from 'node:fs';
import { prescreen, type PrescreenAction } from '../industry/prescreen.ts';

interface Row { id: string; source_id: string; title: string; discovered_at: string; briefed: boolean | null; relevant: boolean | null; scored: boolean | null; selected: boolean | null; score: number | null; by_purpose: Record<string, [number, number]> | null }
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows: Row[] = lines(process.argv[2]!);
/** What a screened item no longer pays for. */
const SAVED: Record<Exclude<PrescreenAction, 'full'>, (purpose: string) => boolean> = {
  index: () => true,
  brief: (p) => ['score_article', 'understand_article', 'structure_article', 'prefilter_article'].includes(p),
};
const usd = (n: number) => n.toFixed(3);
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0) + '%';

type Tally = { n: number; briefed: number; scored: number; selected: number; cost: number; saved: number };
const blank = (): Tally => ({ n: 0, briefed: 0, scored: 0, selected: 0, cost: 0, saved: 0 });
const byAction = new Map<string, Tally>(), byRule = new Map<string, Tally>(), bySource = new Map<string, Record<string, number>>();
const misses: (Row & { rule: string })[] = [];
let total = blank();
for (const r of rows) {
  const { action, rule } = prescreen(r.source_id, r.title);
  const bp = r.by_purpose ?? {}, cost = Object.values(bp).reduce((s, [, c]) => s + c, 0);
  const saved = action === 'full' ? 0 : Object.entries(bp).filter(([p]) => SAVED[action](p)).reduce((s, [, [, c]]) => s + c, 0);
  for (const [map, key] of [[byAction, action], [byRule, rule ?? '(none)']] as const) {
    const t = map.get(key) ?? blank();
    t.n++; t.briefed += +!!r.briefed; t.scored += +!!r.scored; t.selected += +!!r.selected; t.cost += cost; t.saved += saved;
    map.set(key, t);
  }
  total.n++; total.cost += cost; total.saved += saved; total.selected += +!!r.selected; total.scored += +!!r.scored; total.briefed += +!!r.briefed;
  const s = bySource.get(r.source_id) ?? { n: 0, index: 0, brief: 0, full: 0 };
  s.n++; s[action]++; bySource.set(r.source_id, s);
  if (r.selected && action !== 'full') misses.push({ ...r, rule: rule! });
}

const days = new Set(rows.map((r) => r.discovered_at.slice(0, 10))).size;
console.log(`# ${rows.length} articles of editorial sources over ${days} days; model cost attached to them USD ${usd(total.cost)}; ${total.selected} selected`);
console.log(`\n## By action (share of arrivals; what they cost; what the rules would have saved)`);
for (const [a, t] of byAction) console.log(`${a.padEnd(6)} ${String(t.n).padStart(6)} (${pct(t.n, total.n).padStart(4)})  briefed ${t.briefed}  scored ${t.scored}  selected ${t.selected}  cost ${usd(t.cost)}  saved ${usd(t.saved)}`);
console.log(`saved USD ${usd(total.saved)} of ${usd(total.cost)} (${pct(total.saved, total.cost)})`);
console.log(`\n## By rule`);
for (const [k, t] of [...byRule].sort((a, b) => b[1].n - a[1].n)) console.log(`${k.padEnd(22)} ${String(t.n).padStart(6)}  briefed ${String(t.briefed).padStart(5)}  scored ${String(t.scored).padStart(4)}  selected ${String(t.selected).padStart(3)}  saved ${usd(t.saved)}`);
console.log(`\n## By source (arrivals: index / brief / full)`);
for (const [k, s] of [...bySource].sort((a, b) => b[1].n - a[1].n)) console.log(`${k.padEnd(26)} ${String(s.n).padStart(5)}: ${s.index} / ${s.brief} / ${s.full}`);
console.log(`\n## Selected items the rules would have screened out (${misses.length} of ${total.selected})`);
for (const m of misses) console.log(`- [${m.rule}] ${m.source_id} · ${m.score ?? ''} · ${m.title.slice(0, 90)}`);

// Demand: the daily spend if every arrival went through its path, at this period's cost per call.
const calls = (p: string) => rows.reduce((s, r) => s + (r.by_purpose?.[p]?.[0] ?? 0), 0);
const spent = (p: string) => rows.reduce((s, r) => s + (r.by_purpose?.[p]?.[1] ?? 0), 0);
const perBrief = spent('brief_article') / calls('brief_article'), perScore = spent('score_article') / calls('score_article');
const briefedFull = rows.filter((r) => r.briefed && prescreen(r.source_id, r.title).action === 'full');
const relevantAll = rows.filter((r) => r.briefed).reduce((s, r) => s + +!!r.relevant, 0) / rows.filter((r) => r.briefed).length;
const relevantFull = briefedFull.reduce((s, r) => s + +!!r.relevant, 0) / briefedFull.length;
const perDay = (n: number) => n / days, fullN = byAction.get('full')?.n ?? 0, indexN = byAction.get('index')?.n ?? 0;
const demand = (briefs: number, scored: number, scoresPerItem: number) => perDay(briefs) * perBrief + perDay(scored) * perScore * scoresPerItem;
console.log(`\n## Daily demand if every arrival is processed (brief USD ${perBrief.toFixed(5)}/call, score USD ${perScore.toFixed(5)}/call; relevant ${pct(relevantAll * 1000, 1000)} overall, ${pct(relevantFull * 1000, 1000)} of full)`);
console.log(`now (every item briefed, relevant ones scored twice): ${Math.round(perDay(total.n))} briefs + ${Math.round(perDay(total.n * relevantAll))} scored/day ≈ USD ${demand(total.n, total.n * relevantAll, 2).toFixed(2)}/day`);
const second = (process.argv[3] ? 0.18 : 1);
console.log(`rules: ${Math.round(perDay(total.n - indexN))} briefs + ${Math.round(perDay(fullN * relevantFull))} scored/day ≈ USD ${demand(total.n - indexN, fullN * relevantFull, 2).toFixed(2)}/day; with one score (+${Math.round(second * 100)}% second) ≈ USD ${demand(total.n - indexN, fullN * relevantFull, 1 + second).toFixed(2)}/day`);

// Second score only near the threshold: the first score decides when it is clearly above or below.
if (process.argv[3]) {
  const scored: { id: string; scores: number[] | null; threshold: string | null; selected: boolean }[] = lines(process.argv[3]);
  const pairs = scored.filter((s) => Array.isArray(s.scores) && s.scores.length === 2 && s.threshold !== null);
  console.log(`\n## One score, a second only near the threshold (${pairs.length} scored items with two scores)`);
  for (const margin of [5, 8, 10, 15]) {
    let skipped = 0, lost = 0, gained = 0;
    for (const s of pairs) {
      const [first, second] = s.scores as [number, number], t = Number(s.threshold);
      const both = (first + second) / 2 >= t, near = Math.abs(first - t) <= margin;
      const decided = near ? both : first >= t;
      if (!near) skipped++;
      if (both && !decided) lost++;
      if (!both && decided) gained++;
    }
    console.log(`margin ±${String(margin).padStart(2)}: second score skipped for ${skipped} (${pct(skipped, pairs.length)}); selections lost ${lost}, added ${gained}`);
  }
}
