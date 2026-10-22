// Explicit, bounded acceptance command. Never start a sweep over historical material.
import { z } from 'zod';
import { sql,closeDb } from '@aihot/backend/db';
import { chatJson } from '@aihot/backend/providers/llm';
import { extractArticleBody } from '@aihot/backend/content/extract';
import { analyzeArticle } from '@aihot/backend/editorial/analyze';
import { publishArticle } from '@aihot/backend/publication/publish';
import { stopBoss } from '@aihot/backend/jobs/queue';

try {
  if(process.argv[2]==='ping') {
    const result=await chatJson({model:'default',purpose:'ecs_acceptance',subject:'connection-check-20261003',promptVersion:'ecs-1',system:'Reply with exactly {"reply":"ok"}.',user:'Check JSON connectivity.',schema:z.object({reply:z.literal('ok')}),maxTokens:512});
    console.log(JSON.stringify({connected:true,reused:result.reused,receiptId:result.receiptId,usage:result.usage}));
  } else {
    const id=process.argv[2];
    if(!id||!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('One existing article id is required');
    await extractArticleBody(id,false);
    const result=await analyzeArticle(id);
    if(result?.output&&!result.stale)await publishArticle(id,{releasedAt:new Date()});
    console.log(JSON.stringify({articleId:id,needsBody:result?.needsBody,stale:result?.stale,reused:result?.reused,receiptIds:result?.receiptIds,output:result?.output}));
  }
  const [amount]=await sql`SELECT count(*)::int AS requests,coalesce(sum(coalesce(cost,reserved_cost)),0) AS estimated_or_reserved_usd FROM receipt_attempts WHERE service='llm' AND origin='live' AND started_at>now()-interval '1 day'`;
  console.log(JSON.stringify(amount));
} finally { await stopBoss();await closeDb(); }
