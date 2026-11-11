import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WtiClient } from "../client.js";

export interface ToolContext {
  client: WtiClient;
  readOnly: boolean;
  allowDelete: boolean;
}

/** A mistake in the tool's arguments; reported to the model as a tool error. */
export class InputError extends Error {
  override name = "InputError";
}

/** Runs a tool body and turns its value (or error) into an MCP tool result. */
export async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await body();
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export const ASYNC_NOTE =
  "Accepted: WebTranslateIt applies this change in the background, so it can take a few seconds to show up.";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
export const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

export const locale = () =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/, "Use a locale code such as en, de, pt-BR or en_GB")
    .describe("Locale code as used in the project, e.g. `de`, `fr-BE`, `pt-PT`.");

export const id = (description: string) => z.number().int().positive().describe(description);

/** "de-DE, fr-FR" → ["de-DE", "fr-FR"]; "*" or nothing → []. */
export function splitLocales(value: string | undefined): string[] {
  if (!value || value.trim() === "*") return [];
  return value.split(",").map((code) => code.trim()).filter(Boolean);
}

/**
 * Fails with the project's locale codes when a code isn't one of them. WTI
 * silently returns nothing for unknown locales, so `de` in a project that has
 * `de-DE` would otherwise look like "no translations".
 */
export async function checkLocales(client: WtiClient, codes: Iterable<string>): Promise<void> {
  const wanted = [...codes];
  if (wanted.length === 0) return;
  const project = await client.getProject();
  const known = [project.source_locale?.code, ...(project.target_locales ?? []).map((target) => target.code)].filter(
    (code): code is string => Boolean(code),
  );
  const knownSet = new Set(known);
  const unknown = [...new Set(wanted.filter((code) => !knownSet.has(code)))];
  if (unknown.length === 0) return;

  const described = unknown.map((code) => {
    const language = code.toLowerCase().split(/[-_]/)[0] ?? "";
    const similar = known.filter((candidate) => candidate.toLowerCase().split(/[-_]/)[0] === language);
    return similar.length ? `"${code}" (did you mean ${similar.join(" or ")}?)` : `"${code}"`;
  });
  throw new InputError(
    `Unknown locale ${described.join(", ")}. Project locales: ${[...new Set(known)].sort().join(", ")}.`,
  );
}

/** Runs `worker` over `items` with at most `limit` calls in flight (WTI allows ~25 req/s). */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}
