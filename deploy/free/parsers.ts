import type { Source } from "./types.ts";
export interface Candidate { url: string; title: string; excerpt: string; publishedAt: string | null }
export function plain(value: unknown): string {
  return String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => (({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[key] ?? ""))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const x = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n); return x > 0 && x <= 0x10ffff ? String.fromCodePoint(x) : ""; })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim();
}
export function safeUrl(value: string): string | null {
  try { const u = new URL(value); if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null; return u.href.replace(/#.*$/, ""); } catch { return null; }
}
function at(obj: any, path: string): any { return path ? path.split(".").reduce((v, k) => v?.[k], obj) : obj; }
function first(obj: any, paths: string[] = []): string { return paths.map((p) => at(obj, p)).find((v) => typeof v === "string" && v.trim()) ?? ""; }
export function sourceDate(value: unknown, config: Record<string, any>): string | null {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value).trim();
  let parsed: Date;
  if (config.publishedAtUnit === "epoch_s" || config.publishedAtUnit === "epoch_ms") parsed = new Date(Number(value) * (config.publishedAtUnit === "epoch_s" ? 1000 : 1));
  else {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00";
    if (config.publishedAtUtcOffset && !/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(text)) text += `${text.includes("T") ? "" : " "}${config.publishedAtUtcOffset}`;
    parsed = new Date(text);
  }
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function xml(block: string, tag: string): string { return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block)?.[1] ?? ""; }
export function parseSource(source: Source, body: string): Candidate[] {
  const c = source.config;
  if (source.kind === "json_list") {
    const rows = at(JSON.parse(body), c.itemsPath);
    if (!Array.isArray(rows)) throw new Error("信源数据结构已变化");
    return finishCandidates(source, rows.slice(0, 200).flatMap((item) => {
      const render = (template?: string) => {
        let missing = false;
        const out = (template ?? "").replace(/\{(raw:)?([^}]+)\}/g, (_, raw, key) => { const v = at(item, key); if (v == null || v === "") missing = true; return raw ? String(v ?? "") : encodeURIComponent(String(v ?? "")); });
        return missing ? "" : out;
      };
      const url = safeUrl(render(c.urlTemplate) || render(c.urlTemplateFallback));
      const title = plain([...(c.titlePrefixPaths ?? []).map((p: string) => at(item, p)).filter(Boolean), first(item, c.titlePaths)].join(" · ")).slice(0, 500);
      return url && title ? [{ url, title, excerpt: plain(first(item, c.summaryPaths)).slice(0, 5000), publishedAt: sourceDate(at(item, c.publishedAtPath), c) }] : [];
    }));
  }
  if (source.kind !== "rss") throw new Error("免费版暂不抓取此类信源");
  const blocks = [...body.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, 200);
  return finishCandidates(source, blocks.flatMap((match) => {
    const block = match[2]!;
    const link = plain(xml(block, "link")) || /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] || plain(xml(block, "guid"));
    const url = safeUrl(link); const title = plain(xml(block, "title")).slice(0, 500);
    return url && title ? [{ url, title, excerpt: plain(xml(block, "description") || xml(block, "summary") || xml(block, "content:encoded") || xml(block, "content")).slice(0, 5000), publishedAt: sourceDate(plain(xml(block, "pubDate") || xml(block, "published") || xml(block, "updated") || xml(block, "dc:date")), c) }] : [];
  }));
}
// Filter and deduplicate before imposing a batch limit: repeated rows must not crowd out news.
export function finishCandidates(source: Source, rows: Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const item of rows) {
    if (source.config.allowUrlPrefixes?.length && !source.config.allowUrlPrefixes.some((p: string) => item.url.startsWith(p))) continue;
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  return [...unique.values()].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, 20);
}
export async function boundedText(response: Response, limit = 192_000): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let bytes = 0; let text = "";
  try {
    while (bytes < limit) { const { value, done } = await reader.read(); if (done) break; const take = value.subarray(0, limit - bytes); bytes += take.byteLength; text += decoder.decode(take, { stream: true }); }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}
export function beijingDate(now = Date.now()): string { return new Date(now + 8 * 3600_000).toISOString().slice(0, 10); }
export function reportWindow(day: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid report date");
  const end = new Date(`${day}T00:00:00.000Z`); if (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== day) throw new Error("Invalid report date");
  return { start: new Date(end.getTime() - 86400_000).toISOString(), end: end.toISOString() };
}
