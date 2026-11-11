import { describe, expect, it } from "vitest";
import { WtiApiError, WtiClient } from "../src/client.js";
import { FakeWti, PROJECT } from "./fake-wti.js";

function client(fake: FakeWti, extra: Partial<ConstructorParameters<typeof WtiClient>[0]> = {}) {
  const sleeps: number[] = [];
  const instance = new WtiClient({
    token: "wti_pw_fake",
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { instance, sleeps };
}

describe("WtiClient", () => {
  it("sends the token as a Bearer header to /api/projects/current", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current", { json: PROJECT });
    const project = await client(fake).instance.getProject();

    expect(project.name).toBe("Demo app");
    const [request] = fake.requests;
    expect(request?.headers.get("authorization")).toBe("Bearer wti_pw_fake");
    expect(request?.url.origin).toBe("https://webtranslateit.com");
  });

  it("uses the numeric project id for organization tokens", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/42", { json: PROJECT });
    await client(fake, { projectId: "42" }).instance.getProject();
    expect(fake.requests[0]?.url.pathname).toBe("/api/projects/42");
  });

  it("follows Link rel=next and reports the next page when it stops early", async () => {
    const base = "https://webtranslateit.com/api/projects/current/strings";
    const fake = new FakeWti().on("GET", "/api/projects/current/strings", (request) => {
      const page = Number(request.url.searchParams.get("page") ?? 1);
      return {
        json: [{ id: page, key: `key_${page}` }],
        headers: page < 3 ? { Link: `<${base}?page=${page + 1}>; rel="next", <${base}?page=3>; rel="last"` } : {},
      };
    });

    const two = await client(fake).instance.listStrings({ "filters[key]": "x" }, 2);
    expect(two.items.map((item) => item.key)).toEqual(["key_1", "key_2"]);
    expect(two.nextPage).toBe(3);

    const all = await client(fake).instance.listStrings({}, 10);
    expect(all.items).toHaveLength(3);
    expect(all.nextPage).toBeNull();
    expect(fake.requests[0]?.url.searchParams.get("filters[key]")).toBe("x");
  });

  it("never follows a pagination link to another host", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current/strings", {
      json: [{ id: 1, key: "a" }],
      headers: { Link: '<https://evil.example.com/steal?page=2>; rel="next"' },
    });
    await expect(client(fake).instance.listStrings({}, 5)).rejects.toThrow(/Refusing to call https:\/\/evil\.example\.com/);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries 429 responses, honouring Retry-After", async () => {
    let calls = 0;
    const fake = new FakeWti().on("GET", "/api/projects/current/stats", () =>
      ++calls === 1 ? { status: 429, headers: { "Retry-After": "2" } } : { json: { de: { count_strings: 1 } } },
    );
    const { instance, sleeps } = client(fake);
    expect(await instance.getStats({})).toEqual({ de: { count_strings: 1 } });
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry a POST that failed with 502", async () => {
    const fake = new FakeWti().on("POST", "/api/projects/current/strings", { status: 502, text: "Bad gateway" });
    await expect(client(fake).instance.createString({ key: "a" })).rejects.toThrow(/502/);
    expect(fake.requests).toHaveLength(1);
  });

  it("turns API error codes into actionable messages", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current", {
      status: 401,
      json: { error: "Unauthorized", code: "legacy_token_disabled" },
    });
    const error = await client(fake).instance.getProject().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WtiApiError);
    expect((error as WtiApiError).status).toBe(401);
    expect((error as WtiApiError).message).toMatch(/only accepts API tokens/);
  });

  it("hints at WTI_PROJECT_ID when an API token matches no project", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current", {
      status: 404,
      json: { error: "No project found for this API token" },
    });
    await expect(client(fake).instance.getProject()).rejects.toThrow(/WTI_PROJECT_ID/);
  });

  it("caches the project but lets callers refresh it", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current", { json: PROJECT });
    const { instance } = client(fake);
    await instance.getProject();
    await instance.getProject();
    expect(fake.requests).toHaveLength(1);
    await instance.getProject(true);
    expect(fake.requests).toHaveLength(2);
  });
});
