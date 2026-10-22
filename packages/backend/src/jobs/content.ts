// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued, so the
// safety net only picks up articles nothing is working on and sends those still waiting for a body to
// extraction first. A provider outage makes an article wait and retry with backoff; only a permanent
// refusal or exhausted retries end in "failed", which the admin re-queues in bulk.
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { prescreen } from "@aihot/industry/prescreen";
import { publishArticle } from "../publication/publish.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { ensureQueue, enqueue, QUEUES, shutdownSignal } from "./queue.ts";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** A queued article whose job left no trace for this long is queued again. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
  complete: boolean;
  continuation: boolean;
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * when there is only a title or a feed summary (the analysis judges the whole article), or when an
 * X post links an X Article (fetched before judging; for a discussion post only while it is news, as
 * history adds no heat).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<{ body_status: string; participation_mode: string; kind: string; config: Record<string, unknown>; url: string; bare: boolean; backfill: boolean; published_at: Date | null; discovered_at: Date; complete: boolean; continuation: boolean }[]>`
    SELECT a.body_status, s.participation_mode, s.kind, s.config, a.url, (coalesce(a.body_text, '') = '' AND a.x_post IS NULL) AS bare,
           a.backfill, a.published_at, a.discovered_at,
           (a.processing_state IN ('analyzed','blocked') AND EXISTS (
             SELECT 1 FROM analyses x WHERE x.article_id=a.id AND x.input_revision=a.revision)) AS complete,
           EXISTS (SELECT 1 FROM receipts r WHERE r.service='llm' AND r.origin='live'
             AND r.subject='article:' || a.id::text || '@' || a.revision::text
             AND r.status IN ('received','completed')) AS continuation
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  const needsXArticle = row.kind === "x_search" && (!signal || (row.participation_mode === "hot_signal" && !historical));
  return { step: pending && (needsPage || needsXArticle) ? "extract" : "analyze", signal, historical, complete: row.complete, continuation: row.continuation };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { continuation: 10, live: 0, liveSignal: -1, history: -2 } as const;

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
/** Feed folding (events/fold.ts) for a public report; FINHOT_FEED_FOLD=false switches it off. */
async function enqueueFold(articleId: string) {
  if (process.env.FINHOT_FEED_FOLD === "false") return;
  await enqueue(QUEUES.fold, { articleId }, { singletonKey: articleId });
}

export async function queueProcessing(articleId: string, opts: { step?: Step; attemptTag?: string; db?: Db } = {}): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  if (r.complete && !opts.attemptTag) return null;
  const step = opts.step ?? r.step;
  await db`UPDATE articles SET processing_queued_at = now() WHERE id = ${articleId}`;
  if (step === "extract") return enqueue(QUEUES.extractBody, { articleId }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live }, opts.db);
  if (r.signal && !opts.attemptTag) {
    return enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.liveSignal }, opts.db);
  }
  const tagged = !!opts.attemptTag;
  return enqueue(QUEUES.analyze, tagged ? { articleId, attemptTag: opts.attemptTag } : { articleId },
    { singletonKey: tagged ? `manual:analyze:${articleId}:${opts.attemptTag}` : articleId, priority: r.historical ? PRIORITY.history : r.continuation ? PRIORITY.continuation : PRIORITY.live }, opts.db);
}

/** Resume paid, unfinished live chains before starting fresh ones. History remains behind live work. */
export async function refreshAnalysisPriorities(): Promise<number> {
  if(process.env.FINHOT_BRIEF_FIRST==='true'){
    // Round-robin by source; each source's newest materials are served first.
    const rows=await sql`WITH ranked AS (
      SELECT j.id,row_number() OVER(PARTITION BY a.source_id ORDER BY coalesce(a.published_at,a.discovered_at) DESC,a.id DESC) AS position,
        a.backfill,a.published_at,a.discovered_at
      FROM pgboss.job j JOIN articles a ON j.data->>'articleId'=a.id::text
      WHERE j.name=${QUEUES.analyze} AND j.state IN ('created','retry') AND NOT(j.data?'attemptTag'))
      UPDATE pgboss.job j SET priority=CASE WHEN r.backfill AND (r.published_at IS NULL OR r.discovered_at-r.published_at>interval '48 hours')
        THEN -2 ELSE 10000-least(r.position::int*10,20000) END FROM ranked r WHERE j.id=r.id RETURNING j.id`;
    return rows.length;
  }
  const rows = await sql`
    UPDATE pgboss.job j SET priority=CASE
      WHEN a.backfill AND (a.published_at IS NULL OR a.discovered_at-a.published_at>interval '48 hours') THEN -2
      WHEN EXISTS (SELECT 1 FROM receipts r WHERE r.service='llm' AND r.origin='live'
        AND r.subject='article:' || a.id::text || '@' || a.revision::text
        AND r.status IN ('received','completed')) THEN 10 ELSE 0 END
    FROM articles a WHERE j.name=${QUEUES.analyze} AND j.state IN ('created','retry')
      AND j.data->>'articleId'=a.id::text AND NOT (j.data ? 'attemptTag')
    RETURNING j.id`;
  return rows.length;
}

/** Finish paid review chains first, then serve recent briefs fairly across sources. */
export async function refreshReviewPriorities():Promise<number>{
  const rows=await sql`WITH ranked AS (
    SELECT j.id,row_number() OVER(PARTITION BY a.source_id ORDER BY coalesce(a.published_at,a.discovered_at) DESC,a.id DESC) AS position,
      EXISTS(SELECT 1 FROM receipts r WHERE r.subject='article:'||a.id::text||'@'||a.revision::text
        AND r.origin='live' AND r.service='llm' AND r.status IN ('received','completed')
        AND r.purpose IN ('score_article','understand_article','structure_article')) AS continuing
    FROM pgboss.job j JOIN articles a ON j.data->>'articleId'=a.id::text
    WHERE j.name=${QUEUES.review} AND j.state IN ('created','retry'))
    UPDATE pgboss.job j SET priority=(CASE WHEN r.continuing THEN 30000 ELSE 10000 END)-least(r.position::int,9999)
    FROM ranked r WHERE j.id=r.id RETURNING j.id`;
  return rows.length;
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

/**
 * FINHOT_PROCESS_SINCE (an ISO time): articles found before it keep a source index and get no paid call,
 * so a backlog is dropped instead of paid for (set 2026-10-21). Unset, every article is processed.
 */
export function processSince(value = process.env.FINHOT_PROCESS_SINCE): Date | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time) : null;
}

/** attemptTag makes an explicit re-evaluation a new (paid) request; the same tag reuses its receipt. */
export async function processArticle(articleId: string, opts: { attemptTag?: string } = {}): Promise<{ state: string }> {
  const [found] = await sql<{ participation_mode: string; processing_state: string; revision: number; backfill: boolean; published_at: Date | null; discovered_at: Date; source_id: string; title: string }[]>`
    SELECT s.participation_mode, a.processing_state, a.revision, a.backfill, a.published_at, a.discovered_at, a.source_id, a.title FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!found) return { state: "missing" };
  if (!opts.attemptTag && ['analyzed','blocked'].includes(found.processing_state)) {
    const [finished] = await sql`SELECT relevance FROM analyses WHERE article_id=${articleId} AND input_revision=${found.revision} ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (finished) {
      await publishArticle(articleId);
      if (process.env.FINHOT_BRIEF_FIRST!=='true' && found.participation_mode==='editorial' && finished.relevance==='pass' && !isHistorical(found)) {
        await enqueue(QUEUES.group,{articleId},{singletonKey:articleId,priority:PRIORITY.live});
      }
      return { state: "already-analyzed" };
    }
  }
  const row = { ...found, historical: isHistorical(found) };
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  const since=processSince();
  if(!opts.attemptTag&&since&&found.discovered_at<since){
    await sql`UPDATE articles SET processing_state='skipped',processing_error='保留来源索引；早于处理起点' WHERE id=${articleId}`;
    return {state:'source-index'};
  }
  // The rule pre-screen (industry/prescreen.ts), before any paid call: routine items stay a source index,
  // low-yield ones get the ordinary summary but no selection scores. An explicit re-evaluation is not screened.
  const screen=opts.attemptTag?null:prescreen(found.source_id,found.title);
  if(screen?.action==='index'){
    await sql`UPDATE articles SET processing_state='skipped',processing_error=${`保留来源索引；规则初筛 ${screen.rule}`} WHERE id=${articleId}`;
    return {state:'source-index'};
  }
  const briefOnly=(process.env.FINHOT_BRIEF_FIRST==='true'||screen?.action==='brief')&&!opts.attemptTag;
  if(briefOnly&&(found.published_at??found.discovered_at).getTime()<Date.now()-7*86400000){
    await sql`UPDATE articles SET processing_state='skipped',processing_error='保留来源索引；超过普通摘要处理窗口' WHERE id=${articleId}`;
    return {state:'source-index'};
  }
  try {
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag,briefOnly });
    if (!result) return { state: "missing" };
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    await publishArticle(articleId);
    if (result.output.relevance === "pass" && !row.historical) await enqueueFold(articleId);
    // History is archived but founds no event (isHistorical).
    if (result.output.relevance === "pass" && !row.historical && screen?.action !== "brief") {
      if(briefOnly)await enqueue(QUEUES.review,{articleId},{singletonKey:articleId});
      else await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority: PRIORITY.live });
    }
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop; ops.recover releases it once and requeues the article.
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`} WHERE id = ${articleId}`;
      return { state: "unknown-receipt" };
    }
    throw error;
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
async function afterFailure(articleId: string, error: unknown): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (error instanceof ReceiptBusyError || error instanceof BudgetExceededError) {
    // Not the article's fault: the same request is in flight, or the budget window is full.
    const seconds = error instanceof BudgetExceededError ? error.retryAfterSeconds : 60;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "waiting", retryAt };
  }
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId}`;
  const attempts = (a?.processing_attempts ?? 0) + 1;
  const refused = error instanceof ProviderRejectedError && !error.retryable;
  const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "failed" };
  }
  const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
  await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
  return { state: "retrying", retryAt };
}

