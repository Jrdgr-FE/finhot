export interface RequestLimiter {limit(options:{key:string}):Promise<{success:boolean}>;}

export async function limited(request:Request,limiter:RequestLimiter|undefined,kind:string):Promise<Response|undefined>{
  // Anonymous readers have no account ID. Bound bursts by the address supplied by Cloudflare,
  // with generous public limits for readers sharing a network. Never trust X-Forwarded-For.
  if(!limiter)return Response.json({error:'安全限速暂时不可用，请稍后重试'},{status:503,headers:{'cache-control':'no-store'}});
  const ip=request.headers.get('cf-connecting-ip')??'unknown';
  if(!(await limiter.limit({key:kind+':'+ip})).success)return Response.json({error:'请求较频繁，请一分钟后重试'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});
}

export function secureHeaders(headers:Headers,https:boolean){
  headers.set('x-content-type-options','nosniff');
  headers.set('x-frame-options','DENY');
  headers.set('referrer-policy','strict-origin-when-cross-origin');
  headers.set('permissions-policy','camera=(), microphone=(), geolocation=()');
  if(https)headers.set('strict-transport-security','max-age=86400');
}
