import { gate, stub, tag } from "./setup.ts";
// A selected item released across the 08:00 boundary must appear in the next issue exactly once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, publishArticleTx } from "@aihot/backend/publication/publish";
import { candidates, composeDaily, repairEmptyDailyReports } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `test-report-boundary-${T}`;
const provider = await stub((hit) => ({
  id: `report-boundary-${T}-${hit}`,
  choices: [{ message: { content: JSON.stringify({ title: "测试导语", leadParagraph: "测试摘要", highlights: [1] }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Report boundary test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN ('2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05', '2020-01-06', '2020-01-07', '2020-01-08')`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function analyzed(label: string, timelineAt: string): Promise<string> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/report-boundary-${T}-${label}`,
    title: `Report boundary ${label}`,
    bodyText: `Report boundary ${label} body`,
    bodyStatus: "ok",
    publishedAt: new Date(timelineAt),
    discoveredAt: new Date(timelineAt),
    via: "fetch",
  });
  assert.equal(backfill, false);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'policy', ${`标题 ${label}`}, ${`摘要 ${label}`}, 90, true)`;
  return articleId;
}

async function selected(label: string, timelineAt: string, releasedAt: string): Promise<string> {
  const articleId = await analyzed(label, timelineAt);
  const published = await publishArticle(articleId, { now: new Date(releasedAt), releasedAt: new Date(releasedAt) });
  assert.equal(published?.selected, true);
  return articleId;
}

test("a source the pack withholds (an AI source on trial) reaches no report", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES ('ai-techcrunch', 'TechCrunch AI', 'rss', 'T1', 'editorial', '2100-01-01') ON CONFLICT (id) DO UPDATE SET participation_mode = 'editorial'`;
  const at = "2020-01-05T23:58:00Z";
  const { articleId } = await upsertMaterial({ sourceId: "ai-techcrunch", url: `https://example.com/report-trial-${T}`, title: "Report trial",
    bodyText: "Report trial body", bodyStatus: "ok", publishedAt: new Date(at), discoveredAt: new Date(at), via: "fetch" });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'policy', '试运行标题', '试运行摘要', 90, true)`;
  const published = await publishArticle(articleId, { now: new Date("2020-01-05T23:59:00Z"), releasedAt: new Date("2020-01-05T23:59:00Z") });
  assert.equal(published?.selected, true, "processed and selected on the server");
  const ids = (await candidates(new Date("2020-01-05T00:00:00Z"), new Date("2020-01-06T00:00:00Z"))).map((c) => c.itemId);
  assert.equal(ids.includes(articleId), false);
});

test("reports assign delayed and boundary releases to the period readers first see them", async () => {
  const onTime = await selected("on-time", "2020-01-01T23:58:00Z", "2020-01-01T23:59:00Z");
  const delayed = await selected("delayed", "2020-01-01T23:59:00Z", "2020-01-02T00:02:00Z");
  const atBoundary = await selected("at-boundary", "2020-01-01T23:59:00Z", "2020-01-02T00:00:00Z");
  const groupedBefore = await analyzed("grouped-before", "2020-01-01T23:58:00Z");
  await publishArticle(groupedBefore, { now: new Date("2020-01-01T23:58:00Z") });
  await sql`UPDATE articles SET grouped_at = ${new Date("2020-01-01T23:59:00Z")} WHERE id = ${groupedBefore}`;
  await publishArticle(groupedBefore, { now: new Date("2020-01-01T23:59:10Z") });
  const groupedLate = await analyzed("grouped-late", "2020-01-01T23:58:00Z");
  await publishArticle(groupedLate, { now: new Date("2020-01-01T23:58:00Z") }); // gated until 08:01
  await sql`UPDATE articles SET grouped_at = ${new Date("2020-01-01T23:59:50Z")} WHERE id = ${groupedLate}`;
  const boundary = new Date("2020-01-02T00:00:00Z"); // 08:00 Beijing
  const previous = new Set((await candidates(new Date("2020-01-01T00:00:00Z"), boundary)).map((c) => c.itemId));

  assert.equal(previous.has(onTime), true);
  assert.equal(previous.has(groupedBefore), true);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(previous.has(id), false);

  await composeDaily("2020-01-02");
  await publishArticle(groupedLate, { now: new Date("2020-01-02T00:00:10Z") });
  const [release] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${groupedLate}`;
  assert.equal(release!.visible_after.toISOString(), "2020-01-02T00:00:10.000Z");
  const next = new Set((await candidates(boundary, new Date("2020-01-03T00:00:00Z"))).map((c) => c.itemId));
  assert.equal(next.has(onTime), false);
  assert.equal(next.has(groupedBefore), false);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(next.has(id), true);
  await composeDaily("2020-01-03");
  const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key IN ('2020-01-02', '2020-01-03')`;
  const items = (key: string) => new Set(reports.find((r) => r.key === key)!.content.sections.flatMap((s) => s.items.map((i) => i.itemId)));
  assert.equal(items("2020-01-02").has(onTime), true);
  assert.equal(items("2020-01-02").has(groupedBefore), true);
  assert.equal(items("2020-01-02").has(delayed), false);
  assert.equal(items("2020-01-02").has(atBoundary), false);
  assert.equal(items("2020-01-02").has(groupedLate), false);
  assert.equal(items("2020-01-03").has(onTime), false);
  assert.equal(items("2020-01-03").has(groupedBefore), false);
  assert.equal(items("2020-01-03").has(delayed), true);
  assert.equal(items("2020-01-03").has(atBoundary), true);
  assert.equal(items("2020-01-03").has(groupedLate), true);
});

/** Observe an actual PostgreSQL lock wait before advancing the clock or releasing the transaction. */
async function waitForBlocked(blocker: number, operation: Promise<unknown>) {
  const deadline = performance.now() + 5_000;
  while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
    if (performance.now() >= deadline) assert.fail("operation did not wait for the held transaction");
    await Promise.race([operation.then(() => assert.fail("operation finished before the held transaction committed")), delay(10)]);
  }
}

for (const lock of ["article", "report snapshot"] as const) {
  test(`a release waiting for the ${lock} lock uses the time after the cutoff`, async (t) => {
    const id = await analyzed(`waiting-${lock}`, "2020-01-01T23:58:00Z");
    await publishArticle(id, { now: new Date("2020-01-01T23:58:00Z") });
    await sql`UPDATE articles SET grouped_at = ${new Date("2020-01-01T23:59:00Z")} WHERE id = ${id}`;
    const acquired = gate<number>();
    const release = gate();
    const holding = sql.begin(async (tx) => {
      if (lock === "article") await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
      else await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      acquired.open(row!.pid);
      await release.promise;
    });
    let publication: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([acquired.promise, holding.then(() => assert.fail("lock holder exited before acquiring its lock"))]);
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-01T23:59:59Z") });
      publication = publishArticle(id);
      await waitForBlocked(pid, publication);
      t.mock.timers.setTime(new Date("2020-01-02T00:00:10Z").getTime());
      release.open();
      await holding;
      await publication;

      const [published] = await sql<{ visible_after: Date; visible_at: Date }[]>`
        SELECT p.visible_after, l.visible_at FROM publications p JOIN selected_ledger l ON l.article_id = p.article_id
        WHERE p.article_id = ${id} ORDER BY l.seq DESC LIMIT 1`;
      assert.equal(published!.visible_after.toISOString(), "2020-01-02T00:00:10.000Z");
      assert.equal(published!.visible_at.toISOString(), published!.visible_after.toISOString());
      const boundary = new Date("2020-01-02T00:00:00Z");
      assert.equal((await candidates(new Date("2020-01-01T00:00:00Z"), boundary)).some((c) => c.itemId === id), false);
      assert.equal((await candidates(boundary, new Date("2020-01-03T00:00:00Z"))).some((c) => c.itemId === id), true);
    } finally {
      release.open();
      await Promise.allSettled([holding, publication]);
    }
  });
}

test("daily composition waits for a pre-cutoff release to commit instead of losing it between issues", async (t) => {
  const id = await analyzed("commit-after-cutoff", "2020-01-03T23:58:00Z");
  await publishArticle(id, { now: new Date("2020-01-03T23:58:00Z") });
  await sql`UPDATE articles SET grouped_at = ${new Date("2020-01-03T23:59:00Z")} WHERE id = ${id}`;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-03T23:59:59Z") });
  const written = gate<number>();
  const commit = gate();
  const publication = sql.begin(async (tx) => {
    await publishArticleTx(tx, id);
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    written.open(row!.pid);
    await commit.promise;
  });
  let report: ReturnType<typeof composeDaily> | undefined;
  try {
    const pid = await Promise.race([written.promise, publication.then(() => assert.fail("publication exited before the commit gate"))]);
    t.mock.timers.setTime(new Date("2020-01-04T00:00:10Z").getTime());
    report = composeDaily("2020-01-04");
    await waitForBlocked(pid, report);
    commit.open();
    await publication;
    await report;
    await composeDaily("2020-01-05");
    const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
      SELECT key, content FROM reports WHERE kind = 'daily' AND key IN ('2020-01-04', '2020-01-05')`;
    const hasItem = (key: string) => reports.find((r) => r.key === key)!.content.sections.some((s) => s.items.some((item) => item.itemId === id));
    assert.equal(hasItem("2020-01-04"), true);
    assert.equal(hasItem("2020-01-05"), false);
  } finally {
    commit.open();
    await Promise.allSettled([publication, report]);
  }
});


