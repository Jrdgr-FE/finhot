import type { Env } from './types.ts';

// Keep the frontend same-origin. Only fixed routes reach the private backend; no client-chosen URLs.
export async function originResponse(request: Request,env:Env):Promise<Response|null> {
  if (!env.BACKEND_ORIGIN) return null;
  const url=new URL(request.url),path=url.pathname;
  const route=path==='/feed.xml'?'feed.xml':/^\/api\/(items|sources|reports(?:\/\d{4}-\d{2}-\d{2})?|health|feedback|admin\/status)$/.exec(path)?.[1];
  if (!route) return path.startsWith('/api/')?Response.json({error:'接口不存在'},{status:404}):null;
  const method=route==='feedback'?'POST':'GET';
  if (request.method!==method && !(method==='GET'&&request.method==='HEAD')) return Response.json({error:'不支持的请求方式'},{status:405});
  if (method==='POST'&&request.headers.get('origin')!==url.origin) return Response.json({error:'请通过本站反馈页提交'},{status:403});
  const origin=new URL(env.BACKEND_ORIGIN);
  if (origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!env.BACKEND_TOKEN) throw new Error('Backend is not configured');
  const headers=new Headers({ 'x-finhot-origin-token':env.BACKEND_TOKEN,'user-agent':request.headers.get('user-agent') ?? 'FinHotFrontend/1.0' });
  if (route==='admin/status') headers.set('authorization',request.headers.get('authorization') ?? '');
  if (method==='POST') {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({error:'需要 JSON 格式'},{status:415});
    headers.set('content-type','application/json');headers.set('x-finhot-client-ip',request.headers.get('cf-connecting-ip') ?? '');
  }
  let body:string|undefined;
  if (method==='POST') {
    const reader=request.body?.getReader();let bytes=0;const parts:Uint8Array[]=[];
    try { if (reader) while(true) { const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096)return Response.json({error:'提交内容过长'},{status:413});parts.push(value); } }
    finally { await reader?.cancel(); }
    const data=new Uint8Array(bytes);let at=0;for(const part of parts){data.set(part,at);at+=part.length;}body=new TextDecoder().decode(data);
  }
  const response=await fetch(`${origin.origin}/_edge/${route}${url.search}`,{ method,headers,body,redirect:'manual',signal:AbortSignal.timeout(15000) });
  if (response.status>=300&&response.status<400) { await response.body?.cancel();throw new Error('Backend redirected'); }
  const outHeaders=new Headers({ 'content-type':response.headers.get('content-type') ?? 'application/json','cache-control':'no-store' });
  if (response.headers.has('retry-after')) outHeaders.set('retry-after',response.headers.get('retry-after')!);
  return new Response(response.body,{status:response.status,headers:outHeaders});
}
