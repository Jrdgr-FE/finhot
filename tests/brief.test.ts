import {stub,tag} from './setup.ts';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {analyzeArticle} from '@aihot/backend/editorial/analyze';
import {publishArticle} from '@aihot/backend/publication/publish';
import {stopBoss,QUEUES} from '@aihot/backend/jobs/queue';
import {processArticle} from '@aihot/backend/jobs/content';
import {basicCategory} from '@aihot/industry/classification';
import {paidRequest,BudgetExceededError} from '@aihot/backend/providers/receipts';

const source='brief-'+tag(),calls:string[]=[];let score=20,briefDomains:string[]|null=null;
const provider=await stub((_hit,req)=>{
  const body=JSON.parse(req.body),system=String(body.messages[0]?.content??'');
  const brief=system.includes('普通摘要和基础分类'),understand=system.includes('内容理解编辑'),structure=system.includes('资料结构化助手');calls.push(brief?'brief':understand?'understand':structure?'structure':'score');
  return {choices:[{message:{content:JSON.stringify(brief?
    {...(briefDomains?{domains:briefDomains}:{relevant:true}),titleZh:'测试公司披露三季度业绩预告',summaryZh:'测试公司披露三季度业绩预告，预计净利润同比增长30%，具体区间和假设请以公司公告为准。',category:'earnings'}:understand?
    {itemType:'earnings',titleZh:'测试公司披露三季度业绩预告',summaryZh:'测试公司披露三季度业绩预告，预计净利润同比增长30%。',tags:['财报/业绩'],editorialJudgment:'测试样本'}:structure?
    {category:'earnings',tags:['财报/业绩'],subjects:[],fact:{title:'三季度业绩预告',subject:'测试公司',action:'披露',object:'预计净利润增长30%'}}:{attentionScore:score})}}],usage:{prompt_tokens:10,completion_tokens:20}};
});
for(const name of ['DEEPSEEK_BASE_URL','ZHIPU_BASE_URL','DASHSCOPE_BASE_URL'])process.env[name]=provider.url+'/v1';
for(const name of ['DEEPSEEK_API_KEY','ZHIPU_API_KEY','DASHSCOPE_API_KEY'])process.env[name]='test-key';
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,participation_mode)VALUES(${source},'测试公司','rss','T1','editorial')`;});
after(async()=>{delete process.env.FINHOT_BRIEF_FIRST;await provider.close();await stopBoss();await closeDb();});

test('one paid call publishes an ordinary summary; review reuses it and keeps both independent scores',async()=>{
  const {articleId}=await upsertMaterial({sourceId:source,url:'https://example.org/'+source,title:'测试公司披露三季度业绩预告',
    bodyText:'测试公司披露三季度业绩预告，预计净利润同比增长30%，具体区间与假设请以公司公告为准。'.repeat(5),bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const brief=await analyzeArticle(articleId,{briefOnly:true});assert.equal(brief!.output!.selected,false);assert.equal(brief!.output!.score,null);
  assert.equal(brief!.receiptIds.length,1);await publishArticle(articleId);
  const [published]=await sql`SELECT eligible,selected,category,summary FROM publications WHERE article_id=${articleId}`;
  assert.equal(published.eligible,true);assert.equal(published.selected,false);assert.equal(published.category,'earnings');assert.ok(published.summary);
  await analyzeArticle(articleId,{briefOnly:true});assert.deepEqual(calls,['brief'],'retry reuses the brief receipt');
  // 20 is far below the T1 threshold (60): the first score decides alone.
  const review=await analyzeArticle(articleId,{reuseBrief:true});assert.deepEqual(calls,['brief','score']);
  assert.equal(review!.output!.selected,false);assert.deepEqual(review!.output!.scores,[20]);
  assert.equal(review!.output!.summaryZh,brief!.output!.summaryZh);
  const [analysis]=await sql`SELECT output FROM analyses WHERE article_id=${articleId} ORDER BY id DESC LIMIT 1`;assert.equal(analysis.output.reviewed,true);
});

test('the source domain leads the model ranking: a finance outlet stays finance first, ai added',async()=>{
  const {articleId}=await upsertMaterial({sourceId:source,url:'https://example.org/'+source+'/chips',title:'测试公司芯片业务三季度营收增长',
    bodyText:'测试公司芯片业务三季度营收同比增长30%，数据中心客户需求强劲。'.repeat(5),bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  briefDomains=['ai','finance'];
  try{
    await analyzeArticle(articleId,{briefOnly:true});
    const [row]=await sql`SELECT domains,primary_domain,category FROM analyses WHERE article_id=${articleId} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual([row.domains,row.primary_domain,row.category],[['finance','ai'],'finance','earnings']);
  }finally{briefDomains=null;}
});

