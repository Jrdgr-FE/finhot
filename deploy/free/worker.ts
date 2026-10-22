import type { MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { Env, Task } from "./types.ts";
import { SOURCES, SOURCE_GROUPS, CATEGORIES, dueSources, hash, collect, analyze, composeDaily } from "./pipeline.ts";
import { boundedText, beijingDate, reportWindow } from "./parsers.ts";
import { freeItems, freeReports, freeRss } from "../../packages/backend/src/publication/free.ts";
import { hydrate } from "./body.ts";
import { originResponse } from './origin.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization") ?? "";
  let supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (auth.startsWith("Basic ")) { try { supplied = atob(auth.slice(6)).split(":").slice(1).join(":"); } catch { return false; } }
  return supplied.length > 0 && (await hash(supplied)) === (await hash(env.ADMIN_PASSWORD));
}
async function body(request: Request): Promise<any> {
  const text = await boundedText(new Response(request.body), 4097);
  if (new TextEncoder().encode(text).length > 4096) throw new Error("提交内容过长");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Expected an object");
  return parsed;
}
async function route(request: Request, env: Env): Promise<Response> {
  const u = new URL(request.url), p = u.pathname;
  if (env.PREVIEW_ONLY === "true" && !(await authorized(request, env))) return new Response("FinHot 预览需管理员验证", { status: 401, headers: { "www-authenticate": 'Basic realm="FinHot Preview", charset="UTF-8"', "cache-control": "no-store" } });
  if (env.BACKEND_ORIGIN) {
    if (p.startsWith('/api/admin/')&&!(await authorized(request,env))) return json({error:'请先登录管理员账户'},401);
    const response=await originResponse(request,env);
    if(response)return response;
  }
  if (p.startsWith("/api/admin/")) {
    if (!(await authorized(request, env))) return json({ error: "请先登录管理员账户" }, 401);
    if (request.method === "POST" && request.headers.get("origin") && request.headers.get("origin") !== u.origin) return json({ error: "跨站请求被拒绝" }, 403);
    if (p === "/api/admin/status" && request.method === "GET") {
      const [items, receipts, health, feedback] = await Promise.all([
        env.DB.prepare("SELECT state,count(*) AS count FROM items GROUP BY state").all(),
        env.DB.prepare("SELECT state,count(*) AS count FROM ai_receipts WHERE day=? GROUP BY state").bind(new Date().toISOString().slice(0, 10)).all(),
        env.DB.prepare("SELECT * FROM source_health ORDER BY checked_at DESC").all(),
        env.DB.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 30").all(),
      ]);
      return json({ items: items.results, receipts: receipts.results, sources: health.results, feedback: feedback.results, dailyLimit: env.AI_DAILY_LIMIT, collect: env.COLLECT_ENABLED, model: env.MODEL_CALLS_ENABLED });
    }
    if (p === "/api/admin/run" && request.method === "POST") {
      const input = await body(request);
      if (input.kind === "collect" && SOURCES.some((s) => s.id === input.sourceId)) await env.TASKS.send({ kind: "collect", sourceId: input.sourceId });
      else if (["analyze", "hydrate"].includes(input.kind) && /^[a-f0-9]{64}$/.test(input.id ?? "")) await env.TASKS.send({ kind: input.kind, id: input.id });
      else return json({ error: "无效任务" }, 400);
      return json({ queued: true }, 202);
    }
    return json({ error: "接口不存在" }, 404);
  }
  if (p === "/api/feedback" && request.method === "POST") {
    if (request.headers.get("origin") !== u.origin) return json({ error: "请通过本站反馈页提交" }, 403);
    const input = await body(request);
    if (input.website) return json({ accepted: true }); // Hidden spam trap.
    const message = String(input.message ?? "").trim(), contact = String(input.contact ?? "").trim();
    if (message.length < 10 || message.length > 1500 || contact.length > 150) return json({ error: "说明请写 10—1500 字，联系方式不超过 150 字" }, 400);
    const ip = request.headers.get("cf-connecting-ip") ?? "local", hour = Math.floor(Date.now() / 3600000);
    const key = await hash(`feedback:${hour}:${ip}:${env.ADMIN_PASSWORD}`);
    const count = await env.DB.prepare("INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<5 RETURNING count").bind(key, (hour + 2) * 3600000).first();
    if (!count) return new Response(JSON.stringify({ error: "提交较频繁，请一小时后再试" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "3600" } });
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO feedback(id,message,contact,created_at) VALUES(?,?,?,?)").bind(id, message, contact, new Date().toISOString()).run();
    return json({ accepted: true, id }, 201);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "不支持的请求方式" }, 405);
  if (p === "/api/health") { await env.DB.prepare("SELECT 1").first(); return json({ ok: true, edition: "free" }); }
  if (p === "/api/items") {
    const category = u.searchParams.get("category") ?? "";
    if (category && !Object.hasOwn(CATEGORIES, category)) return json({ error: "无效分类" }, 400);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000) return json({ error: "无效分页" }, 400);
    const group = u.searchParams.get("group") ?? "", source = u.searchParams.get("source") ?? "";
    if (group && !Object.hasOwn(SOURCE_GROUPS, group)) return json({ error: "无效栏目" }, 400);
    if (source && !SOURCES.some((s) => s.id === source)) return json({ error: "无效信源" }, 400);
    const sourceIds = group || source ? SOURCES.filter((s) => (!group || s.free?.group === group) && (!source || s.id === source)).map((s) => s.id) : undefined;
    return json(await freeItems(env, { all: u.searchParams.get("all") === "1", category, sourceIds, search: (u.searchParams.get("q") ?? "").trim().slice(0, 80), offset }));
  }
  if (p === "/api/sources") {
    const health = (await env.DB.prepare("SELECT id,checked_at,count,latest_published_at,error IS NOT NULL AS failed FROM source_health").all()).results;
    return json({ sources: SOURCES.map((s) => ({ id: s.id, name: s.name, tier: s.tier, group: s.free?.group, homepage: s.free?.homepage, intervalMinutes: s.interval_minutes, ...health.find((h) => h.id === s.id) })), categories: CATEGORIES, groups: SOURCE_GROUPS });
  }
  if (p === "/api/reports") return json({ reports: await freeReports(env) });
  if (p.startsWith("/api/reports/")) {
    const date = p.slice(13); try { reportWindow(date); } catch { return json({ error: "无效日期" }, 400); }
    const report = await freeReports(env, date); return report ? json(report) : json({ error: "该日期还没有日报" }, 404);
  }
  if (p === "/feed.xml") return new Response(await freeRss(env, u.origin), { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public,max-age=300" } });
  if (p === "/robots.txt") return new Response(`User-agent: *\nDisallow: /admin\nDisallow: /api/admin/\n${env.PREVIEW_ONLY === "true" ? "Disallow: /\n" : ""}`);
  if (p === "/llms.txt") return new Response("# FinHot\n金融资讯中文摘要与原文索引。\n\n- 精选：/api/items\n- 全部：/api/items?all=1\n- 日报：/api/reports\n- RSS：/feed.xml\n\n摘要由模型辅助生成，请核对原文。\n");
  if (p.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); } catch (e) {
      const invalid = e instanceof SyntaxError || (e instanceof Error && e.message === "提交内容过长");
      response = json({ error: invalid ? "提交格式不正确或内容过长" : "暂时无法完成请求，请稍后重试" }, invalid ? 400 : 503);
      if (!invalid) console.error("request failed", e instanceof Error ? e.name : "unknown");
    }
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff"); headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (env.PREVIEW_ONLY === "true") { headers.set("x-robots-tag", "noindex, nofollow"); headers.set("cache-control", "private,no-store"); }
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (env.BACKEND_ORIGIN) return;
    if (env.COLLECT_ENABLED === "true" && event.cron !== "0 0 * * *") {
      await env.DB.prepare("UPDATE items SET body_status='failed',body_error='正文任务中断或超时',state=CASE WHEN length(excerpt)>=50 THEN 'pending' ELSE 'source-only' END WHERE state='awaiting-body' AND body_status='pending' AND body_checked_at<?")
        .bind(new Date(Date.now() - 1800000).toISOString()).run();
      const health = await env.DB.prepare("SELECT id,checked_at FROM source_health").all<{ id: string; checked_at: string }>();
      for (const source of dueSources(health.results, event.scheduledTime)) await env.TASKS.send({ kind: "collect", sourceId: source.id });
      const bodySources = SOURCES.filter((s) => s.free?.body).map((s) => s.id);
      if (bodySources.length) {
        const rows = await env.DB.prepare(`SELECT id FROM (SELECT id,discovered_at,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY discovered_at DESC,id DESC) AS rank FROM items WHERE source_id IN (${bodySources.map(() => "?").join(",")}) AND state IN ('awaiting-body','source-only','pending') AND body_status!='fetched' AND body_attempts<2 AND discovered_at>=? AND (body_checked_at IS NULL OR body_checked_at<?) AND NOT EXISTS(SELECT 1 FROM ai_receipts WHERE id='summary-v1:'||items.id)) ORDER BY rank,discovered_at DESC LIMIT 8`)
          .bind(...bodySources, new Date(Date.now() - 7 * 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString()).all<{ id: string }>();
        for (const item of rows.results) await env.TASKS.send({ kind: "hydrate", id: item.id });
      }
    }
    if (env.MODEL_CALLS_ENABLED === "true") {
      const spent = await env.DB.prepare("SELECT count(*) AS n FROM ai_receipts WHERE day=?").bind(new Date().toISOString().slice(0, 10)).first<{ n: number }>();
      const remaining = Math.min(2, Math.max(0, Number(env.AI_DAILY_LIMIT) - (spent?.n ?? 0)));
      if (remaining > 0) {
        const pending = await env.DB.prepare("SELECT id FROM (SELECT id,discovered_at,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY discovered_at DESC,id DESC) AS rank FROM items WHERE state='pending' AND discovered_at>=?) ORDER BY rank,discovered_at DESC LIMIT ?")
          .bind(new Date(Date.now() - 7 * 86400000).toISOString(), remaining).all<{ id: string }>();
        for (const item of pending.results) await env.TASKS.send({ kind: "analyze", id: item.id });
      }
    }
    // UTC midnight is Beijing 08:00. Check every tick so delayed cron delivery catches up.
    const date = new Date(event.scheduledTime).toISOString().slice(0, 10);
    if (!(await env.DB.prepare("SELECT date FROM reports WHERE date=?").bind(date).first())) await env.TASKS.send({ kind: "daily", date });
    if (event.cron === "0 0 * * *") await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_limits WHERE expires<?").bind(Date.now()),
      env.DB.prepare("DELETE FROM feedback WHERE created_at<?").bind(new Date(Date.now() - 30 * 86400000).toISOString()),
      env.DB.prepare("DELETE FROM items WHERE discovered_at<?").bind(new Date(Date.now() - 90 * 86400000).toISOString()),
      env.DB.prepare("DELETE FROM reports WHERE date<?").bind(beijingDate(Date.now() - 30 * 86400000)),
      env.DB.prepare("DELETE FROM ai_receipts WHERE created_at<?").bind(new Date(Date.now() - 90 * 86400000).toISOString()),
    ]);
  },
  async queue(batch: MessageBatch<Task>, env: Env): Promise<void> {
    if (env.BACKEND_ORIGIN) { for (const message of batch.messages) message.ack();return; }
    for (const message of batch.messages) {
      try {
        const task = message.body;
        if (task.kind === "collect") await collect(env, task.sourceId);
        else if (task.kind === "hydrate") await hydrate(env, SOURCES, task.id);
        else if (task.kind === "analyze") await analyze(env, task.id);
        else if (task.kind === "daily") await composeDaily(env, task.date);
        message.ack();
      } catch (e) { console.error("task failed", message.body.kind, String(e).slice(0, 250)); message.retry({ delaySeconds: 60 }); }
    }
  },
};