test('empty editions recover real selected entries without paying for a lead when the budget is full',async()=>{
  await composeDaily('2020-01-06');
  const id=await selected('restored-selection','2020-01-05T20:00:00Z','2020-01-05T20:05:00Z');
  const late=await selected('next-edition-only','2020-01-05T21:00:00Z','2020-01-06T00:10:00Z');
  const [budget]=await sql`SELECT per_day FROM budgets WHERE service='deepseek'`;
  const hits=provider.hits();
  try{
    await sql`UPDATE budgets SET per_day=0 WHERE service='deepseek'`;
    assert.deepEqual(await repairEmptyDailyReports(new Date('2020-01-06T01:00:00Z'),1),['2020-01-06']);
    const [row]=await sql`SELECT content,revision FROM reports WHERE kind='daily' AND key='2020-01-06'`;
    assert.equal(row.content.generator.leadDeferred,true);assert.equal(row.content.lead,null);
    const ids=row.content.sections.flatMap((s:any)=>s.items.map((i:any)=>i.itemId));
    assert.ok(ids.includes(id));assert.ok(!ids.includes(late));
    assert.deepEqual(await repairEmptyDailyReports(new Date('2020-01-06T01:00:00Z'),1),[]);
    assert.equal(provider.hits(),hits,'budget rejection does not send a provider request');
    await composeDaily('2020-01-07');
    const [next]=await sql`SELECT content FROM reports WHERE kind='daily' AND key='2020-01-07'`;
    const nextIds=next.content.sections.flatMap((s:any)=>s.items.map((i:any)=>i.itemId));
    assert.ok(nextIds.includes(late));assert.ok(!nextIds.includes(id));
  }finally{await sql`UPDATE budgets SET per_day=${budget.per_day} WHERE service='deepseek'`;}
});


test('deployments that only display selected entries do not pay for unused report introductions',async()=>{
  const id=await selected('no-paid-intro','2020-01-07T20:00:00Z','2020-01-07T20:01:00Z');
  const hits=provider.hits();process.env.FINHOT_REPORT_LEAD_ENABLED='false';
  try{
    await composeDaily('2020-01-08');
    const [r]=await sql`SELECT content FROM reports WHERE kind='daily' AND key='2020-01-08'`;
    assert.equal(r.content.generator.leadEnabled,false);assert.equal(r.content.lead,null);
    assert.ok(r.content.sections.some((s:any)=>s.items.some((i:any)=>i.itemId===id)));assert.equal(provider.hits(),hits);
  }finally{delete process.env.FINHOT_REPORT_LEAD_ENABLED;}
});
