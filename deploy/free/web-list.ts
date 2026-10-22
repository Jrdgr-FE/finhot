import type { HTMLRewriter as Rewriter, Element, Text } from "@cloudflare/workers-types";
import type { Source } from "./types.ts";
import { plain, safeUrl, sourceDate, finishCandidates, type Candidate } from "./parsers.ts";

declare const HTMLRewriter: { new(): Rewriter };

// Native streaming parser; no script execution or browser automation.
export async function parseWebList(source: Source, body: string): Promise<Candidate[]> {
  const c = source.config, rows: Candidate[] = [];
  let current: { url: string; title: string; excerpt: string; date: string } | undefined;
  const rewrite = new HTMLRewriter().on(c.itemSelector, {
    element(element: Element) {
      const row = { url: "", title: "", excerpt: "", date: "" };
      current = row;
      if (element.tagName === "a") {
        try { row.url = safeUrl(new URL(element.getAttribute("href") ?? "", c.baseUrl ?? c.url).href) ?? ""; } catch { /* malformed link */ }
      }
      element.onEndTag(() => {
        if (current === row) current = undefined;
        if (!row.url || !plain(row.title)) return;
        const day = source.free?.dateFromUrl ? /\/article\/(\d{4})(\d{2})(\d{2})\//.exec(row.url) : null;
        rows.push({ url: row.url, title: plain(row.title).slice(0, 500), excerpt: plain(row.excerpt).slice(0, 5000), publishedAt: sourceDate(day ? `${day[1]}-${day[2]}-${day[3]}` : plain(row.date), c) });
      });
    },
  }).on(`${c.itemSelector} ${c.linkSelector}`, {
    element(element: Element) {
      if (!current || current.url) return;
      try { current.url = safeUrl(new URL(element.getAttribute("href") ?? "", c.baseUrl ?? c.url).href) ?? ""; } catch { /* malformed link */ }
    },
  });
  for (const [selector, field] of [[c.titleSelector, "title"], [c.publishedAtSelector, "date"], [source.free?.summarySelector, "excerpt"]] as const) {
    if (selector) rewrite.on(`${c.itemSelector} ${selector}`, { text(chunk: Text) { if (current && current[field].length < 6000) current[field] += chunk.text; } });
  }
  // Types in the Workers and DOM libraries describe the same runtime Response differently.
  await rewrite.transform(new Response(body) as never).text();
  return finishCandidates(source, rows);
}

export async function extractArticle(body: string, selector: string): Promise<string> {
  let text = "", ignored = 0;
  const rewriter = new HTMLRewriter().on(selector, {
    text(chunk: Text) { if (!ignored && text.length < 12000) text += chunk.text; },
  });
  for (const tag of ["script", "style", "nav", "aside", "form", "noscript"]) {
    rewriter.on(`${selector} ${tag}`, { element(element: Element) { ignored++; element.onEndTag(() => { ignored--; }); } });
  }
  for (const tag of ["p", "li", "h2", "h3", "tr", "td", "br"]) {
    rewriter.on(`${selector} ${tag}`, { element() { if (!ignored && text.length < 12000) text += "\n"; } });
  }
  await rewriter.transform(new Response(body) as never).text();
  return plain(text).slice(0, 12000);
}
