// Run on ECS only. No collector, model provider, raw body or receipt payload enters this upload.
import { readFile,writeFile,rename,mkdir,unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { edgeSnapshot } from '../../packages/backend/src/publication/edge.ts';
import { closeDb } from '../../packages/backend/src/db.ts';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function pushSnapshot(snapshot:any,options:{url:string;token:string;stateFile:string;fetcher?:typeof fetch}) {
  const target=new URL(options.url);if(target.protocol!=='https:'||target.username||target.password||target.pathname!=='/'||target.search||options.token.length<32)throw new Error('Invalid sync configuration');
  const fetcher=options.fetcher??fetch;
  async function call(path:string,body?:unknown){
    const r=await fetcher(new URL('/_sync/'+path,target),{method:body?'POST':'GET',headers:{authorization:'Bearer '+options.token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!r.ok){await r.body?.cancel();throw new Error(`Sync ${path.split('?')[0]} returned HTTP ${r.status}`);}
    return r.json() as Promise<any>;
  }
  const pendingFile=options.stateFile+'.pending';
  async function save(file:string,value:unknown){
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const temp=file+'.'+randomUUID();await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);
  }
  type Pending={begin:any;chunks:any[][];uploaded:number;state:any;result:any;failures:number;retryAt:number;startedAt:number};
  async function finish(p:Pending,head:string){
    if(head===p.begin.generation){await save(options.stateFile,p.state);await unlink(pendingFile);return {...p.result,recovered:true};}
    try{
      // Server staging expires after 24h. Renew an old interrupted upload before
      // that boundary; otherwise confirmed chunks might already be gone.
      if(Date.now()-p.startedAt>20*3600000){
        const generation=randomUUID().replaceAll('-','');p.begin.generation=generation;p.state.generation=generation;p.result.generation=generation;
        p.uploaded=0;p.startedAt=Date.now();await save(pendingFile,p);
      }
      await call('begin',p.begin);
      for(;p.uploaded<p.chunks.length;){
        await call('items',{generation:p.begin.generation,items:p.chunks[p.uploaded]});
        p.uploaded++;await save(pendingFile,p);
      }
      await call('commit',{generation:p.begin.generation});
      await save(options.stateFile,p.state);await unlink(pendingFile);return p.result;
    }catch(e){
      // Keep the exact generation and confirmed chunks, including a possibly
      // committed snapshot whose response was lost. Never restart a full upload.
      p.failures++;p.retryAt=Date.now()+Math.min(3600000,300000*2**Math.min(p.failures-1,4));
      await save(pendingFile,p);throw e;
    }
  }
  let pending:Pending|null=null;
  try{pending=JSON.parse(await readFile(pendingFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(pending){
    if(pending.retryAt>Date.now())return {deferred:true,retryAt:new Date(pending.retryAt).toISOString()};
    const current=await call('head');
    if(current.generation===pending.begin.baseGeneration||current.generation===pending.begin.generation)return finish(pending,current.generation);
    // Another publisher changed the base. Reconcile against its current head.
    await unlink(pendingFile);
  }
  let prior:{generation:string;hashes:Record<string,string>;metadata:string;capturedAt?:string;feedHash?:string;feedIds?:string[];reconcileCursor?:string;reportCursor?:string}|null=null;
  try{prior=JSON.parse(await readFile(options.stateFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const head=await call('head'),baseGeneration=head.generation;
  const hashes=Object.fromEntries(snapshot.items.map((i:any)=>[i.id,hash(i)])),metadata=hash(snapshot.metadata);
  const compatible=prior?.generation===baseGeneration;
  const archive=snapshot.metadata.archiveMode==='persistent';
  const catalog=async(recent=false)=>{const result:string[]=[];let after='';do{const q=new URLSearchParams();if(after)q.set('after',after);if(recent)q.set('recent','1');const page=await call('catalog'+(q.size?'?'+q:''));result.push(...page.ids);after=page.next??'';}while(after);return result;};
  let known=Object.keys(prior?.hashes??{});
  if(archive&&!compatible)known=await catalog();
  const oldFeed=archive?(compatible&&prior?.feedIds?prior.feedIds:await catalog(true)):[];
  const feed=new Set<string>(snapshot.feedIds??[]),oldFeedSet=new Set(oldFeed);
  const feedAddedIds=archive?[...feed].filter(id=>!oldFeedSet.has(id)):[],feedRemovedIds=archive?oldFeed.filter(id=>!feed.has(id)):[];
  const visible=new Set<string>(snapshot.visibleIds??snapshot.items.map((i:any)=>i.id));
  const withdrawnIds=archive?known.filter(id=>!visible.has(id)):[];
  const retained=archive?{...(prior?.hashes??{}),...hashes}:hashes;
  if(archive)for(const id of known)if(visible.has(id)&&!retained[id])retained[id]='archive-known';
  for(const id of withdrawnIds)delete retained[id];
  const feedHash=hash(snapshot.feedIds??snapshot.items.map((i:any)=>i.id));
  if(compatible&&metadata===prior!.metadata&&hash(retained)===hash(prior!.hashes)&&(!archive||feedHash===prior!.feedHash)){
    await call('heartbeat',{generation:baseGeneration});
    const temp=options.stateFile+'.'+randomUUID();await writeFile(temp,JSON.stringify({...prior,capturedAt:snapshot.capturedAt,reconcileCursor:snapshot.reconcileCursor??prior!.reconcileCursor,reportCursor:snapshot.reportCursor??prior!.reportCursor}),{mode:0o600});await rename(temp,options.stateFile);
    return{unchanged:true,items:snapshot.items.length};
  }
  const items=snapshot.items.filter((i:any)=>!compatible||prior!.hashes[i.id]!==hashes[i.id]);
  const generation=randomUUID().replaceAll('-','');
  const begin={generation,baseGeneration,capturedAt:snapshot.capturedAt,expectedChanges:items.length,ids:snapshot.items.map((i:any)=>i.id),metadata:snapshot.metadata,
    ...(archive?{feedIds:snapshot.feedIds,withdrawnIds,feedAddedIds,feedRemovedIds}:{})};
  let chunk:any[]=[];const chunks:any[][]=[];
  for(const item of items){
    if(chunk.length&&(chunk.length===30||Buffer.byteLength(JSON.stringify({generation,items:[...chunk,item]}))>230000)){chunks.push(chunk);chunk=[];}
    chunk.push(item);
  }
  if(chunk.length)chunks.push(chunk);
  const nextState={generation,hashes:retained,metadata,capturedAt:snapshot.capturedAt,feedHash,feedIds:snapshot.feedIds,
    reconcileCursor:snapshot.reconcileCursor??prior?.reconcileCursor,reportCursor:snapshot.reportCursor??prior?.reportCursor};
  const result={generation,items:snapshot.items.length,changed:items.length,capturedAt:snapshot.capturedAt};
  const journal:Pending={begin,chunks,uploaded:0,state:nextState,result,failures:0,retryAt:0,startedAt:Date.now()};
  await save(pendingFile,journal);
  return finish(journal,baseGeneration);
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
  try{
    const stateFile=process.env.FINHOT_SYNC_STATE??'/var/lib/finhot/public-sync-state.json';
    let prior:any=null;try{prior=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const since=prior?.capturedAt?new Date(Date.parse(prior.capturedAt)-5*60000).toISOString():undefined;
    const snapshot=await edgeSnapshot({since,reconcileCursor:prior?.reconcileCursor,reportCursor:prior?.reportCursor});
    const result=await pushSnapshot(snapshot,{url:process.env.FINHOT_SYNC_URL??'',token:process.env.FINHOT_SYNC_TOKEN??'',stateFile});console.log(JSON.stringify(result));
  }
  catch(e){console.error(e instanceof Error?e.message:'Public sync failed');process.exitCode=1;}
  finally{await closeDb();}
}
