import type {D1Database} from '@cloudflare/workers-types';
export interface PublicCache {match(request:Request):Promise<Response|undefined>;put(request:Request,response:Response):Promise<void>;}
export function publicCacheSeconds(path:string):number {
  if(path==='/sitemap.xml')return 1800;
  if(path.startsWith('/articles/')||/^\/daily\/\d{4}-\d{2}-\d{2}$/.test(path))return 60;
  if(['/api/items','/api/sources','/api/reports','/feed.xml'].includes(path)||path.startsWith('/api/reports/')||/^\/feed\/[a-z]{1,20}\.xml$/.test(path))return 30;
  return 0;
}
export async function cachedPublicRead(request:Request,db:D1Database,cache:PublicCache|undefined,read:()=>Promise<Response>,privatePreview=false) {
  const url=new URL(request.url),ttl=publicCacheSeconds(url.pathname);
  if(privatePreview||request.method!=='GET'||!ttl||!cache)return read();
  const head=await db.prepare("SELECT generation FROM server_sync_state WHERE key='active'").first<{generation:string}>();
  if(!head)return read();
  // Every lookup reads the active pointer. A withdrawal immediately selects a different cache key.
  const key=(generation:string)=>{
    const u=new URL(request.url),params=new URLSearchParams();
    // Use the same first-value semantics as the query handler. Irrelevant parameters and duplicate
    // values must not let a caller multiply cache entries for an identical database query.
    if(u.pathname==='/api/items')for(const name of ['all','category','group','source','offset','q','catalog','from']){const value=u.searchParams.get(name);if(value!==null)params.set(name,value);}
    // The domain changes the answer of every list, report and daily page.
    if(u.pathname==='/api/items'||u.pathname.startsWith('/api/reports')||u.pathname.startsWith('/daily/')){const value=u.searchParams.get('domain');if(value!==null)params.set('domain',value);}
    if(u.pathname.startsWith('/articles/')||u.pathname.startsWith('/daily/'))params.set('lang',u.searchParams.get('lang')==='zh-CN'?'zh-CN':'en');
    params.sort();params.set('__finhot_generation',generation);u.search=params.toString();return new Request(u,{method:'GET'});
  };
  let hit:Response|undefined;
  try{hit=await cache.match(key(head.generation));}catch{/* Cache failure must not prevent a database read. */}
  if(hit){const headers=new Headers(hit.headers);headers.set('cache-control','no-store');headers.set('x-finhot-cache','HIT');return new Response(hit.body,{status:hit.status,headers});}
  const response=await read(),generation=response.headers.get('x-finhot-generation');
  if(response.status===200&&generation){
    const stored=response.clone(),headers=new Headers(stored.headers);headers.set('cache-control',`public, max-age=${ttl}`);
    try{await cache.put(key(generation),new Response(stored.body,{status:stored.status,headers}));}catch{/* Serving the result does not depend on caching it. */}
  }
  const headers=new Headers(response.headers);headers.set('x-finhot-cache','MISS');return new Response(response.body,{status:response.status,headers});
}
