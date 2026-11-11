/**
 * Minimal client for the WebTranslateIt REST API.
 *
 * Mirrors what the official `wti` gem does: a Bearer token in the
 * Authorization header and `/api/projects/current` (or `/api/projects/<id>`
 * for organization tokens) as the project root.
 */

export const DEFAULT_BASE_URL = "https://webtranslateit.com";

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  json?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  timeoutMs?: number;
}

export interface WtiResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface Page<T> {
  items: T[];
  /** Page number of the next page, or null when the last page was reached. */
  nextPage: number | null;
}

// ---- Raw API shapes (only the fields we use) ------------------------------

export interface RawLocale {
  code: string;
  name?: string;
  type?: string;
}

export interface RawProjectFile {
  id: number;
  name: string;
  locale_code: string;
  master_project_file_id: number | null;
  updated_at?: string;
  hash_file?: string;
  fresh?: boolean;
}

export interface RawProject {
  id: number;
  name: string;
  source_locale: RawLocale;
  target_locales: RawLocale[];
  project_files: RawProjectFile[];
}

export type TranslationText = string | Record<string, string> | null;

export interface RawTranslation {
  id?: number;
  locale: string;
  text: TranslationText;
  status?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface RawString {
  id: number;
  key: string;
  plural?: boolean;
  type?: string;
  dev_comment?: string | null;
  status?: string;
  labels?: string | string[] | null;
  category?: string | null;
  categories?: unknown;
  context?: string | null;
  word_count?: number;
  character_count?: number;
  created_at?: string;
  updated_at?: string;
  file?: { id: number; name?: string } | null;
  translations?: RawTranslation | RawTranslation[] | null;
  has_discussions?: boolean;
}

export interface RawTerm {
  id: number;
  text: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface RawTermTranslation {
  id: number;
  locale: string;
  text: string;
  description?: string | null;
  /** The API reads back numbers: 1 approved, 0 proposed, -1 refused. */
  status?: string | number;
  created_at?: string;
  updated_at?: string;
}

export type RawStats = Record<string, Record<string, unknown>>;

// ---- Errors ----------------------------------------------------------------

export class WtiApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "WtiApiError";
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  legacy_token_disabled:
    "This project only accepts API tokens now. Create a token in Project settings → API " +
    "(or Account settings → API tokens) and set it in WTI_API_TOKEN.",
  invalid_token:
    "This API token was revoked or has expired. Create a new token in Project settings → API " +
    "(or Account settings → API tokens).",
  insufficient_scope: "This is a read-only token; this operation needs a read & write token.",
};

const ORGANIZATION_TOKEN_HINT =
  "No project matched this API token at /api/projects/current. Either the project doesn't accept API " +
  "tokens yet (a manager can switch it in Project settings → API), or this is an organization token: " +
  "set WTI_PROJECT_ID to the project's numeric id.";

// ---- Client ----------------------------------------------------------------

export interface WtiClientOptions {
  token: string;
  /** Numeric project id. Required for organization tokens; otherwise `current` is used. */
  projectId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** Retried for safe methods only: the request may have been processed. */
const RETRYABLE_SAFE = new Set([502, 504]);

export class WtiClient {
  readonly projectPath: string;
  private readonly token: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private projectCache: Promise<RawProject> | undefined;

  constructor(options: WtiClientOptions) {
    if (!options.token) throw new Error("A WebTranslateIt API token is required.");
    this.token = options.token;
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    this.projectPath = options.projectId ? `/api/projects/${options.projectId}` : "/api/projects/current";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? "wti-mcp";
  }

  /** `strings/12` → `/api/projects/current/strings/12` */
  projectUrl(subpath = ""): string {
    return subpath ? `${this.projectPath}/${subpath}` : this.projectPath;
  }

  buildUrl(path: string, query?: Query): URL {
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.append(name, String(value));
    }
    return url;
  }

