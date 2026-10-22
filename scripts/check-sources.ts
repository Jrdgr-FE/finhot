// Read-only live probe of configured sources. No database writes or model calls.
// node scripts/check-sources.ts [source-id ...]
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const ids = process.argv.slice(2);
const { sources } = JSON.parse(readFileSync(`${REPO_ROOT}/industry/sources.json`, "utf8")) as { sources: SourceRow[] };
let failures = 0;
for (const source of sources.filter((s) => ids.length ? ids.includes(s.id) : s.enabled !== false)) {
  try {
    assertSupportedConfig(source.kind, source.config);
    const rows = source.kind === "rss" ? (await fetchRss(source)).candidates
      : source.kind === "json_list" ? await fetchJsonList(source)
      : source.kind === "web_list" ? await fetchWebList(source) : [];
    const newest = rows.map((r) => r.publishedAt?.getTime()).filter((t): t is number => typeof t === "number" && Number.isFinite(t)).sort((a, b) => b - a)[0];
    const ageDays = newest === undefined ? null : Math.round((Date.now() - newest) / 86_400_000);
    const ok = rows.length > 0 && ageDays !== null && ageDays <= 30 && ageDays >= -1;
    if (!ok) failures += 1;
    console.log(JSON.stringify({ id: source.id, ok, count: rows.length, ageDays, latest: newest === undefined ? null : new Date(newest).toISOString(), sample: rows[0]?.title }));
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({ id: source.id, ok: false, error: String(error) }));
  }
}
process.exitCode = failures ? 1 : 0;
