import type {D1Database} from '@cloudflare/workers-types';
import {syncedState,syncedHealth} from '../../packages/backend/src/publication/synced.ts';

// Records transitions for the private admin screen. It never sends external messages.
export async function monitorSync(db:D1Database,now=Date.now()) {
  const state=await syncedState(db),health=state?syncedHealth(state,now):null;
  const conditions=[
    {kind:'sync',active:!health||health.stale,message:'超过 15 分钟未收到后台同步，网站继续提供上次完整数据。'},
    {kind:'collection',active:!!health?.collectionDelayed,message:'全部信源均超过目标检查间隔，请检查采集进程。'},
  ];
  const stamp=new Date(now).toISOString();
  for(const condition of conditions){
    if(condition.active)await db.prepare('INSERT INTO sync_incidents(id,kind,message,opened_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(kind) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=excluded.last_seen_at').bind(crypto.randomUUID(),condition.kind,condition.message,stamp,stamp).run();
    else await db.prepare('UPDATE sync_incidents SET resolved_at=? WHERE kind=? AND resolved_at IS NULL').bind(stamp,condition.kind).run();
  }
}
