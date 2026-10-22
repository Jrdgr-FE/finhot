import {sql} from '../db.ts';
import {extractArticleBody,pageFetchable} from '../content/extract.ts';
import {publishArticle} from '../publication/publish.ts';
import {queueProcessing} from './content.ts';

/** Older imported excerpts were already marked unconfirmed. Retry a bounded, recent subset. */
export async function recoverBodies(limit=5,enqueueAnalysis=true,sourceId?:string) {
  const rows=await sql<{id:string;url:string;kind:string}[]>`
    SELECT a.id,a.url,s.kind FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE s.enabled AND s.participation_mode='editorial' AND a.body_status IN('pending','unconfirmed')
      AND a.discovered_at>now()-interval '7 days' AND a.body_fetch_attempts<3
      AND a.material_scope IN('','feed') ${sourceId?sql`AND a.source_id=${sourceId}`:sql``}
      AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.article_id=a.id AND p.eligible AND length(coalesce(p.summary,''))>0)
      AND (a.body_checked_at IS NULL OR a.body_checked_at<now()-interval '1 hour')
      AND (a.processing_queued_at IS NULL OR a.processing_queued_at<now()-interval '30 minutes')
    ORDER BY a.discovered_at DESC LIMIT ${Math.max(1,Math.min(30,limit))}`;
  const results:Array<{id:string;state:string}>=[];
  for(const a of rows){
    if(!pageFetchable(a.url,a.kind))continue;
    try{
      // No paid fallback: body retries do not consume the summary budget.
      const state=await extractArticleBody(a.id,false);await publishArticle(a.id);
      if(state==='ok'&&enqueueAnalysis&&process.env.MODEL_CALLS_ENABLED!=='false')await queueProcessing(a.id,{step:'analyze'});
      results.push({id:a.id,state});
    }catch{results.push({id:a.id,state:'failed'});}
  }
  return{attempted:results.length,recovered:results.filter(r=>r.state==='ok').length,results};
}
