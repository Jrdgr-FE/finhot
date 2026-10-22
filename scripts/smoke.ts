// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";

const at = process.argv.indexOf("--base");
const base = (at > 0 ? process.argv[at + 1] : process.env.SITE_URL) ?? "http://localhost:3000";
const editionAt=process.argv.indexOf('--edition');
if(editionAt>0&&process.argv[editionAt+1]==='server-sync'){
  let failed=0;
  const items=await fetch(base+'/api/items').then(r=>r.json()) as {items:Array<{id:string;summary?:string}>};
  const reports=await fetch(base+'/api/reports').then(r=>r.json()) as {reports:Array<{date:string}>};
  const article=items.items?.find(i=>i.summary)?.id;
  const daily=reports.reports?.[0]?.date;
  const paths=['/','/all?group=company','/all?group=research','/daily','/about','/terms','/privacy','/feedback','/admin','/api/health','/api/items','/api/items?all=1','/api/sources','/api/reports','/feed.xml','/robots.txt','/llms.txt','/sitemap.xml','/app.js','/style.css'];
  if(article)paths.push('/articles/'+encodeURIComponent(article));
  if(daily)paths.push('/daily/'+daily);
  for(const path of paths){
    try{
      const r=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(20000)});
      const body=await r.text();let valid=r.status===200;
      if(path.startsWith('/api/')){const d=JSON.parse(body);valid&&=!d.error;if(path==='/api/health')valid&&=d.edition==='server-sync'&&!d.stale;}
      else if(path==='/feed.xml')valid&&=body.includes('<rss')&&r.headers.get('content-type')?.includes('xml')===true;
      else if(path==='/sitemap.xml')valid&&=body.includes('<urlset')&&(!article||body.includes('/articles/'+article));
      else if(path==='/app.js'||path==='/style.css')valid&&=r.headers.get('x-finhot-asset')==='direct';
      else if(path.startsWith('/articles/')||/^\/daily\/\d{4}-\d{2}-\d{2}$/.test(path))valid&&=body.includes('rel="canonical"')&&!body.includes('src="/app.js"');
      else valid&&=body.includes('FinHot')||path==='/robots.txt';
      console.log(`${valid?'✓':'✗'} ${path} (${r.status})`);if(!valid)failed++;
    }catch{console.log(`✗ ${path}`);failed++;}
  }
  console.log(failed?`${failed} check(s) failed`:'all server-sync checks passed');process.exit(failed?1:0);
}

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
// The leaderboard pages answer 503 until the first round is published (a fresh site computes it when
// the worker starts; with collection off there is nothing to compute).
const LEADERBOARD = FEATURES.leaderboard ? ["/leaderboard", "/leaderboard/rules", "/leaderboard/sources"] : [];
PAGES.push(...LEADERBOARD);
if (FEATURES.codexResetMonitor) PAGES.push("/codex-reset");

let failed = 0;
async function check(path: string, expect: (res: Response, body: string) => string | null) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    if (res.status === 503 && LEADERBOARD.includes(path)) {
      console.log(`– ${path}  no leaderboard round published yet`);
      return;
    }
    const problem = res.status !== 200 ? `HTTP ${res.status}` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

for (const path of PAGES) await check(path, (_res, body) => (body.includes(SITE.name) ? null : `the page does not name ${SITE.name}`));
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));
// MCP: the handshake answers with the site's server name.
const mcp = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }),
}).then((r) => r.text()).catch((e) => String(e));
const mcpOk = mcp.includes(`"name":"${SITE.mcpPrefix}"`);
console.log(`${mcpOk ? "✓" : "✗"} /api/mcp initialize${mcpOk ? "" : `  ${mcp.slice(0, 200)}`}`);
if (!mcpOk) failed += 1;

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
