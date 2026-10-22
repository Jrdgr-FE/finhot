import type { Env, Item, Source } from "./types.ts";
import { boundedText, safeUrl } from "./parsers.ts";
import { extractArticle } from "./web-list.ts";

export class BodyUnavailable extends Error {
  status: string;
  constructor(status: string, message: string) { super(message); this.status = status; }
}
export function bodyUrl(source: Source, raw: string): string {
  const url = safeUrl(raw);
  if (!url || !source.free?.body?.urlPrefixes.some((p) => url.startsWith(p))) throw new BodyUnavailable("failed", "原文地址不在该信源的正文采集范围");
  return url;
}
async function binary(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new BodyUnavailable("too-large", "PDF 超过免费版单篇 1 MB 解析上限");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function extractPdf(data: Uint8Array): Promise<{ text: string; scope: string }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data, { useSystemFonts: false, disableFontFace: true });
  let text = ""; const pages = Math.min(3, pdf.numPages);
  try {
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n), content = await page.getTextContent();
      text += content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("") + "\n";
      page.cleanup(); if (text.length >= 12000) break;
    }
    return { text: text.replace(/\s+/g, " ").trim().slice(0, 12000), scope: `PDF 前 ${pages} 页（共 ${pdf.numPages} 页），最多 12,000 字符` };
  } finally { await pdf.loadingTask.destroy(); }
}
export async function fetchBody(source: Source, raw: string): Promise<{ text: string; scope: string }> {
  let url = bodyUrl(source, raw), response: Response | undefined;
  for (let n = 0; n < 4; n++) {
    response = await fetch(url, { redirect: "manual", headers: { "user-agent": "FinHotBot/1.0", accept: "text/html,application/pdf" }, signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new BodyUnavailable("failed", "原文重定向缺少地址");
      url = bodyUrl(source, new URL(location, url).href); response = undefined; continue;
    }
    break;
  }
  if (!response) throw new BodyUnavailable("failed", "原文重定向次数过多");
  if (!response.ok) { await response.body?.cancel(); throw new BodyUnavailable("failed", `原文 HTTP ${response.status}`); }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/pdf") || /\.pdf(?:\?|$)/i.test(url)) {
    if (!source.free?.body?.pdf) { await response.body?.cancel(); throw new BodyUnavailable("pdf", "此来源的 PDF 尚未接入解析"); }
    const text = await extractPdf(await binary(response, 1000000));
    if (text.text.length < 100) throw new BodyUnavailable("no-text", "PDF 未提取到足够文字，可能是扫描件");
    return text;
  }
  if (!source.free?.body?.selector || !/text\/html|application\/xhtml/i.test(type)) { await response.body?.cancel(); throw new BodyUnavailable("failed", "原文不是支持的 HTML 页面"); }
  const text = await extractArticle(await boundedText(response, 512000), source.free.body.selector);
  if (text.length < 100) throw new BodyUnavailable("failed", "未解析到足够正文，可能受限或页面结构已变化");
  return { text, scope: "公开网页正文片段，最多 12,000 字符" };
}
export async function hydrate(env: Env, sources: Source[], id: string, fetcher = fetchBody): Promise<void> {
  if (env.COLLECT_ENABLED !== "true") return;
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first<Item>();
  if (!item || !["pending", "source-only", "awaiting-body"].includes(item.state) || item.body_status === "fetched" || item.body_attempts >= 2) return;
  if (item.body_checked_at && Date.now() - Date.parse(item.body_checked_at) < 86400000) return;
  if (await env.DB.prepare("SELECT id FROM ai_receipts WHERE id=?").bind(`summary-v1:${id}`).first()) return;
  const source = sources.find((s) => s.id === item.source_id); if (!source?.free?.body) return;
  const claimed = await env.DB.prepare("UPDATE items SET body_attempts=body_attempts+1,body_checked_at=?,body_status='pending',state='awaiting-body' WHERE id=? AND body_attempts=? AND NOT EXISTS(SELECT 1 FROM ai_receipts WHERE id='summary-v1:'||items.id) RETURNING id")
    .bind(new Date().toISOString(), id, item.body_attempts).first(); if (!claimed) return;
  try {
    const result = await fetcher(source, item.url);
    await env.DB.prepare("UPDATE items SET excerpt=?,body_status='fetched',body_length=?,body_error=NULL,material_scope=?,state='pending' WHERE id=?")
      .bind(result.text, result.text.length, result.scope, id).run();
  } catch (error) {
    const status = error instanceof BodyUnavailable ? error.status : "failed";
    const evidence = item.excerpt.trim().length >= 50 && item.excerpt !== item.original_title;
    await env.DB.prepare("UPDATE items SET body_status=?,body_error=?,state=? WHERE id=?")
      .bind(status, String(error).slice(0, 250), evidence ? "pending" : "source-only", id).run();
  }
}
