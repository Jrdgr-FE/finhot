// Manual bounded extraction acceptance. Never queues or invokes a model.
import {recoverBodies} from '../../packages/backend/src/jobs/body-recovery.ts';
import {sql,closeDb} from '../../packages/backend/src/db.ts';
import {extractArticleBody} from '../../packages/backend/src/content/extract.ts';
import {publishArticle} from '../../packages/backend/src/publication/publish.ts';
if(process.env.MODEL_CALLS_ENABLED!=='false')throw new Error('Body-only repair requires MODEL_CALLS_ENABLED=false');
try{
  const limit=Math.max(1,Math.min(30,Number(process.env.FINHOT_BODY_REPAIR_LIMIT)||12));
  const [{active}]=await sql`SELECT count(*)::int AS active FROM pgboss.job WHERE name='content.extract-body' AND state='active'`;
  if(active)throw new Error('Extraction queue is active; let the running worker finish');
  // Use only during staging, before the extraction consumer is enabled. Existing queued jobs are
  // retained; they will see body_status=ok and skip these already repaired articles after activation.
  const pending=await sql<{id:string}[]>`SELECT a.id FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE s.enabled AND s.participation_mode='editorial' AND a.body_status='pending'
      AND a.body_fetch_attempts<3 AND a.discovered_at>now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.article_id=a.id AND p.eligible AND length(coalesce(p.summary,''))>0)
    ORDER BY a.discovered_at DESC LIMIT ${limit}`;
  const results:Array<{id:string;state:string}>=[];
  for(const a of pending){const state=await extractArticleBody(a.id,false);await publishArticle(a.id);results.push({id:a.id,state});}
  const recovered=results.length<limit?await recoverBodies(limit-results.length,false):{attempted:0,recovered:0,results:[]};
  console.log(JSON.stringify({attempted:results.length+recovered.attempted,recovered:results.filter(r=>r.state==='ok').length+recovered.recovered,results:[...results,...recovered.results]}));
}
finally{await closeDb();}
