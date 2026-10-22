// Read boundary for the D1 edition. Never returns source excerpts or provider receipts.
import type { Env, Item } from "../../../../deploy/free/types.ts";

const title = "CASE WHEN state='ready' THEN title ELSE original_title END";
const summary = "CASE WHEN state='ready' THEN summary ELSE '' END";
const columns = `id,url,source_id,source_name,${title} AS title,${summary} AS summary,category,selected,published_at,discovered_at,ready_at,state,body_status,body_length,material_scope`;
export async function freeItems(env: Env, options: { all?: boolean; category?: string; sourceIds?: string[]; search?: string; offset?: number; limit?: number } = {}) {
  const where = [options.all ? "state IN ('ready','source-only','pending','awaiting-body')" : "state='ready' AND selected=1"];
  const args: (string | number)[] = [];
  if (options.category) { where.push("category=?"); args.push(options.category); }
  if (options.sourceIds) { where.push(options.sourceIds.length ? `source_id IN (${options.sourceIds.map(() => "?").join(",")})` : "0=1"); args.push(...options.sourceIds); }
  if (options.search) { where.push(`(${title} LIKE ? ESCAPE '\\' OR ${summary} LIKE ? ESCAPE '\\')`); const q = `%${options.search.replace(/[\\%_]/g, "\\$&")}%`; args.push(q, q); }
  const limit = Math.min(40, Math.max(1, options.limit ?? 20));
  const rows = await env.DB.prepare(`SELECT ${columns} FROM items WHERE ${where.join(" AND ")} ORDER BY COALESCE(published_at,discovered_at) DESC,id DESC LIMIT ? OFFSET ?`).bind(...args, limit + 1, options.offset ?? 0).all<Partial<Item>>();
  const spent = await env.DB.prepare("SELECT count(*) AS n FROM ai_receipts WHERE day=?").bind(new Date().toISOString().slice(0, 10)).first<{ n: number }>();
  return { items: rows.results.slice(0, limit), hasMore: rows.results.length > limit, summaryBudgetReached: (spent?.n ?? 0) >= Math.min(40, Math.max(0, Number(env.AI_DAILY_LIMIT) || 0)) };
}
export async function freeReports(env: Env, date?: string) {
  if (!date) return (await env.DB.prepare("SELECT date,created_at,json_array_length(item_ids) AS count FROM reports ORDER BY date DESC LIMIT 30").all()).results;
  const report = await env.DB.prepare("SELECT * FROM reports WHERE date=?").bind(date).first<{ date: string; item_ids: string; created_at: string }>();
  if (!report) return null;
  const ids: string[] = JSON.parse(report.item_ids);
  const items = ids.length ? (await env.DB.prepare(`SELECT ${columns} FROM items WHERE state='ready' AND selected=1 AND id IN (${ids.map(() => "?").join(",")}) ORDER BY score DESC,ready_at DESC`).bind(...ids).all()).results : [];
  return { date: report.date, created_at: report.created_at, items };
}
export function escapeXml(value: unknown): string {
  return String(value ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
}
export async function freeRss(env: Env, origin: string): Promise<string> {
  const { items } = await freeItems(env, { limit: 30 });
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>FinHot · 金融精选</title><link>${escapeXml(origin)}</link><description>金融资讯中文摘要与原文索引</description><language>zh-cn</language>${items.map((i) => `<item><title>${escapeXml(i.title)}</title><link>${escapeXml(i.url)}</link><guid isPermaLink="false">${escapeXml(i.id)}</guid><description>${escapeXml(i.summary)}</description><pubDate>${new Date(i.published_at ?? i.discovered_at!).toUTCString()}</pubDate><source>${escapeXml(i.source_name)}</source></item>`).join("")}</channel></rss>`;
}
