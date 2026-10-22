import pack from "../../industry/sources.json" with { type: "json" };
import { CATEGORIES as taxonomy, IDENTITY_LEXICON } from "../../industry/taxonomy.ts";
import { SELECTION } from "../../industry/selection.ts";
import { FREE_SUMMARY_PROMPT } from "../../industry/prompts/free-summary.ts";
import { parseSource, boundedText, reportWindow } from "./parsers.ts";
import { parseWebList } from "./web-list.ts";
import type { Env, Item, Source } from "./types.ts";

// The lightweight edition processes editorial feeds; discussion-only streams stay in the original app.
export const SOURCES = pack.sources.filter((s) => s.enabled !== false && s.participation_mode === "editorial") as Source[];
export const CATEGORIES: Record<string, string> = Object.fromEntries(taxonomy.map((c) => [c.key, c.label]));
export const SOURCE_GROUPS: Record<string, string> = { market: "市场资讯", company: "上市公司", research: "投资研究", macro: "政策与宏观", global: "海外金融" };
export function dueSources(health: { id: string; checked_at: string }[], now: number): Source[] {
  const checked = new Map(health.map((h) => [h.id, Date.parse(h.checked_at)]));
  return SOURCES.map((source) => ({ source, last: checked.get(source.id) ?? 0 }))
    .filter(({ source, last }) => now - last >= Math.max(30, source.interval_minutes ?? 60) * 60000)
    .sort((a, b) => a.last - b.last).slice(0, 4).map(({ source }) => source);
}
export async function hash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function collect(env: Env, sourceId: string): Promise<void> {
  if (env.COLLECT_ENABLED !== "true") return;
  const source = SOURCES.find((s) => s.id === sourceId); if (!source) throw new Error("Unknown source");
  const now = new Date().toISOString();
  try {
    // The URL and headers come only from the checked-in source list, never from visitor input.
    const c = source.config;
    const res = await fetch(c.feedUrl ?? c.url, {
      method: c.method ?? "GET",
      headers: { "user-agent": "FinHotBot/1.0", ...c.headers, ...(c.bodyForm ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: c.bodyForm ? new URLSearchParams(c.bodyForm).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await boundedText(res, 512_000);
    const candidates = source.kind === "web_list" ? await parseWebList(source, text) : parseSource(source, text);
    if (!candidates.length) throw new Error("未解析出文章，请复核信源配置");
    const statements = [];
    for (const item of candidates) {
      const id = await hash(item.url);
      const published = item.publishedAt && item.publishedAt <= new Date(Date.now() + 3600_000).toISOString() ? item.publishedAt : null;
      // Keep a small first-import window and avoid paying for years of historic feed entries.
      if (published && published < new Date(Date.now() - 30 * 86400_000).toISOString()) continue;
      const state = hasSummaryEvidence({ excerpt: item.excerpt, original_title: item.title }) ? "pending" : "source-only";
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO items(id,url,source_id,source_name,tier,original_title,title,excerpt,published_at,discovered_at,state,category,body_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, item.url, source.id, source.name, source.tier, item.title, item.title, item.excerpt, published, now, source.free?.body ? "awaiting-body" : state, source.free?.category ?? "", source.free?.body ? "pending" : "not-fetched"));
    }
    if (statements.length) await env.DB.batch(statements);
    await env.DB.prepare("INSERT INTO source_health(id,name,checked_at,count,error,latest_published_at) VALUES(?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,count=excluded.count,error=NULL,latest_published_at=excluded.latest_published_at")
      .bind(source.id, source.name, now, candidates.length, candidates.map((c) => c.publishedAt).filter((d): d is string => !!d).sort().at(-1) ?? null).run();
  } catch (error) {
    await env.DB.prepare("INSERT INTO source_health(id,name,checked_at,error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,count=0,error=excluded.error")
      .bind(source.id, source.name, now, String(error).slice(0, 250)).run();
    throw error;
  }
}

export interface Analysis { title: string; summary: string; category: string; score: number; relevant: boolean }
export function hasSummaryEvidence(item: Pick<Item, "excerpt" | "original_title">): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return item.excerpt.trim().length >= 50 && normalize(item.excerpt) !== normalize(item.original_title);
}
export function parseAnalysis(raw: unknown): Analysis {
  const obj = raw as any;
  const text = typeof obj?.response === "string" ? obj.response : obj?.choices?.[0]?.message?.content;
  let value: any = obj;
  if (typeof text === "string") {
    const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    value = JSON.parse(clean);
  }
  if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 250 || typeof value.summary !== "string" || value.summary.length > 1200 || !Object.hasOwn(CATEGORIES, value.category) || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100 || typeof value.relevant !== "boolean") throw new Error("模型输出未通过校验");
  if (value.relevant && value.summary.trim().length < 12) throw new Error("摘要过短");
  return value;
}

export async function analyze(env: Env, id: string): Promise<void> {
  if (env.MODEL_CALLS_ENABLED !== "true") return;
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first<Item>();
  if (!item || item.state !== "pending") return;
  if (!hasSummaryEvidence(item)) {
    // A title alone is insufficient evidence for a generated summary or a selection score.
    await env.DB.prepare("UPDATE items SET state='source-only',summary='',ready_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
    return;
  }
  const receiptId = `summary-v1:${id}`;
  const existing = await env.DB.prepare("SELECT state,response FROM ai_receipts WHERE id=?").bind(receiptId).first<{ state: string; response: string | null }>();
  let response: unknown;
  if (existing?.response) response = JSON.parse(existing.response);
  else if (existing) {
    await env.DB.prepare("UPDATE items SET state='failed' WHERE id=?").bind(id).run();
    return; // A request with unknown outcome is never automatically bought again.
  }
  else {
    const day = new Date().toISOString().slice(0, 10);
    const limit = Math.min(40, Math.max(0, Number(env.AI_DAILY_LIMIT) || 0));
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO ai_receipts(id,day,state,created_at) SELECT ?,?,'pending',? WHERE (SELECT count(*) FROM ai_receipts WHERE day=?) < ?")
      .bind(receiptId, day, new Date().toISOString(), day, limit).run();
    if (!claim.meta.changes) return;
    try {
      response = await env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
        messages: [
          { role: "system", content: FREE_SUMMARY_PROMPT },
          { role: "user", content: JSON.stringify({ source: item.source_name, title: item.original_title, materialScope: item.material_scope, excerpt: item.excerpt.slice(0, 4000) }) },
        ], max_tokens: 900, temperature: 0.2, response_format: { type: "json_object" },
      });
      // Save the provider response before parsing/writing publication state; retries reuse it.
      await env.DB.prepare("UPDATE ai_receipts SET state='received',response=? WHERE id=?").bind(JSON.stringify(response), receiptId).run();
    } catch (error) {
      await env.DB.prepare("UPDATE ai_receipts SET state='unknown',error=? WHERE id=?").bind(String(error).slice(0, 250), receiptId).run();
      await env.DB.prepare("UPDATE items SET state='failed' WHERE id=?").bind(id).run();
      return;
    }
  }
  try {
    const a = parseAnalysis(response);
    const threshold = SELECTION.thresholds[item.tier] ?? Infinity;
    const evidence = `${item.original_title} ${item.excerpt}`;
    for (const entity of IDENTITY_LEXICON) {
      // Global sources use “央行” generically; it does not identify the PBoC.
      const patterns = entity.id === "pbc" ? [/中国人民银行|人民银行|\bPBoC\b/i] : entity.patterns;
      if (patterns.some((p) => p.test(`${a.title} ${a.summary}`)) && !patterns.some((p) => p.test(evidence))) throw new Error(`摘要出现原材料中没有的机构：${entity.name}`);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE items SET title=?,summary=?,category=?,score=?,selected=?,state=?,ready_at=? WHERE id=?")
        .bind(a.title, a.summary, a.category, a.score, a.relevant && a.score >= threshold ? 1 : 0, a.relevant ? "ready" : "excluded", new Date().toISOString(), id),
      env.DB.prepare("UPDATE ai_receipts SET state='completed' WHERE id=?").bind(receiptId),
    ]);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("UPDATE ai_receipts SET state='invalid',error=? WHERE id=?").bind(String(error).slice(0, 250), receiptId),
      env.DB.prepare("UPDATE items SET state='failed' WHERE id=?").bind(id),
    ]);
  }
}

export async function composeDaily(env: Env, day: string): Promise<void> {
  const { start, end } = reportWindow(day);
  if (end > new Date().toISOString()) throw new Error("日报窗口尚未结束");
  const rows = await env.DB.prepare("SELECT id FROM items WHERE state='ready' AND selected=1 AND ready_at>=? AND ready_at<? ORDER BY score DESC,ready_at DESC LIMIT 30").bind(start, end).all<{ id: string }>();
  // Deterministic edition: no extra model call and no fabrication of an empty day's content.
  await env.DB.prepare("INSERT OR IGNORE INTO reports(date,item_ids,created_at) VALUES(?,?,?)").bind(day, JSON.stringify(rows.results.map((r) => r.id)), new Date().toISOString()).run();
}