export async function registerContentJobs(boss: PgBoss, concurrency = Number(process.env.ANALYZE_CONCURRENCY || 6)) {
  await ensureQueue(QUEUES.analyze);
  await refreshAnalysisPriorities();
  await boss.work<{ articleId: string; attemptTag?: string }>(QUEUES.analyze, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId, attemptTag } = job.data;
    try {
      const result = await processArticle(articleId, { attemptTag });
      if (result.state !== "unknown-receipt") {
        await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
      }
      return result;
    } catch (error) {
      return afterFailure(articleId, error);
    }
  });
  if(process.env.FINHOT_BRIEF_FIRST==='true'){
    await ensureQueue(QUEUES.review);
    await refreshReviewPriorities();
    await boss.work<{articleId:string}>(QUEUES.review,{localConcurrency:1,pollingIntervalSeconds:5},async([job])=>{
      if(!job)return;
      const {articleId}=job.data;
      const [latest]=await sql`SELECT x.output,x.relevance,a.source_id,a.title,a.discovered_at FROM articles a JOIN LATERAL
        (SELECT output,relevance FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1)x ON true
        WHERE a.id=${articleId} AND coalesce(a.published_at,a.discovered_at)>now()-interval '72 hours'`;
      if(!latest||latest.relevance!=='pass'||latest.output?.writer!=='brief'||latest.output?.reviewed)return {state:'skipped'};
      // A summary from before the processing start keeps it, unscored.
      const since=processSince();if(since&&latest.discovered_at<since)return {state:'before-start'};
      // Queued before the pre-screen (or by the sweep): a screened item keeps its summary, unscored.
      if(prescreen(latest.source_id,latest.title).action!=='full')return {state:'screened'};
      try{
        const result=await analyzeArticle(articleId,{reuseBrief:true});
        if(result&&!result.stale&&result.output){
          await publishArticle(articleId);
          if(result.output.selected)await enqueue(QUEUES.group,{articleId},{singletonKey:articleId});
        }
        return {state:result?.stale?'stale':'reviewed',selected:result?.output?.selected??false};
      }catch(error){
        if(error instanceof BudgetExceededError||error instanceof ReceiptBusyError){
          await enqueue(QUEUES.review,{articleId},{singletonKey:articleId,startAfter:error instanceof BudgetExceededError?error.retryAfterSeconds:60});
          return {state:'waiting',reason:error.message,retryAfterSeconds:error instanceof BudgetExceededError?error.retryAfterSeconds:60};
        }
        throw error;
      }
    });
  }
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.extractBody);
  await boss.work<{ articleId: string }>(QUEUES.extractBody, { localConcurrency: Math.max(1,Number(process.env.EXTRACT_CONCURRENCY)||4), pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId } = job.data;
    try {
      const state = await extractArticleBody(articleId);
      await queueProcessing(articleId, { step: "analyze" });
      return { state };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} RETURNING processing_attempts`;
      if ((a?.processing_attempts ?? MAX_EXTRACT_FAILURES) < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL WHERE id = ${articleId} AND body_status = 'pending'`;
      await queueProcessing(articleId, { step: "analyze" });
      return { state: "unconfirmed" };
    }
  });
}

