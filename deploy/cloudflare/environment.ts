// Worker bindings are not automatically inherited by a Container. Pass only application settings.
const REQUIRED = ["DATABASE_URL", "SESSION_SECRET", "ADMIN_PASSWORD", "IMG_PROXY_SIGN_SECRET"] as const;
const OPTIONAL = [
  "SITE_URL", "SITE_DOMAIN", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_EXTRA_JSON", "LLM_REASONING_HEADROOM",
  "DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY", "SELECTED_VISIBLE_AFTER_SECONDS", "LOG_LEVEL",
] as const;
const VALVES = ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"] as const;

export function containerEnvironment(bindings: object): Record<string, string> {
  const values = bindings as Record<string, unknown>;
  const missing = REQUIRED.filter((key) => typeof values[key] !== "string" || !(values[key] as string).trim());
  if (missing.length) throw new Error(`Missing Container secrets: ${missing.join(", ")}`);
  if (values.MODEL_CALLS_ENABLED === "true") {
    const absent = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"].filter((key) => !values[key]);
    if (absent.length) throw new Error(`Model calls enabled without: ${absent.join(", ")}`);
  }
  const result: Record<string, string> = {
    NODE_ENV: "production", AIHOT_DATA_DIR: "/data", TRUST_PROXY: "true",
    WEB_HOST: "0.0.0.0", WEB_PORT: "3000", API_HOST: "127.0.0.1", API_PORT: "3001",
    API_BASE_URL: "http://127.0.0.1:3001", LOCAL_ROUTER_URL: "http://127.0.0.1:3000",
    JINA_BODY_FALLBACK: "false",
  };
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    if (typeof values[key] === "string" && values[key]) result[key] = values[key] as string;
  }
  for (const key of VALVES) result[key] = values[key] === "true" ? "true" : "false";
  return result;
}
