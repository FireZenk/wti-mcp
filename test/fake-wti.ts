/** A scripted stand-in for the WebTranslateIt API, used as `fetch`. */

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  json?: unknown;
  form?: FormData;
  text?: string;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Handler = (request: RecordedRequest) => FakeReply;

export class FakeWti {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; path: string; handler: Handler }[] = [];

  /** `path` is matched against the URL pathname, e.g. `/api/projects/current/strings`. */
  on(method: string, path: string, reply: FakeReply | Handler): this {
    this.routes.push({ method, path, handler: typeof reply === "function" ? reply : () => reply });
    return this;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = { method, url, headers };
    if (init?.body instanceof FormData) request.form = init.body;
    else if (typeof init?.body === "string") {
      request.text = init.body;
      if (headers.get("content-type") === "application/json") request.json = JSON.parse(init.body);
    }
    this.requests.push(request);

    const route = this.routes.find((candidate) => candidate.method === method && candidate.path === url.pathname);
    if (!route) return new Response(JSON.stringify({ error: `No fake route for ${method} ${url.pathname}` }), { status: 404 });
    const reply = route.handler(request);
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? "");
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;

  find(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && request.url.pathname === path);
  }
}

export const PROJECT = {
  project: {
    id: 42,
    name: "Demo app",
    source_locale: { code: "en", name: "English" },
    target_locales: [
      { code: "en", name: "English" },
      { code: "de", name: "German" },
      { code: "fr", name: "French" },
    ],
    project_files: [
      { id: 10, name: "res/values/strings.xml", locale_code: "en", master_project_file_id: null, updated_at: "2026-11-01T10:00:00Z" },
      { id: 11, name: "res/values-de/strings.xml", locale_code: "de", master_project_file_id: 10 },
      { id: 12, name: "res/values-fr/strings.xml", locale_code: "fr", master_project_file_id: 10 },
    ],
  },
};
