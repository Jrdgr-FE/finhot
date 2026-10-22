// Import stored material and already public summaries. No model or collector is called.
import { readFileSync } from "node:fs";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial,identityKeyFor } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";

interface ImportedItem {
  id: string; source_id: string; url: string; original_title: string; title: string;
  excerpt: string; summary: string; category: string; selected: number; score: number | null;
  published_at: string | null; discovered_at: string; state: string; body_status: string; material_scope: string;
}
const source = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const rows: ImportedItem[] = Array.isArray(source[0]?.results) ? source[0].results : source;
if (!Array.isArray(rows) || rows.length > 10000) throw new Error("Invalid import snapshot");
const sources = new Set((await sql<{ id: string }[]>`SELECT id FROM sources`).map(s => s.id));
const categories = new Set<string>(CATEGORIES.map(c => c.key));
let imported = 0, summarized = 0,preserved=0;
try {
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.id) || !sources.has(row.source_id) || !/^https?:\/\//.test(row.url)) throw new Error("Invalid import identity");
    const identity=identityKeyFor({sourceId:row.source_id,url:row.url,title:row.original_title,via:'import'});
    const [existing]=await sql`SELECT a.id FROM articles a WHERE a.identity_key=${identity}
      AND (a.body_status='ok' OR EXISTS(SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.prompt_version IS DISTINCT FROM 'free-summary-v1/imported'))`;
    // A final Cloudflare snapshot must not replace a body or judgement already improved on ECS.
    if(existing){preserved++;continue;}
    const pdf = /^PDF 前 (\d+) 页（共 (\d+) 页）/.exec(row.material_scope ?? "");
    const material = await upsertMaterial({
      id: row.id, sourceId: row.source_id, url: row.url, title: row.original_title,
      language: /[一-鿿]/.test(row.original_title) ? "zh" : "en",
      publishedAt: row.published_at ? new Date(row.published_at) : null,
      discoveredAt: new Date(row.discovered_at), excerpt: row.excerpt,
      // The free edition stored fragments, so never label them as a confirmed complete body.
      bodyText: row.body_status === "fetched" ? row.excerpt : null,
      bodyStatus: row.body_status === "fetched" ? "unconfirmed" : "pending", via: "import",
      raw: { importedFrom: "finhot-free", materialScope: row.material_scope, previousState: row.state },
    });
    await sql`UPDATE articles SET material_scope=${row.material_scope ?? ''} WHERE id=${material.articleId} AND body_status<>'ok'`;
    imported++;
    if (row.state !== "ready" || !row.summary?.trim() || !row.title?.trim() || !categories.has(row.category)) {await publishArticle(material.articleId);continue;}
    await sql.begin(async tx => {
      const key = `import:finhot-free:${row.id}`;
      const [receipt] = await tx<{ id: number }[]>`
        INSERT INTO receipts(logical_key,service,model,purpose,subject,status,origin,response,completed_at)
        VALUES(${key},'cloudflare-ai','@cf/qwen/qwen3-30b-a3b-fp8','import_existing_summary',${material.articleId},'completed','imported',
          ${tx.json({ title: row.title, summary: row.summary, selected: !!row.selected, score: row.score } as never)},now())
        ON CONFLICT(logical_key) DO UPDATE SET logical_key=EXCLUDED.logical_key RETURNING id`;
      if (!(await tx`SELECT id FROM analyses WHERE article_id=${material.articleId} AND prompt_version='free-summary-v1/imported'`).length) {
        const [article] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${material.articleId}`;
        const summary = row.summary + (pdf ? `（摘要依据：PDF 前 ${pdf[1]}/${pdf[2]} 页片段。）` : "");
        await tx`
          INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,receipt_ids,relevance,category,title_zh,summary_zh,reason_zh,score,selected,output)
          VALUES(${material.articleId},${article!.revision},'model','@cf/qwen/qwen3-30b-a3b-fp8','free-summary-v1/imported',${[receipt!.id]},'pass',${row.category},
            ${row.title},${summary},${row.selected ? "历史免费版精选，单次模型判断" : null},${row.score},${!!row.selected},
            ${tx.json({ importedFrom: "finhot-free", selectionMethod: "single-pass", materialScope: row.material_scope } as never)})`;
      }
      await tx`UPDATE articles SET processing_state='analyzed' WHERE id=${material.articleId}`;
    });
    await publishArticle(material.articleId, { releasedAt: new Date(row.discovered_at) });
    summarized++;
  }
  console.log(JSON.stringify({ imported, summarized,preserved,modelCalls: 0 }));
} finally { await closeDb(); }
