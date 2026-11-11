import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BASE_URL } from "./client.js";

export interface WtiConfig {
  token: string;
  /** Where the token came from, for the startup log. Never the token itself. */
  tokenSource: string;
  projectId?: string;
  baseUrl: string;
  readOnly: boolean;
  allowDelete: boolean;
}

type Env = Record<string, string | undefined>;

const TRUTHY = /^(1|true|yes|on)$/i;
const ERB_ENV = /<%=\s*ENV(?:\[\s*['"]([A-Za-z_]\w*)['"]\s*\]|\.fetch\(\s*['"]([A-Za-z_]\w*)['"][^)]*\))\s*%>/g;

/**
 * Reads `api_key` and `project_id` from a `.wti` file, the YAML file the `wti`
 * gem uses. Only top-level keys are read; `<%= ENV['NAME'] %>` is expanded
 * from the environment, like the gem does through ERB.
 */
export function parseWtiFile(content: string, env: Env): { apiKey?: string; projectId?: string } {
  const result: { apiKey?: string; projectId?: string } = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^(api_key|project_id):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
    value = unquote(value);
    value = value.replace(ERB_ENV, (_, bracket?: string, fetched?: string) => env[bracket ?? fetched ?? ""] ?? "").trim();
    if (!value) continue;
    if (match[1] === "api_key") result.apiKey = value;
    else result.projectId = value;
  }
  return result;
}

export function loadConfig(env: Env = process.env): WtiConfig {
  let token = env.WTI_API_TOKEN?.trim() || env.WTI_PROJECT_API_KEY?.trim() || undefined;
  let tokenSource = env.WTI_API_TOKEN?.trim() ? "WTI_API_TOKEN" : "WTI_PROJECT_API_KEY";
  let projectId = env.WTI_PROJECT_ID?.trim() || undefined;

  const configFile = env.WTI_CONFIG_FILE?.trim();
  if (configFile) {
    const path = resolve(configFile);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`Cannot read WTI_CONFIG_FILE ${path}: ${(error as Error).message}`);
    }
    const parsed = parseWtiFile(content, env);
    if (!token && parsed.apiKey) {
      token = parsed.apiKey;
      tokenSource = path;
    }
    projectId ??= parsed.projectId;
  }

  if (!token) {
    throw new Error(
      "No WebTranslateIt API token. Set WTI_API_TOKEN (or WTI_PROJECT_API_KEY), " +
        "or point WTI_CONFIG_FILE at a .wti file.",
    );
  }
  if (projectId && !/^[1-9]\d*$/.test(projectId)) {
    throw new Error(
      `WTI_PROJECT_ID must be the numeric id of the project (digits only, no leading zero), got "${projectId}".`,
    );
  }

  const baseUrl = env.WTI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const parsedUrl = new URL(baseUrl);
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !isLocal) {
    throw new Error(`WTI_BASE_URL must use https (got ${baseUrl}).`);
  }

  return {
    token,
    tokenSource,
    projectId,
    baseUrl,
    // `wti_pr_…` / `wti_ir_…` tokens are read-only: don't offer write tools.
    readOnly: TRUTHY.test(env.WTI_READ_ONLY ?? "") || /^wti_[pi]r_/.test(token),
    allowDelete: TRUTHY.test(env.WTI_ALLOW_DELETE ?? ""),
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}
