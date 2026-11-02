import {itemOf} from './sync-api.ts';
import {resolveHttpUrl} from '../../packages/backend/src/lib/url.ts';

export function checkedSyncItem(value:any,sourceIds:Set<string>){
  // Repair only an unambiguous address. Malformed records remain in PostgreSQL
  // for investigation; they must not hold unrelated publications behind them.
  const url=typeof value?.url==='string'?resolveHttpUrl(value.url):null;
  if(!url)throw new TypeError('Invalid article URL');
  const item=/^https?:\/\//.test(value.url)&&value.url.trim()===value.url?value:{...value,url};
  itemOf(item,sourceIds);
  return item;
}

export function prepareSnapshot(snapshot:any,options:{startAt?:string;known?:Set<string>;knownReports?:any[]}={}){
  if(options.startAt&&(!Number.isFinite(Date.parse(options.startAt))||new Date(options.startAt).toISOString()!==options.startAt))throw new Error('Invalid publication start time');
  const sources=new Set<string>(snapshot.metadata.sources.map((s:any)=>s.id));
  const items:any[]=[],rejected:Array<{id:string;reason:string}>=[],skipped:string[]=[];
  for(const item of snapshot.items){
    if(options.startAt&&item.discovered_at<options.startAt&&!options.known?.has(item.id)){skipped.push(item.id);continue;}
    try{items.push(checkedSyncItem(item,sources));}
    catch(e){rejected.push({id:typeof item?.id==='string'?item.id.slice(0,80):'invalid-id',reason:e instanceof Error?e.message:'Invalid item'});}
  }
  const bad=new Set([...rejected.map(r=>r.id),...skipped]),keep=(ids:string[])=>ids.filter(id=>!bad.has(id));
  const reports=[...new Map([...(options.startAt?options.knownReports??[]:[]),...snapshot.metadata.reports.filter((r:any)=>!options.startAt||r.created_at>=options.startAt)].map((r:any)=>[`${r.domain??'finance'}:${r.date}`,r])).values()].sort((a:any,b:any)=>b.date.localeCompare(a.date));
  const metadata={...snapshot.metadata,reports:reports.map((r:any)=>({...r,ids:keep(r.ids),
    ...(r.review?{review:{...r.review,themes:r.review.themes.map((t:any)=>({...t,ids:keep(t.ids)}))}}:{})}))};
  if((rejected.length||skipped.length)&&metadata.coverage){
    const feed=new Set(snapshot.feedIds??snapshot.items.map((i:any)=>i.id)),shown=items.filter(i=>feed.has(i.id));
    metadata.coverage={total:shown.length,summaries:shown.filter(i=>i.summary.trim()).length,bodies:shown.filter(i=>i.body_status==='fetched').length,
      awaitingBody:shown.filter(i=>i.state==='awaiting-body').length,awaitingSummary:shown.filter(i=>!i.summary.trim()&&i.body_status==='fetched').length,
      unavailableBody:shown.filter(i=>['failed','too-large','no-text'].includes(i.body_status)).length};
  }
  return {snapshot:{...snapshot,items,metadata,...(snapshot.feedIds?{feedIds:keep(snapshot.feedIds)}:{}),
    ...(snapshot.visibleIds?{visibleIds:keep(snapshot.visibleIds)}:{})},rejected,skipped:skipped.length};
}
