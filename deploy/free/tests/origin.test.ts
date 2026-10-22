import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker.ts';
import { originResponse } from '../origin.ts';
import type { Env } from '../types.ts';

const env={ BACKEND_ORIGIN:'https://backend.example',BACKEND_TOKEN:'server-only-test-token',ADMIN_PASSWORD:'test-password',PREVIEW_ONLY:'false',ASSETS:{fetch:async()=>new Response('frontend asset')} } as unknown as Env;
test('static pages stay at Cloudflare; only fixed paths reach the server and secrets stay server-side',async t=>{
  const calls:any[]=[];
  t.mock.method(globalThis,'fetch',async(url:any,init:any)=>{calls.push({url,init});return Response.json({items:[]},{headers:{'set-cookie':'private=1','x-finhot-origin-token':'must-not-leak'}});});
  const asset=await worker.fetch(new Request('https://finhot.fun/all?group=research'),env);
  assert.equal(await asset.text(),'frontend asset');assert.equal(calls.length,0);
  const api=await worker.fetch(new Request('https://finhot.fun/api/items?group=research&offset=20',{headers:{'x-finhot-origin-token':'attacker','cookie':'visitor-cookie'}}),env);
  assert.equal(api.status,200);assert.equal(calls[0].url,'https://backend.example/_edge/items?group=research&offset=20');
  assert.equal(calls[0].init.headers.get('x-finhot-origin-token'),env.BACKEND_TOKEN);
  assert.equal(calls[0].init.headers.get('cookie'),null);assert.equal(api.headers.get('set-cookie'),null);assert.equal(api.headers.get('x-finhot-origin-token'),null);
  assert.equal((await worker.fetch(new Request('https://finhot.fun/api/admin/status'),env)).status,401);
  assert.equal((await worker.fetch(new Request('https://finhot.fun/api/admin/run'),env)).status,401);
});
test('backend failures do not fall back to a second database, redirect credentials or invoke models',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{location:'https://other.example'}}));
  assert.equal((await worker.fetch(new Request('https://finhot.fun/api/items'),env)).status,503);
  assert.equal(await originResponse(new Request('https://finhot.fun/about'),env),null);
  assert.equal((await worker.fetch(new Request('https://finhot.fun/api/unknown'),env)).status,404);
});
test('feedback enforces same-origin, size and content type before forwarding',async t=>{
  let sent=0;t.mock.method(globalThis,'fetch',async()=>{sent++;return Response.json({accepted:true},{status:201});});
  const req=(origin:string,body:string,type='application/json')=>new Request('https://finhot.fun/api/feedback',{method:'POST',headers:{origin,'content-type':type},body});
  assert.equal((await worker.fetch(req('https://evil.example','{}'),env)).status,403);
  assert.equal((await worker.fetch(req('https://finhot.fun','x'.repeat(4097)),env)).status,413);
  assert.equal((await worker.fetch(req('https://finhot.fun','{}','text/plain'),env)).status,415);
  assert.equal(sent,0);assert.equal((await worker.fetch(req('https://finhot.fun','{"message":"问题说明足够长的内容"}'),env)).status,201);assert.equal(sent,1);
});
test('hybrid mode does not schedule or consume the old Cloudflare collection pipeline',async()=>{
  await worker.scheduled({cron:'*/10 * * * *',scheduledTime:Date.now()} as any,env);
  let acknowledged=0;
  await worker.queue({messages:[{body:{kind:'analyze',id:'old'},ack:()=>acknowledged++}]} as any,env);
  assert.equal(acknowledged,1);
});
