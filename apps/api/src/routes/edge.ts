import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { credential, config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { edgeItems, edgeReports, edgeSources, EDGE_CATEGORIES, EDGE_GROUPS, EDGE_SOURCE_IDS } from "@aihot/backend/publication/edge";
import { escapeXml } from "@aihot/backend/publication/free";
import { feedbackSourceHash } from "@aihot/backend/operations/feedback";
import { listBudgets } from "@aihot/backend/admin/settings";

const matches = (supplied: unknown, secret: string | null) => typeof supplied==='string' && !!secret && secret.length>=12 && timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(secret).digest());
export function registerEdge(app: FastifyInstance) {
  app.register(async edge => {
    edge.addHook("onRequest",async(req,reply)=>{
      reply.header("cache-control","no-store");
      if (!matches(req.headers['x-finhot-origin-token'],credential('auth','FINHOT_ORIGIN_TOKEN'))) return reply.code(401).send({ error:"未授权访问" });
      if (req.url.startsWith('/_edge/admin/') && !matches((req.headers.authorization ?? '').replace(/^Bearer /,''),config.adminPassword)) return reply.code(401).send({ error:"请先登录管理员账户" });
    });
    edge.get('/_edge/health',async()=>{await sql`SELECT 1`;return { ok:true,edition:'hybrid' };});
    edge.get('/_edge/items',async(req,reply)=>{
      const q = req.query as Record<string,string>;
      const offset = Number(q.offset ?? 0);
      if (!Number.isInteger(offset)||offset<0||offset>5000||(q.category&&!Object.hasOwn(EDGE_CATEGORIES,q.category))||(q.group&&!Object.hasOwn(EDGE_GROUPS,q.group))||(q.source&&!EDGE_SOURCE_IDS.includes(q.source))) return reply.code(400).send({ error:'无效筛选或分页' });
      return edgeItems({ all:q.all==='1',category:q.category,group:q.group,source:q.source,offset,search:(q.q ?? '').trim().slice(0,80) });
    });
    edge.get('/_edge/sources',()=>edgeSources());
    edge.get('/_edge/reports',async()=>({ reports:await edgeReports() }));
    edge.get('/_edge/reports/:date',async(req,reply)=>{
      const { date }=req.params as { date:string };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) return reply.code(400).send({ error:'无效日期' });
      const report=await edgeReports(date);return report ?? reply.code(404).send({ error:'该日期还没有日报' });
    });
    edge.get('/_edge/feed.xml',async(_req,reply)=>{
      const { items }=await edgeItems({ limit:30 });
      return reply.type('application/rss+xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>FinHot · 金融精选</title><link>${escapeXml(config.siteUrl)}</link><description>金融资讯中文摘要与原文索引</description><language>zh-cn</language>${items.map(i=>`<item><title>${escapeXml(i.title)}</title><link>${escapeXml(i.url)}</link><guid isPermaLink="false">${escapeXml(i.id)}</guid><description>${escapeXml(i.summary)}</description><pubDate>${new Date(i.published_at ?? i.discovered_at).toUTCString()}</pubDate><source>${escapeXml(i.source_name)}</source></item>`).join('')}</channel></rss>`);
    });
    edge.get('/_edge/admin/status',async()=>({ edition:'hybrid',sources:(await edgeSources()).sources,budgets:await listBudgets(),model:'worker-only',feedback:await sql`SELECT id,content AS message,email AS contact,created_at FROM feedback WHERE edge_submission AND created_at>now()-interval '30 days' ORDER BY created_at DESC LIMIT 30` }));
    edge.post('/_edge/feedback',{ bodyLimit:4096 },async(req,reply)=>{
      const b=(req.body ?? {}) as Record<string,unknown>;
      if (b.website) return { accepted:true };
      const message=String(b.message ?? '').trim(),contact=String(b.contact ?? '').trim();
      if (message.length<10||message.length>1500||contact.length>150) return reply.code(400).send({ error:'说明请写 10—1500 字，联系方式不超过 150 字' });
      const hour=Math.floor(Date.now()/3600000);
      const key=feedbackSourceHash(`${req.headers['x-finhot-client-ip'] ?? ''}|${hour}`,String(req.headers['user-agent'] ?? '')),limitKey=key;
      const result=await sql.begin(async tx=>{
        const hit=await tx`INSERT INTO edge_feedback_limits(key,used,expires_at) VALUES(${limitKey},1,${new Date((hour+2)*3600000)})
                          ON CONFLICT(key) DO UPDATE SET used=edge_feedback_limits.used+1 WHERE edge_feedback_limits.used<5 RETURNING key`;
        if (!hit.length) return null;
        const [row]=await tx`INSERT INTO feedback(content,email,source_hash,edge_submission) VALUES(${message},${contact||null},${key},true) RETURNING id`;
        return row;
      });
      if (!result) return reply.code(429).header('retry-after','3600').send({ error:'提交较频繁，请一小时后再试' });
      return reply.code(201).send({ accepted:true,id:result.id });
    });
  });
}