/**
 * Safety net: articles waiting for processing that no queue holds (crash between write and enqueue,
 * a lost job, a retry that came due). Articles already queued or running are left alone.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  await refreshAnalysisPriorities();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  for (const r of rows) await queueProcessing(r.id);
  if(process.env.FINHOT_BRIEF_FIRST==='true'){
    const since=processSince();
    const reviews=await sql`SELECT a.id FROM articles a JOIN LATERAL
      (SELECT output,relevance FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1)x ON true
      WHERE x.relevance='pass' AND x.output->>'writer'='brief' AND NOT coalesce((x.output->>'reviewed')::boolean,false)
        AND coalesce(a.published_at,a.discovered_at)>now()-interval '72 hours'
        ${since?sql`AND a.discovered_at>=${since}`:sql``}
        AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.subject='article:'||a.id::text||'@'||a.revision::text AND r.status='unknown')
      ORDER BY coalesce(a.published_at,a.discovered_at) DESC LIMIT 100`;
    for(const r of reviews)await enqueue(QUEUES.review,{articleId:r.id},{singletonKey:r.id});
    await refreshReviewPriorities();
  }
  return { enqueued: rows.length };
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = (column = "processing_error") =>
  sql.unsafe(`regexp_replace(left(coalesce(${column}, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`);

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the safety net picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql()} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}
