import type { D1Database, Queue } from "@cloudflare/workers-types";
export interface Env {
  DB: D1Database;
  TASKS: Queue<Task>;
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  ADMIN_PASSWORD: string;
  SITE_URL: string;
  COLLECT_ENABLED: string;
  MODEL_CALLS_ENABLED: string;
  AI_DAILY_LIMIT: string;
  PREVIEW_ONLY: string;
  BACKEND_ORIGIN?: string;
  BACKEND_TOKEN?: string;
}
export type Task = { kind: "collect"; sourceId: string } | { kind: "hydrate"; id: string } | { kind: "analyze"; id: string } | { kind: "daily"; date: string };
export interface Item {
  id: string; url: string; source_id: string; source_name: string; tier: string;
  original_title: string; title: string; excerpt: string; summary: string;
  category: string; score: number | null; selected: number; state: string;
  published_at: string | null; discovered_at: string; ready_at: string | null;
  body_status: string; body_length: number; body_checked_at: string | null; body_attempts: number; material_scope: string;
}
export interface Source {
  id: string; name: string; kind: string; tier: string; enabled?: boolean;
  interval_minutes?: number; config: Record<string, any>;
  free?: {
    group: string; category?: string; homepage: string; summarySelector?: string; dateFromUrl?: boolean;
    body?: { selector?: string; urlPrefixes: string[]; pdf?: boolean };
  };
}
