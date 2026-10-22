import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { BudgetExceededError, paidRequest } from "@aihot/backend/providers/receipts";
import { reserveModelCharge, modelUsageCharge } from "@aihot/backend/providers/model-cost";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";

async function budget(cap = 1) {
  const service = `money-${tag()}`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,daily_cost_limit,cost_currency)
            VALUES (${service},100,100,100,${cap},'USD')`;
  return service;
}
const request = (service: string, amount: number, currency = "USD") => ({ service, purpose: "money_test", identity: tag(), reservedCost: { amount, currency } });
after(closeDb);

test("concurrent requests reserve money before sending and cannot exceed the cap", async () => {
  const service = await budget();
  const held = gate(); const started = gate(); let calls = 0;
  const first = paidRequest(request(service, 0.6), async () => { calls++; started.open(); await held.promise; return { response: {} }; });
  await started.promise;
  await assert.rejects(paidRequest(request(service, 0.6), async () => { calls++; return { response: {} }; }), BudgetExceededError);
  held.open(); await first;
  assert.equal(calls, 1);
  await assert.rejects(paidRequest(request(service, 0.5), async () => ({ response: {} })), BudgetExceededError);
});

test("usage settles a reservation; reuse consumes no money even when the service stops", async () => {
  const service = await budget(); const req = request(service, 0.8);
  const first = await paidRequest(req, async () => ({ response: { ok: true }, cost: { amount: 0.1, currency: "USD", basis: "estimated" } }));
  await paidRequest(request(service, 0.8), async () => ({ response: {} }));
  await sql`UPDATE budgets SET daily_cost_limit=0 WHERE service=${service}`;
  const reused = await paidRequest({ ...req, reservedCost: null }, async () => assert.fail("must reuse"));
  assert.equal(reused.receiptId, first.receiptId); assert.equal(reused.reused, true);
});

test("unknown outcomes keep their reservation and a new retry cannot bypass the money cap", async () => {
  const service = await budget(); const req = request(service, 0.7);
  await assert.rejects(paidRequest(req, async () => { throw new Error("lost reply"); }));
  await sql`UPDATE receipts SET status='failed' WHERE service=${service}`;
  await assert.rejects(paidRequest(req, async () => assert.fail("cannot send")), BudgetExceededError);
});

test("unpriced requests, wrong currencies and unpriced earlier attempts fail closed", async () => {
  const service = await budget();
  await assert.rejects(paidRequest({ ...request(service, 0.1), reservedCost: null }, async () => assert.fail()), /unpriced/);
  await assert.rejects(paidRequest(request(service, 0.1, "CNY"), async () => assert.fail()), /unpriced/);
  await sql`UPDATE budgets SET daily_cost_limit=NULL,cost_currency=NULL WHERE service=${service}`;
  await paidRequest({ ...request(service, 0.1), reservedCost: null }, async () => ({ response: {} }));
  await sql`UPDATE budgets SET daily_cost_limit=1,cost_currency='USD' WHERE service=${service}`;
  await assert.rejects(paidRequest(request(service, 0.1), async () => assert.fail()), /daily cost/);
});

test("LLM pricing binds to the endpoint, expires, and accounts for final max_tokens and UTF-8 input", async () => {
  const service = await budget(); const model = tag(); const endpoint = "https://model.example/v1";
  await sql`INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok,endpoint_url,verified_on)
            VALUES (${service},${model},'USD',0.3,1.2,${endpoint},current_date)`;
  const body = { model, messages: [{ role: "user", content: "中文文字" }], max_tokens: 900 };
  const charge = await reserveModelCharge(service, model, endpoint, body);
  assert.ok(charge && charge.amount > 900 * 1.2 / 1e6);
  assert.deepEqual(modelUsageCharge(charge, { prompt_tokens: 100, completion_tokens: 50 }), { amount: 0.00009, currency: "USD", basis: "estimated" });
  assert.equal(modelUsageCharge(charge, null)?.amount, charge.amount);
  assert.equal(await reserveModelCharge(service, model, "https://other.example/v1", body), null);
  assert.equal(await reserveModelCharge(service, model, endpoint, { ...body, n: 2 }), null);
  assert.equal(await reserveModelCharge(service, model, endpoint, { ...body, max_tokens: 1e6 }), null);
  assert.equal(await reserveModelCharge(service, model, endpoint, { ...body, tools: [] }), null);
  await sql`UPDATE service_prices SET verified_on=current_date-31 WHERE service=${service}`;
  assert.equal(await reserveModelCharge(service, model, endpoint, body), null);
});

test("unusable paid model answers retain token charges and are stopped before another request", async () => {
  const model = `mock-${tag()}`;
  const provider = await stub(() => ({ choices: [{ message: { content: "not JSON" } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
  const [saved] = await sql`SELECT * FROM budgets WHERE service='llm'`;
  process.env.LLM_BASE_URL = `${provider.url}/v1`; process.env.LLM_API_KEY = "test-key"; process.env.LLM_MODEL = model;
  try {
    await sql`UPDATE budgets SET per_minute=100,per_hour=100,per_day=10000,daily_cost_limit=0.01,cost_currency='USD' WHERE service='llm'`;
    await sql`INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok,endpoint_url,verified_on)
              VALUES ('llm',${model},'USD',1,1,${process.env.LLM_BASE_URL},current_date)`;
    // Other tests' unpriced llm attempts make a new cap fail closed; isolate this service's history by timestamp.
    const earlier = await sql`UPDATE receipt_attempts SET started_at=started_at-interval '2 days' WHERE service='llm' AND started_at>now()-interval '1 day' RETURNING id`;
    const ask = () => chatJson({ model: "default", purpose: "money_test", subject: model, promptVersion: "1", system: "s", user: "u", maxTokens: 512, schema: z.object({ ok: z.boolean() }) });
    try {
      await assert.rejects(ask(), ModelOutputError);
      const [attempt] = await sql`SELECT cost,reserved_cost FROM receipt_attempts WHERE model=${model}`;
      assert.equal(attempt!.cost, 0.0002); assert.ok(attempt!.reserved_cost > attempt!.cost);
      await sql`UPDATE budgets SET daily_cost_limit=0.0002 WHERE service='llm'`;
      await assert.rejects(ask(), BudgetExceededError);
      assert.equal(provider.hits(), 1);
    } finally {
      for (const row of earlier) await sql`UPDATE receipt_attempts SET started_at=started_at+interval '2 days' WHERE id=${row.id}`;
    }
  } finally {
    if (saved) await sql`UPDATE budgets SET per_minute=${saved.per_minute},per_hour=${saved.per_hour},per_day=${saved.per_day},daily_cost_limit=${saved.daily_cost_limit},cost_currency=${saved.cost_currency} WHERE service='llm'`;
    delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
    await provider.close();
  }
});


test('money waits until sufficient rolling charges expire, not just the first tiny charge',async()=>{
  const service=await budget();
  const small=await paidRequest(request(service,0.01),async()=>({response:{}}));
  const large=await paidRequest(request(service,0.98),async()=>({response:{}}));
  await sql`UPDATE receipt_attempts SET started_at=now()-interval '23 hours 59 minutes' WHERE receipt_id=${small.receiptId}`;
  await sql`UPDATE receipt_attempts SET started_at=now()-interval '23 hours 50 minutes' WHERE receipt_id=${large.receiptId}`;
  await assert.rejects(paidRequest(request(service,0.05),async()=>assert.fail('must not spend beyond cap')),(error:any)=>{
    assert.ok(error instanceof BudgetExceededError);assert.ok(error.retryAfterSeconds>=599&&error.retryAfterSeconds<=602);return true;
  });
});
