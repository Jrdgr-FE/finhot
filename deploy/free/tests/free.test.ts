import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env, Source } from "../types.ts";
import { analyze, parseAnalysis, composeDaily, collect, dueSources, SOURCES } from "../pipeline.ts";
import { parseSource, reportWindow, boundedText } from "../parsers.ts";
import { freeItems, freeReports, freeRss } from "../../../packages/backend/src/publication/free.ts";
import worker from "../worker.ts";
import { hydrate, fetchBody, bodyUrl, BodyUnavailable } from "../body.ts";

let mf: Miniflare, env: Env, calls = 0;
const answer = { title: "测试宏观指标公布", summary: "公开材料显示本期指标出现变化，相关数据仍须结合统计口径核对。", category: "macro", score: 80, relevant: true };
before(async () => {
  const imports = `import {parseWebList,extractArticle} from ${JSON.stringify(fileURLToPath(new URL('../web-list.ts', import.meta.url)))}; import {extractPdf} from ${JSON.stringify(fileURLToPath(new URL('../body.ts', import.meta.url)))}; export default { async fetch(r) { if(new URL(r.url).pathname==='/pdf')return Response.json(await extractPdf(new Uint8Array(await r.arrayBuffer()))); const {source,body,selector} = await r.json(); return Response.json(selector?await extractArticle(body,selector):await parseWebList(source,body)); } };`;
  const bundle = await build({ stdin: { contents: imports, resolveDir: process.cwd() }, bundle: true, format: 'esm', external:['node:*'], write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-01", script: bundle.outputFiles[0].text, d1Databases: ["DB"] }));
  const DB = await mf.getD1Database("DB");
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")).split(";").filter((s) => s.trim())) await DB.prepare(sql).run();
  }
  env = { DB, AI: { run: async () => { calls++; return { response: JSON.stringify(answer) }; } }, TASKS: { send: async () => {} }, ASSETS: { fetch: async () => new Response("asset") }, ADMIN_PASSWORD: "test-password", SITE_URL: "https://test.local", PREVIEW_ONLY: "false", MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false", AI_DAILY_LIMIT: "2" } as unknown as Env;
});
beforeEach(async () => {
  for (const table of ["items", "reports", "ai_receipts", "feedback", "rate_limits", "source_health"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  calls = 0; env.PREVIEW_ONLY = "false"; env.MODEL_CALLS_ENABLED = "true"; env.COLLECT_ENABLED = "false";
});
after(async () => { await mf?.dispose(); });
async function item(id: string, excerpt = "已有足够的公开材料可以生成摘要。".repeat(8)) {
  await env.DB.prepare("INSERT INTO items(id,url,source_id,source_name,tier,original_title,title,excerpt,discovered_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, `https://example.com/${id}`, "test", "测试信源", "T1", "原标题", "原标题", excerpt, new Date().toISOString()).run();
}
test("RSS/Atom and JSON preserve timezone, plain text and safe links", () => {
  const source: Source = { id: "s", name: "s", kind: "rss", tier: "T1", config: { publishedAtUtcOffset: "+08:00" } };
  const rss = '<rss><item><title><![CDATA[报告 <b>标题</b>]]></title><link>https://example.com/a?a=1&amp;b=2</link><description>摘要 &lt;script&gt;</description><pubDate>2026-10-02 09:30:00</pubDate></item><item><title>unsafe</title><link>javascript:alert(1)</link></item></rss>';
  const rows = parseSource(source, rss); assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, "2026-10-02T01:30:00.000Z"); assert.equal(rows[0].title, "报告 标题"); assert.equal(rows[0].url, "https://example.com/a?a=1&b=2");
  const atom = '<feed><entry><title>Atom</title><link href="https://example.com/atom"/><summary>介绍</summary><updated>2026-10-02T09:30:00Z</updated></entry></feed>';
  assert.equal(parseSource(source, atom)[0].publishedAt, "2026-10-02T09:30:00.000Z");
  const json: Source = { ...source, kind: "json_list", config: { itemsPath: "data.items", titlePaths: ["title"], summaryPaths: ["text"], urlTemplate: "https://example.com/{id}", publishedAtPath: "time", publishedAtUtcOffset: "+08:00" } };
  assert.equal(parseSource(json, JSON.stringify({ data: { items: [{ id: "a/b", title: "title", time: "2026-10-02T09:30:00" }] } }))[0].url, "https://example.com/a%2Fb");
  assert.equal(parseSource(json, JSON.stringify({ data: { items: [{ id: "a", title: "title", time: "2026-10-02T09:30:00" }] } }))[0].publishedAt, "2026-10-02T01:30:00.000Z");
});
test("bounded reads and invalid model output are rejected", async () => {
  assert.equal(await boundedText(new Response("0123456789"), 4), "0123");
  assert.throws(() => parseAnalysis({ ...answer, score: NaN })); assert.throws(() => parseAnalysis({ ...answer, category: "made-up" }));
  assert.deepEqual(parseAnalysis({ choices: [{ message: { content: JSON.stringify(answer) } }] }), answer);
});
test("inference is idempotent and daily budget blocks the third request", async () => {
  for (const id of ["a", "b", "c"]) await item(id);
  await analyze(env, "a"); await analyze(env, "a"); await analyze(env, "b"); await analyze(env, "c");
  assert.equal(calls, 2); assert.equal((await env.DB.prepare("SELECT state FROM items WHERE id='c'").first())?.state, "pending");
  assert.equal((await freeItems(env)).items.length, 2);
});
test("concurrent duplicate delivery cannot claim the same inference twice", async () => {
  await item("duplicate"); await Promise.all([analyze(env, "duplicate"), analyze(env, "duplicate")]); assert.equal(calls, 1);
});
test("short evidence and disabled model never call AI", async () => {
  await item("short", "只有标题"); await analyze(env, "short"); assert.equal(calls, 0); assert.equal((await freeItems(env, { all: true })).items[0].state, "source-only");
  await item("disabled"); env.MODEL_CALLS_ENABLED = "false"; await analyze(env, "disabled"); assert.equal(calls, 0);
});
test("a feed description that repeats the headline is not summary evidence", async () => {
  await item("title-only", "This regulator has finalized a change to the regulatory framework.");
  await env.DB.prepare("UPDATE items SET original_title=excerpt WHERE id='title-only'").run();
  await analyze(env, "title-only"); assert.equal(calls, 0); assert.equal((await freeItems(env, { all: true })).items[0].state, "source-only");
});
test("unknown calls are not retried; saved responses recover without a second call", async () => {
  await item("unknown"); await env.DB.prepare("INSERT INTO ai_receipts VALUES(?,?,'unknown',NULL,NULL,?)").bind("summary-v1:unknown", "2026-01-01", new Date().toISOString()).run();
  await analyze(env, "unknown"); assert.equal(calls, 0);
  await item("saved"); await env.DB.prepare("INSERT INTO ai_receipts VALUES(?,?,'received',?,NULL,?)").bind("summary-v1:saved", "2026-01-01", JSON.stringify({ response: JSON.stringify(answer) }), new Date().toISOString()).run();
  await analyze(env, "saved"); assert.equal(calls, 0); assert.equal((await freeItems(env)).items.length, 1);
});
test("generic central banks are allowed but an invented named Chinese institution is withheld", async () => {
  for (const [id, summary] of [["generic", "各国央行代表出席国际会议，讨论银行监管及金融数字化。"], ["invented", "中国人民银行出席国际会议，讨论银行监管及金融数字化。"]]) {
    await item(id, "Almost 300 central bankers and banking supervisors attended a conference to discuss banking supervision and the digitalisation of finance.");
    await env.DB.prepare("INSERT INTO ai_receipts VALUES(?,?,'received',?,NULL,?)").bind(`summary-v1:${id}`, "2026-01-01", JSON.stringify({ response: JSON.stringify({ ...answer, summary }) }), new Date().toISOString()).run();
    await analyze(env, id);
  }
  assert.equal(calls, 0); const data = await freeItems(env); assert.equal(data.items.length, 1); assert.equal(data.items[0].id, "generic");
});
test("publication hides raw excerpts and pending, failed and excluded items", async () => {
  for (const id of ["pending", "failed", "excluded", "ready"]) { await item(id); await env.DB.prepare("UPDATE items SET state=?, selected=1 WHERE id=?").bind(id, id).run(); }
  const data = await freeItems(env); assert.equal(data.items.length, 1); assert.equal(data.items[0].id, "ready"); assert.ok(!("excerpt" in data.items[0]));
  await env.DB.prepare("UPDATE items SET summary='<script>&unsafe' WHERE id='ready'").run();
  const rss = await freeRss(env, "https://test.local"); assert.ok(rss.includes("&lt;script&gt;&amp;unsafe")); assert.ok(!rss.includes("<script>"));
  assert.equal((await freeItems(env, { search: "%' OR 1=1 --" })).items.length, 0);
  await env.DB.prepare("UPDATE items SET title='UNVALIDATED',summary='PRIVATE' WHERE id='pending'").run();
  const all = (await freeItems(env, { all: true })).items;
  assert.equal(all.length, 2); const pending = all.find(i=>i.id==='pending')!;
  assert.equal(pending.title, '原标题'); assert.equal(pending.summary, ''); assert.ok(!('excerpt' in pending));
  assert.equal((await freeItems(env, { all:true, search:'PRIVATE' })).items.length, 0);
  assert.equal((await freeItems(env, { all:true, sourceIds:[] })).items.length, 0);
  assert.equal((await freeItems(env, { all:true, sourceIds:['test'] })).items.length, 2);
});

test('duplicates are removed before the twenty-item cap and report attribution is retained', () => {
  const source = SOURCES.find(s=>s.id==='eastmoney-research-0')!;
  const rows = Array.from({length:25},(_,i)=>({infoCode:String(i),title:'公司业绩研究',stockName:'测试公司',orgName:'测试证券',publishDate:'2026-10-02 00:00:00.000'}));
  const result = parseSource(source, JSON.stringify({data:[rows[0],rows[0],...rows]}));
  assert.equal(result.length,20); assert.equal(new Set(result.map(r=>r.url)).size,20);
  assert.equal(result[0].title,'测试公司 · 测试证券 · 公司业绩研究');
  assert.equal(result[0].publishedAt,'2026-10-01T16:00:00.000Z');
});

test('native HTML parser extracts exchange dates and dated media URLs without executing scripts', async () => {
  const parse = async (source: Source, body: string) => (await mf.dispatchFetch('http://test.local', {method:'POST',body:JSON.stringify({source,body})})).json() as Promise<any[]>;
  const sse = SOURCES.find(s=>s.id==='sse-market-news')!;
  const rows = await parse(sse,'<dl><dd><span>2026-10-02</span><a href="/aboutus/mediacenter/hotandd/c/test.shtml">市场<b>报告</b></a></dd><dd><span>2026-10-02</span><a href="https://other.invalid">菜单</a></dd></dl>');
  assert.equal(rows.length,1);assert.equal(rows[0].title,'市场报告');assert.ok(!rows[0].url.endsWith('#'));assert.equal(rows[0].publishedAt,'2026-10-01T16:00:00.000Z');
  const media = await parse(SOURCES.find(s=>s.id==='21jingji-capital')!, '<div class="news"><a href="https://m.21jingji.com/article/20261002/herald/test.html"><div class="title"><h2>市场研究</h2><p>已有材料</p><span>3小时前</span></div></a><a href="https://m.21jingji.com/article/20261001/herald/second.html"><div class="title"><h2>第二篇研究</h2><p>另一材料</p></div></a></div>');
  assert.equal(media.length,2);assert.equal(media[0].title,'市场研究');assert.equal(media[0].publishedAt,'2026-10-01T16:00:00.000Z');assert.equal(media[0].excerpt,'已有材料');
});

test('collection posts a public form, batches records and publishes titles without model calls', async (t) => {
  env.COLLECT_ENABLED='true'; let requests=0;
  t.mock.method(globalThis,'fetch',async (_url: unknown, init: RequestInit)=>{requests++;assert.equal(init.method,'POST');assert.ok(String(init.body).includes('category='));return Response.json({announcements:[{secName:'测试公司',secCode:'000001',announcementTitle:'回购进展公告',adjunctUrl:'finalpage/test.PDF',announcementTime:Date.now()-3600000}]});});
  await collect(env,'cninfo-company');await collect(env,'cninfo-company');
  assert.equal(requests,2);assert.equal(calls,0);const all=(await freeItems(env,{all:true})).items;
  assert.equal(all.length,1);assert.equal(all[0].state,'awaiting-body');assert.match(all[0].title!,/测试公司/);
  assert.equal((await env.DB.prepare('SELECT count FROM source_health').first())?.count,1);
});

test('due scheduling respects per-source intervals and drains all overdue sources fairly',()=>{
  const now=Date.now(),health:{id:string;checked_at:string}[]=[];const seen=new Set<string>();
  for(let n=0;n<Math.ceil(SOURCES.length/4);n++){const due=dueSources(health,now);assert.ok(due.length<=4);for(const s of due){assert.ok(!seen.has(s.id));seen.add(s.id);health.push({id:s.id,checked_at:new Date(now).toISOString()});}}
  assert.equal(seen.size,SOURCES.length);assert.equal(dueSources(health,now+29*60000).length,0);
  assert.ok(dueSources(health,now+30*60000).every(s=>s.interval_minutes===30));
});

test('scheduler stops enqueueing inference when the daily budget is exhausted',async(t)=>{
  const tasks:any[]=[];t.mock.method(env.TASKS,'send',async(task:any)=>{tasks.push(task);});
  await item('a');await item('b');await analyze(env,'a');await analyze(env,'b');await item('pending');
  await worker.scheduled({scheduledTime:Date.now(),cron:'*/10 * * * *'} as any,env);
  assert.ok(tasks.every(task=>task.kind!=='analyze'));
  assert.equal((await worker.fetch(new Request('https://test.local/api/items?group=invalid'),env)).status,400);
});

test('article extraction omits scripts and navigation and separates paragraphs', async()=>{
  const r=await mf.dispatchFetch('http://test.local/article',{method:'POST',body:JSON.stringify({selector:'#article',body:'<nav>外部导航</nav><div id="article"><p>收入增长10%。</p><script>EVIL_SCRIPT</script><aside>EVIL_ASIDE</aside><p>净利润为20亿元。</p><table><tr><td>利润</td><td>20</td></tr></table></div>'})});
  const text=await r.json();assert.match(text as string,/收入增长10%。 净利润为20亿元。/);assert.ok(!(text as string).includes('EVIL'));assert.ok(!(text as string).includes('外部导航'));
});

test('body URL guard rejects private targets and redirects outside the known source', async(t)=>{
  const source=SOURCES.find(s=>s.id==='sse-market-news')!;
  assert.throws(()=>bodyUrl(source,'http://127.0.0.1/'),BodyUnavailable);
  assert.throws(()=>bodyUrl(source,'https://www.sse.com.cn.evil.invalid/aboutus/mediacenter/hotandd/c/1'),BodyUnavailable);
  let n=0;t.mock.method(globalThis,'fetch',async()=>{n++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}});});
  await assert.rejects(fetchBody(source,'https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/test.shtml'),BodyUnavailable);assert.equal(n,1);
});

test('body hydration is idempotent, improves evidence and never calls the model itself',async()=>{
  env.COLLECT_ENABLED='true';await item('body','');await env.DB.prepare("UPDATE items SET source_id='21jingji-company',state='awaiting-body' WHERE id='body'").run();
  let n=0;const fetcher=async()=>{n++;return{text:'测试公司营业收入增长20%，经营现金流为5亿元。'.repeat(8),scope:'公开正文片段'};};
  await Promise.all([hydrate(env,SOURCES,'body',fetcher),hydrate(env,SOURCES,'body',fetcher)]);await hydrate(env,SOURCES,'body',fetcher);
  assert.equal(n,1);assert.equal(calls,0);const row=await env.DB.prepare("SELECT state,body_status,body_length,excerpt FROM items WHERE id='body'").first<any>();
  assert.equal(row.state,'pending');assert.equal(row.body_status,'fetched');assert.ok(row.body_length>100);assert.ok(row.excerpt.includes('现金流'));
  const publicRow=(await freeItems(env,{all:true})).items[0];assert.ok(!('excerpt' in publicRow));
});

test('body failures preserve source links and budget exhaustion has a separate public signal',async()=>{
  env.COLLECT_ENABLED='true';await item('failure','');await env.DB.prepare("UPDATE items SET source_id='21jingji-company',state='awaiting-body' WHERE id='failure'").run();
  await hydrate(env,SOURCES,'failure',async()=>{throw new BodyUnavailable('failed','HTTP 403');});
  const row=(await freeItems(env,{all:true})).items[0];assert.equal(row.state,'source-only');assert.equal(row.body_status,'failed');assert.ok(row.url);assert.ok(!('body_error' in row));
  await item('a');await item('b');await analyze(env,'a');await analyze(env,'b');assert.equal((await freeItems(env,{all:true})).summaryBudgetReached,true);
});

test('a body task interrupted for thirty minutes does not stay in the fetching state forever',async(t)=>{
  env.COLLECT_ENABLED='true';env.MODEL_CALLS_ENABLED='false';t.mock.method(env.TASKS,'send',async()=>{});
  await item('interrupted','');await env.DB.prepare("UPDATE items SET state='awaiting-body',body_status='pending',body_attempts=1,body_checked_at=? WHERE id='interrupted'").bind(new Date(Date.now()-3600000).toISOString()).run();
  await worker.scheduled({scheduledTime:Date.now(),cron:'*/10 * * * *'} as any,env);
  const row=(await freeItems(env,{all:true})).items[0];assert.equal(row.state,'source-only');assert.equal(row.body_status,'failed');assert.equal(calls,0);
});

test('native PDF extraction limits page range and rejects oversized downloads',async(t)=>{
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>'];
  for(let i=0;i<4;i++){const content=`BT /F1 12 Tf 72 700 Td (Page ${i+1} sample public disclosure and financial facts.) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 11 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);}
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF`;
  const response=await mf.dispatchFetch('http://test.local/pdf',{method:'POST',body:pdf});const raw=await response.text();assert.equal(response.status,200,raw);const result=JSON.parse(raw);
  assert.ok(result.text.includes('Page 1'));assert.ok(result.text.includes('Page 3'));assert.ok(!result.text.includes('Page 4'));assert.match(result.scope,/前 3 页（共 4 页）/);
  t.mock.method(globalThis,'fetch',async()=>new Response(new Uint8Array(1000001),{headers:{'content-type':'application/pdf'}}));
  await assert.rejects(fetchBody(SOURCES.find(s=>s.id==='cninfo-company')!,'https://static.cninfo.com.cn/finalpage/test.PDF'),(e:any)=>e.status==='too-large');
});
test("daily uses Beijing 08:00 cutoff and excludes future arrivals", async () => {
  const w = reportWindow("2026-01-02"); assert.deepEqual(w, { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }); assert.throws(() => reportWindow("2026-02-31"));
  for (const [id, time] of [["in", w.start], ["out", w.end]]) { await item(id); await env.DB.prepare("UPDATE items SET selected=1,state='ready',ready_at=? WHERE id=?").bind(time, id).run(); }
  await composeDaily(env, "2026-01-02"); await composeDaily(env, "2026-01-02");
  const report = await freeReports(env, "2026-01-02") as any; assert.equal(report.items.length, 1); assert.equal(report.items[0].id, "in");
  await assert.rejects(composeDaily(env, "2099-01-01"));
});
test("admin and private preview require auth; public reads never call models", async () => {
  assert.equal((await worker.fetch(new Request("https://test.local/api/admin/status"), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://test.local/api/items"), env)).status, 200); assert.equal(calls, 0);
  env.PREVIEW_ONLY = "true";
  assert.equal((await worker.fetch(new Request("https://test.local/"), env)).status, 401);
  const r = await worker.fetch(new Request("https://test.local/api/items", { headers: { authorization: "Bearer test-password" } }), env);
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "private,no-store");
});
test("feedback rejects cross-site writes, oversized bodies and sixth hourly submission", async () => {
  const make = (origin = "https://test.local", message = "请检查这篇文章的统计数据与发布时间。") => new Request("https://test.local/api/feedback", { method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" }, body: JSON.stringify({ message }) });
  assert.equal((await worker.fetch(make("https://other.local"), env)).status, 403);
  assert.equal((await worker.fetch(make("https://test.local", "a".repeat(5000)), env)).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(make(), env)).status, 201);
  assert.equal((await worker.fetch(make(), env)).status, 429);
});