test('provisional navigation categories work without any model call and preserve explicit categories',()=>{
  assert.equal(basicCategory('cninfo-financial','三季度业绩预增公告'),'earnings');
  assert.equal(basicCategory('cninfo-company','关于回购股份的公告'),'corporate');
  assert.equal(basicCategory('eastmoney-research-1','行业研究'),'research');
  assert.equal(basicCategory('cninfo-company','季度净利润增长','insurance'),'insurance');
});

test('selected ordinary summaries still receive two independent scores, understanding and fact structure',async()=>{
  const {articleId}=await upsertMaterial({sourceId:source,url:'https://example.org/'+source+'/selected',title:'测试公司披露三季度业绩预告',
    bodyText:'测试公司披露三季度业绩预告，预计净利润同比增长30%。'.repeat(10),bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const start=calls.length;score=85;
  try{
    await analyzeArticle(articleId,{briefOnly:true});
    const reviewed=await analyzeArticle(articleId,{reuseBrief:true});
    assert.equal(reviewed!.output!.selected,true);assert.deepEqual(reviewed!.output!.scores,[85]);
    assert.deepEqual(calls.slice(start),['brief','score','understand','structure']);
    assert.ok(reviewed!.output!.fact);assert.equal(reviewed!.output!.category,'earnings');
  }finally{score=20;}
});

test('a first score near the threshold asks a second one and their mean decides',async()=>{
  const {articleId}=await upsertMaterial({sourceId:source,url:'https://example.org/'+source+'/near',title:'测试公司披露三季度业绩预告',
    bodyText:'测试公司披露三季度业绩预告，预计净利润同比增长12%。'.repeat(10),bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const start=calls.length;score=62;
  try{
    await analyzeArticle(articleId,{briefOnly:true});
    const reviewed=await analyzeArticle(articleId,{reuseBrief:true});
    assert.deepEqual(calls.slice(start),['brief','score','score','understand','structure']);
    assert.deepEqual([reviewed!.output!.scores,reviewed!.output!.score,reviewed!.output!.selected],[[62,62],62,true]);
  }finally{score=20;}
});

test('the rule pre-screen: a routine filing makes no call, a market flash gets a summary and no scores',async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES('cninfo-company','巨潮公告','json_list','T1','editorial'),('sina-market','新浪市场','rss','T2','editorial')
    ON CONFLICT(id) DO UPDATE SET participation_mode='editorial'`;
  const T=tag(),body='测试公司公告正文，披露相关事项的具体安排与时间表。'.repeat(5);
  const filing=await upsertMaterial({sourceId:'cninfo-company',url:`https://example.org/${source}/filing`,title:`测试公司 · 600000 · 关于变更持续督导保荐代表人的公告 ${T}`,bodyText:body,bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const flash=await upsertMaterial({sourceId:'sina-market',url:`https://example.org/${source}/flash`,title:`新加坡金管局意外维持货币政策不变 ${T}`,bodyText:body,bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const start=calls.length;process.env.FINHOT_BRIEF_FIRST='true';
  try{
    assert.equal((await processArticle(filing.articleId)).state,'source-index');
    assert.equal((await processArticle(flash.articleId)).state,'pass');
  }finally{delete process.env.FINHOT_BRIEF_FIRST;}
  assert.deepEqual(calls.slice(start),['brief'],'the filing made no call; the flash one summary');
  const [row]=await sql`SELECT processing_state,processing_error FROM articles WHERE id=${filing.articleId}`;
  assert.deepEqual([row!.processing_state,row!.processing_error],['skipped','保留来源索引；规则初筛 filing-routine']);
  const [queued]=await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.review} AND data->>'articleId'=${flash.articleId}`;
  assert.equal(queued!.n,0,'no review is queued for a screened item');
});

test('articles found before FINHOT_PROCESS_SINCE stay a source index without any call',async()=>{
  const T=tag(),body='测试公司披露三季度经营数据，营业收入同比增长。'.repeat(8);
  const old=await upsertMaterial({sourceId:source,url:`https://example.org/${source}/before-start`,title:`测试公司披露三季度经营数据 ${T}`,bodyText:body,bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
  const start=calls.length;process.env.FINHOT_BRIEF_FIRST='true';process.env.FINHOT_PROCESS_SINCE=new Date(Date.now()+60000).toISOString();
  try{
    assert.equal((await processArticle(old.articleId)).state,'source-index');
    assert.deepEqual(calls.slice(start),[],'the backlog article made no call');
    const [row]=await sql`SELECT processing_state,processing_error FROM articles WHERE id=${old.articleId}`;
    assert.deepEqual([row!.processing_state,row!.processing_error],['skipped','保留来源索引；早于处理起点']);
    process.env.FINHOT_PROCESS_SINCE=new Date(Date.now()-3600000).toISOString();
    const fresh=await upsertMaterial({sourceId:source,url:`https://example.org/${source}/after-start`,title:`测试公司披露新的经营数据 ${T}`,bodyText:body,bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
    assert.equal((await processArticle(fresh.articleId)).state,'pass');assert.deepEqual(calls.slice(start),['brief']);
  }finally{delete process.env.FINHOT_BRIEF_FIRST;delete process.env.FINHOT_PROCESS_SINCE;}
});

for(const share of [0.7,0.5])test(`summary/review share ${share} respects both lanes and the unchanged global cap`,async()=>{
  const [saved]=await sql`SELECT * FROM budgets WHERE service='llm'`;
  const older=await sql`UPDATE receipt_attempts SET started_at=started_at-interval '3 days' WHERE service='llm' AND started_at>now()-interval '1 day' RETURNING id`;
  const mine:number[]=[];process.env.FINHOT_BRIEF_FIRST='true';process.env.FINHOT_BRIEF_BUDGET_SHARE=String(share);
  const request=(purpose:string,amount:number)=>({service:'llm',purpose,identity:tag(),reservedCost:{amount,currency:'USD'}});
  try{
    await sql`UPDATE budgets SET per_minute=100,per_hour=1000,per_day=1000,daily_cost_limit=1,cost_currency='USD' WHERE service='llm'`;
    const first=await paidRequest(request('brief_article',share-0.02),async()=>({response:{}}));mine.push(first.receiptId);
    await assert.rejects(paidRequest(request('translate_public_en',0.03),async()=>assert.fail('brief share exceeded')),BudgetExceededError);
    const review=await paidRequest(request('score_article',1-share-0.01),async()=>({response:{}}));mine.push(review.receiptId);
    await assert.rejects(paidRequest(request('score_article',0.02),async()=>assert.fail('review share exceeded')),BudgetExceededError);
    await assert.rejects(paidRequest(request('brief_article',0.04),async()=>assert.fail('global cap exceeded')),BudgetExceededError);
  }finally{
    delete process.env.FINHOT_BRIEF_FIRST;delete process.env.FINHOT_BRIEF_BUDGET_SHARE;
    await sql`UPDATE receipt_attempts SET started_at=started_at-interval '3 days' WHERE receipt_id=ANY(${mine}::bigint[])`;
    for(const r of older)await sql`UPDATE receipt_attempts SET started_at=started_at+interval '3 days' WHERE id=${r.id}`;
    if(saved)await sql`UPDATE budgets SET per_minute=${saved.per_minute},per_hour=${saved.per_hour},per_day=${saved.per_day},daily_cost_limit=${saved.daily_cost_limit},cost_currency=${saved.cost_currency} WHERE service='llm'`;
  }
});
