// Preserve existing public daily citations without re-running any model.
import {readFileSync} from 'node:fs';
import {sql,closeDb} from '../../packages/backend/src/db.ts';
import {edgeItems} from '../../packages/backend/src/publication/edge.ts';
const history=JSON.parse(readFileSync(process.argv[2],'utf8'));
let imported=0;
try{
  for(const report of history[0]?.results??[]){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(report.date)||!Number.isFinite(Date.parse(report.created_at)))throw new Error('Invalid report');
    const ids=JSON.parse(report.item_ids);if(!Array.isArray(ids)||ids.length>500)throw new Error('Invalid report citations');
    const {items}=await edgeItems({ids});
    const content={sections:[{label:'精选',items:items.map(i=>({itemId:i.id,title:i.title,summary:i.summary,sourceName:i.source_name,sourceUrl:i.url,sourceId:i.source_id}))}],flashes:[],highlights:items.slice(0,3).map(i=>i.id)};
    const end=new Date(report.date+'T00:00:00.000Z'),start=new Date(end.getTime()-86400000);
    const result=await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily',${report.date},${start},${end},${sql.json(content)},${new Date(report.created_at)}) ON CONFLICT(kind,key) DO NOTHING RETURNING key`;
    imported+=result.length;
  }
  console.log(JSON.stringify({importedReports:imported,modelCalls:0}));
}finally{await closeDb();}
