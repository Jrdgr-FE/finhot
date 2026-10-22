// Release only waiting jobs caused by the old daily request count; every model call still checks all caps.
import {sql,closeDb} from '../../packages/backend/src/db.ts';
import {queueProcessing} from '../../packages/backend/src/jobs/content.ts';
import {stopBoss} from '../../packages/backend/src/jobs/queue.ts';
try {
  const [budget]=await sql`SELECT per_minute,per_hour,per_day,daily_cost_limit,cost_currency FROM budgets WHERE service='llm'`;
  if(!budget||![400,1000].includes(budget.per_day)||budget.daily_cost_limit!==1||budget.cost_currency!=='USD'||budget.per_minute!==6||budget.per_hour!==60)throw Error('Unexpected live budget; inspect before resuming');
  const result=await sql.begin(async tx=>{
    const pending=await tx<{id:string}[]>`UPDATE articles a SET processing_retry_at=NULL,processing_queued_at=NULL,processing_error=NULL
      FROM sources s WHERE a.source_id=s.id AND s.enabled=true AND s.participation_mode='editorial'
        AND a.processing_state='new' AND a.processing_error='Budget for llm exhausted (day)'
        AND NOT EXISTS (SELECT 1 FROM analyses x WHERE x.article_id=a.id AND x.input_revision=a.revision)
      RETURNING a.id`;
    let queued=0;
    // Publish the whole queue together so priority is applied before a worker claims its first job.
    for(const {id} of pending)if(await queueProcessing(id,{db:tx}))queued++;
    return {resumed:pending.length,queued,modelCallsFromThisScript:0,dailyUsdLimit:1};
  });
  console.log(JSON.stringify(result));
} finally {await stopBoss();await closeDb();}
