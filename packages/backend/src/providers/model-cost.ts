import { sql } from "../db.ts";
import type { CallOutcome } from "./receipts.ts";

export interface ModelCharge {
  amount: number;
  currency: string;
  inputRate: number;
  outputRate: number;
}

// Use the provider's highest rates, without cache discounts. Byte length bounds text tokens;
// the margin covers the chat template. Extra generations, images and tools need their own pricing.
export async function reserveModelCharge(service: string, model: string, endpoint: string, body: Record<string, unknown>): Promise<ModelCharge | null> {
  const [price] = await sql<{ currency: string; input_per_mtok: number; output_per_mtok: number }[]>`
    SELECT currency, input_per_mtok, output_per_mtok FROM service_prices
    WHERE service = ${service} AND model = ${model} AND endpoint_url = ${endpoint.replace(/\/+$/, "")}
      AND verified_on BETWEEN current_date - 30 AND current_date
      AND input_per_mtok >= 0 AND output_per_mtok >= 0 AND coalesce(per_request, 0) = 0`;
  if (!price) return null;
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!Array.isArray(messages) || messages.some((m) => typeof m.content !== "string")) return null;
  const allowed = new Set(["model", "messages", "temperature", "max_tokens", "response_format", "thinking", "enable_thinking", "reasoning_effort", "top_p", "n", "stream"]);
  if (Object.keys(body).some((k) => !allowed.has(k)) || (body.n !== undefined && body.n !== 1) || body.stream) return null;
  const max = Number(body.max_tokens);
  if (!Number.isSafeInteger(max) || max <= 0 || max > 32768 || body.model !== model) return null;
  const inputBound = Buffer.byteLength(JSON.stringify(body), "utf8") + 4096;
  const amount = Math.ceil((inputBound * price.input_per_mtok + max * price.output_per_mtok)) / 1_000_000;
  return { amount, currency: price.currency, inputRate: price.input_per_mtok, outputRate: price.output_per_mtok };
}

export function modelUsageCharge(charge: ModelCharge | null, usage: Record<string, unknown> | null): CallOutcome["cost"] {
  if (!charge) return null;
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  const valid = [input, output].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
  // Missing or malformed usage retains the full reservation, including malformed paid responses.
  const amount = valid
    ? Math.ceil((Number(input) * charge.inputRate + Number(output) * charge.outputRate)) / 1_000_000
    : charge.amount;
  return { amount, currency: charge.currency, basis: "estimated" };
}
