// Background-only translation of the publication DTO. Readers never call a model.
import {z} from 'zod';
import {sql} from '../db.ts';
import {chatJson} from '../providers/llm.ts';
import {BudgetExceededError} from '../providers/receipts.ts';
import {modelFor} from './models.ts';
import {promptText,promptVersion} from './prompts.ts';
import {edgeSnapshot,EDGE_SOURCE_IDS} from '../publication/edge.ts';
import {listedCondition} from '../publication/items.ts';
import {createHash} from 'node:crypto';
import {config} from '../config.ts';
import {shutdownSignal} from '../jobs/queue.ts';

type Copy={id:string;title:string;summary:string};
const english=(s:string)=>!/[\u3400-\u9fff]/u.test(s);
export function validEnglishCopy(input:Copy,result:Copy){
  return input.id===result.id&&!!result.title.trim()&&english(result.title)&&english(result.summary)&&
    (!input.summary.trim()?result.summary==='':!!result.summary.trim());
}
export async function translatePublicCopy(opts:{maxBatches?:number;priorityIds?:string[]}={}){
  if(process.env.FINHOT_PUBLIC_EN_ENABLED!=='true'||!config.modelCallsEnabled)return {done:0,stopped:'disabled'};
  const lock=await sql.reserve();let done=0,batchSize=12;
  try{
    const [held]=await lock`SELECT pg_try_advisory_lock(9284026) AS acquired`;
    if(!held!.acquired)return {done,stopped:'already running'};
    const snapshot=await edgeSnapshot();
    const groupOf=new Map(snapshot.metadata.sources.map((s:any)=>[s.id,s.group]));
    const priority=[...new Set<string>([...(opts.priorityIds??[]),...(snapshot.metadata.reports[0]?.ids??[]),
      ...snapshot.items.slice(0,25).map((i:any)=>i.id),
      ...['market','company','research'].flatMap(g=>snapshot.items.filter((i:any)=>groupOf.get(i.source_id)===g).slice(0,20).map((i:any)=>i.id))])];
    for(let round=0;round<(opts.maxBatches??3)&&!shutdownSignal.signal.aborted;round++){
      const rows=await sql<Copy[]>`SELECT p.article_id AS id,coalesce(p.title,p.original_title) AS title,coalesce(p.summary,'') AS summary
        FROM publications p JOIN sources s ON s.id=p.source_id LEFT JOIN public_copy_en e ON e.article_id=p.article_id
        WHERE ${listedCondition(new Date())} AND s.enabled AND s.participation_mode='editorial' AND s.id=ANY(${EDGE_SOURCE_IDS}::text[])
          AND (e.article_id IS NULL OR e.source_title IS DISTINCT FROM coalesce(p.title,p.original_title) OR e.source_summary IS DISTINCT FROM coalesce(p.summary,'')
            OR (e.title_en='' AND e.attempts<3 AND e.retry_after<=now()))
        ORDER BY array_position(${priority}::text[],p.article_id) NULLS LAST,coalesce(p.published_at,p.discovered_at) DESC,p.article_id DESC LIMIT ${batchSize}`;
      if(!rows.length)break;
      const native=rows.filter(r=>english(r.title)&&english(r.summary)),pending=rows.filter(r=>!native.includes(r));
      let copies:Copy[]=[...native],receiptId:number|null=null;
      if(pending.length){
        const identity=createHash('sha256').update(JSON.stringify(pending)).digest('hex');
        try{
          const result=await chatJson({model:await modelFor('translate'),purpose:'translate_public_en',subject:'public-en:'+identity,
            promptVersion:promptVersion('public-copy-en'),system:promptText('public-copy-en'),user:JSON.stringify(pending),
            schema:z.object({items:z.array(z.object({id:z.string(),title:z.string().max(1500),summary:z.string().max(8000)})).length(pending.length)}).superRefine((v,ctx)=>{
              if(new Set(v.items.map(i=>i.id)).size!==pending.length||pending.some(r=>!v.items.some(i=>validEnglishCopy(r,i))))ctx.addIssue({code:'custom',message:'Incomplete or non-English translation'});
            }),reasoningHeadroom:0,maxTokens:Math.min(7000,500+pending.reduce((n,r)=>n+100+(r.summary?500:0),0)),temperature:0,timeoutMs:90000});
          copies.push(...result.data.items);receiptId=result.receiptId;
        }catch(error){
          if(error instanceof BudgetExceededError){
            // A rejected reservation has not made a provider request. Smaller batches
            // can fit the remaining money without increasing the shared cap.
            if(/daily cost|ordinary summaries/.test(error.message)&&batchSize>1){batchSize=Math.max(1,Math.floor(batchSize/2));round--;continue;}
            return {done,stopped:error.message};
          }
          if(/budget|disabled|not configured|unknown|pending|in.flight/i.test((error as Error).message))return {done,stopped:'budget or provider unavailable'};
          for(const r of pending)await sql`INSERT INTO public_copy_en(article_id,source_title,source_summary,attempts,retry_after)
            VALUES(${r.id},${r.title},${r.summary},1,now()+interval '1 hour') ON CONFLICT(article_id) DO UPDATE SET
            source_title=excluded.source_title,source_summary=excluded.source_summary,title_en='',summary_en='',
            attempts=CASE WHEN public_copy_en.source_title=excluded.source_title AND public_copy_en.source_summary=excluded.source_summary THEN public_copy_en.attempts+1 ELSE 1 END,retry_after=excluded.retry_after`;
        }
      }
      for(const copy of copies){const source=rows.find(r=>r.id===copy.id)!;
        await sql`INSERT INTO public_copy_en(article_id,source_title,source_summary,title_en,summary_en,receipt_id,attempts,updated_at)
          SELECT p.article_id,${source.title},${source.summary},${copy.title},${copy.summary},${receiptId},0,now() FROM publications p
          WHERE p.article_id=${copy.id} AND coalesce(p.title,p.original_title)=${source.title} AND coalesce(p.summary,'')=${source.summary}
          ON CONFLICT(article_id) DO UPDATE SET source_title=excluded.source_title,source_summary=excluded.source_summary,title_en=excluded.title_en,
            summary_en=excluded.summary_en,receipt_id=excluded.receipt_id,attempts=0,updated_at=excluded.updated_at`;
        done++;
      }
    }
    return {done};
  }finally{await lock`SELECT pg_advisory_unlock(9284026)`;lock.release();}
}
