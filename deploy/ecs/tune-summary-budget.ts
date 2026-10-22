// Explicit operational change: increase request count without altering the approved monetary cap.
import {sql,closeDb} from '../../packages/backend/src/db.ts';
try {
  const apply=process.argv.includes('--apply');
  const result=await sql.begin(async tx=>{
    const [budget]=await tx`SELECT service,per_minute,per_hour,per_day,daily_cost_limit,cost_currency FROM budgets WHERE service='llm' FOR UPDATE`;
    if(!budget||budget.daily_cost_limit!==1||budget.cost_currency!=='USD'||budget.per_minute!==6||budget.per_hour!==60||![200,400,1000].includes(budget.per_day))throw new Error('Budget differs from the approved USD 1 / 24h configuration; inspect before applying');
    if(apply)await tx`UPDATE budgets SET per_day=1000,note='FinHot 2026-10-08: ordinary summaries first; 1000 requests within USD 1 per rolling 24h; 70% brief / 30% review' WHERE service='llm'`;
    return {apply,previousRequests:budget.per_day,requestsPer24h:apply?1000:budget.per_day,dailyUsdLimit:1,requestsPerMinute:6,requestsPerHour:60};
  });
  console.log(JSON.stringify(result));
}finally{await closeDb();}