  async request(method: string, pathOrUrl: string | URL, options: RequestOptions = {}): Promise<WtiResponse> {
    const url = typeof pathOrUrl === "string" ? this.buildUrl(pathOrUrl, options.query) : pathOrUrl;
    // Never send the token anywhere but the configured WebTranslateIt host.
    if (url.origin !== this.baseUrl.origin) {
      throw new WtiApiError(`Refusing to call ${url.origin}: only ${this.baseUrl.origin} is allowed.`, 0);
    }

    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({
        Authorization: `Bearer ${this.token}`,
        "User-Agent": this.userAgent,
        Accept: "*/*",
      });
      let body: string | FormData | undefined;
      if (options.json !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.json);
      } else if (options.form) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
        body = new URLSearchParams(options.form).toString();
      } else if (options.multipart) {
        body = options.multipart; // fetch sets the multipart boundary
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        });
      } catch (error) {
        if (SAFE_METHODS.has(method) && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new WtiApiError(`Request to WebTranslateIt failed: ${errorMessage(error)}`, 0);
      }

      const retryable = response.status === 429 || (SAFE_METHODS.has(method) && RETRYABLE_SAFE.has(response.status));
      if (retryable && attempt < this.maxRetries) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt));
        continue;
      }

      const text = await response.text();
      if (response.status >= 400) throw this.toError(response.status, text, url);
      return { status: response.status, headers: response.headers, text };
    }
  }

  async getJson<T>(path: string, query?: Query): Promise<T> {
    const response = await this.request("GET", path, { query });
    return parseJson<T>(response.text);
  }

  /** Walks the `Link: <…>; rel="next"` header, up to `maxPages` pages. */
  async paginate<T>(path: string, query: Query, maxPages: number): Promise<Page<T>> {
    let url: URL | null = this.buildUrl(path, query);
    const items: T[] = [];
    for (let fetched = 0; url && fetched < maxPages; fetched++) {
      const response = await this.request("GET", url);
      const data = parseJson<unknown>(response.text);
      if (!Array.isArray(data)) {
        throw new WtiApiError(`Unexpected response from ${url.pathname}: expected a list.`, response.status);
      }
      items.push(...(data as T[]));
      url = nextLink(response.headers.get("link"), this.baseUrl);
    }
    return { items, nextPage: url ? pageNumber(url) : null };
  }

  // ---- Project ---------------------------------------------------------------

  getProject(refresh = false): Promise<RawProject> {
    if (!this.projectCache || refresh) {
      const pending = this.getJson<{ project: RawProject }>(this.projectPath).then((body) => {
        if (!body?.project) throw new WtiApiError("Unexpected project response from WebTranslateIt.", 200);
        return body.project;
      });
      pending.catch(() => {
        if (this.projectCache === pending) this.projectCache = undefined;
      });
      this.projectCache = pending;
    }
    return this.projectCache;
  }

  getStats(query: Query): Promise<RawStats> {
    return this.getJson<RawStats>(this.projectUrl("stats"), query);
  }

  // ---- Strings & translations -----------------------------------------------

  listStrings(query: Query, maxPages: number): Promise<Page<RawString>> {
    return this.paginate<RawString>(this.projectUrl("strings"), query, maxPages);
  }

  getString(id: number, locale?: string): Promise<RawString> {
    return this.getJson<RawString>(this.projectUrl(`strings/${id}`), { locale });
  }

  async createString(body: Record<string, unknown>): Promise<RawString> {
    const response = await this.request("POST", this.projectUrl("strings"), { json: body });
    return parseJson<RawString>(response.text);
  }

  async updateString(id: number, body: Record<string, unknown>): Promise<number> {
    const response = await this.request("PUT", this.projectUrl(`strings/${id}`), { json: body });
    return response.status;
  }

  async deleteString(id: number): Promise<number> {
    const response = await this.request("DELETE", this.projectUrl(`strings/${id}`));
    return response.status;
  }

  async saveTranslation(stringId: number, locale: string, body: Record<string, unknown>): Promise<number> {
    const path = this.projectUrl(`strings/${stringId}/locales/${encodeURIComponent(locale)}/translations`);
    const response = await this.request("POST", path, { json: body });
    return response.status;
  }

  // ---- Files -------------------------------------------------------------------

  async downloadFile(fileId: number, locale: string): Promise<string> {
    const response = await this.request("GET", this.projectUrl(`files/${fileId}/locales/${encodeURIComponent(locale)}`));
    return response.text;
  }

  async uploadFile(fileId: number, locale: string, form: FormData): Promise<number> {
    const path = this.projectUrl(`files/${fileId}/locales/${encodeURIComponent(locale)}`);
    const response = await this.request("PUT", path, { multipart: form, timeoutMs: 300_000 });
    return response.status;
  }

  // ---- Locales -----------------------------------------------------------------

  async addLocale(code: string): Promise<number> {
    const response = await this.request("POST", this.projectUrl("locales"), { form: { id: code } });
    return response.status;
  }

  async removeLocale(code: string): Promise<number> {
    const response = await this.request("DELETE", this.projectUrl(`locales/${encodeURIComponent(code)}`));
    return response.status;
  }

  // ---- Glossary (term base) --------------------------------------------------

  listTerms(maxPages: number): Promise<Page<RawTerm>> {
    return this.paginate<RawTerm>(this.projectUrl("terms"), {}, maxPages);
  }

  async createTerm(body: Record<string, unknown>): Promise<RawTerm> {
    const response = await this.request("POST", this.projectUrl("terms"), { json: body });
    return parseJson<RawTerm>(response.text);
  }

  async updateTerm(id: number, body: Record<string, unknown>): Promise<number> {
    const response = await this.request("PUT", this.projectUrl(`terms/${id}`), { json: body });
    return response.status;
  }

  async deleteTerm(id: number): Promise<number> {
    const response = await this.request("DELETE", this.projectUrl(`terms/${id}`));
    return response.status;
  }

  async getTermTranslations(termId: number, locale: string): Promise<RawTermTranslation[]> {
    const path = this.projectUrl(`terms/${termId}/locales/${encodeURIComponent(locale)}/translations`);
    const data = await this.getJson<RawTermTranslation[] | null>(path);
    return Array.isArray(data) ? data : [];
  }

  async createTermTranslation(termId: number, locale: string, body: Record<string, unknown>): Promise<number> {
    const path = this.projectUrl(`terms/${termId}/locales/${encodeURIComponent(locale)}/translations`);
    const response = await this.request("POST", path, { json: body });
    return response.status;
  }

  async updateTermTranslation(
    termId: number,
    locale: string,
    translationId: number,
    body: Record<string, unknown>,
  ): Promise<number> {
    const path = this.projectUrl(
      `terms/${termId}/locales/${encodeURIComponent(locale)}/translations/${translationId}`,
    );
    const response = await this.request("PUT", path, { json: body });
    return response.status;
  }

  // ---- Internals ---------------------------------------------------------------

  private backoff(attempt: number): number {
    return this.retryDelayMs * 2 ** attempt;
  }

  private toError(status: number, text: string, url: URL): WtiApiError {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = JSON.parse(text) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        code = typeof record.code === "string" ? record.code : undefined;
        const parts = [record.error, record.description].filter((part) => typeof part === "string" && part);
        message = (code && FRIENDLY_MESSAGES[code]) || parts.join(": ") || undefined;
      }
    } catch {
      // Not JSON: fall back to the raw body.
    }
    message ||= text.trim().slice(0, 500) || undefined;
    if (status === 503) message ??= "Locked: another import is in progress. Try again in a moment.";
    if (status === 500) message ??= "Server temporarily unavailable.";
    message ??= `HTTP ${status}`;

    if (
      status === 404 &&
      url.pathname.startsWith("/api/projects/current") &&
      this.token.startsWith("wti_") &&
      message.startsWith("No project found for this API token")
    ) {
      message = `${message}. ${ORGANIZATION_TOKEN_HINT}`;
    }
    return new WtiApiError(`WebTranslateIt API error ${status}: ${message}`, status, code);
  }
}

export function parseJson<T>(text: string): T {
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WtiApiError(`WebTranslateIt returned a response that isn't JSON: ${text.slice(0, 200)}`, 200);
  }
}

export function nextLink(header: string | null, base: URL): URL | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (match?.[1]) return new URL(match[1], base);
  }
  return null;
}

function pageNumber(url: URL): number | null {
  const page = Number(url.searchParams.get("page"));
  return Number.isInteger(page) && page > 0 ? page : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "the request timed out";
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
