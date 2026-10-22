import assert from "node:assert/strict";
import { test } from "node:test";
import { containerEnvironment } from "../deploy/cloudflare/environment.ts";

const secrets = { DATABASE_URL: "postgres://test.example/finhot", SESSION_SECRET: "session", ADMIN_PASSWORD: "password", IMG_PROXY_SIGN_SECRET: "image" };

test("containers receive application secrets and bind the web server externally", () => {
  const env = containerEnvironment({ ...secrets, SITE_URL: "https://finhot.fun", FINHOT: {}, CLOUDFLARE_API_TOKEN: "private", DEV_AUTH_ROLE: "admin" });
  assert.equal(env.DATABASE_URL, secrets.DATABASE_URL);
  assert.equal(env.WEB_HOST, "0.0.0.0");
  assert.equal(env.API_BASE_URL, "http://127.0.0.1:3001");
  assert.equal(env.SITE_URL, "https://finhot.fun");
  assert.equal(env.COLLECT_ENABLED, "false");
  assert.equal(env.MODEL_CALLS_ENABLED, "false");
  for (const key of ["FINHOT", "CLOUDFLARE_API_TOKEN", "DEV_AUTH_ROLE"]) assert.ok(!(key in env));
});

test("missing database and model credentials fail before starting a broken container", () => {
  assert.throws(() => containerEnvironment({}), /Missing Container secrets: DATABASE_URL/);
  assert.throws(() => containerEnvironment({ ...secrets, MODEL_CALLS_ENABLED: "true" }), /LLM_API_KEY/);
  const env = containerEnvironment({ ...secrets, MODEL_CALLS_ENABLED: "true", LLM_BASE_URL: "https://model.example/v1", LLM_API_KEY: "model-key", LLM_MODEL: "model", LLM_EXTRA_JSON: '{"reasoning_effort":"low"}' });
  assert.equal(env.LLM_API_KEY, "model-key");
  assert.equal(env.MODEL_CALLS_ENABLED, "true");
});
