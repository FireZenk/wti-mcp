import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseWtiFile } from "../src/config.js";

function wtiFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wti-mcp-"));
  const path = join(dir, ".wti");
  writeFileSync(path, content);
  return path;
}

describe("parseWtiFile", () => {
  it("reads a plain or quoted api_key and project_id", () => {
    expect(parseWtiFile("api_key: abc123\nproject_id: 42\n", {})).toEqual({ apiKey: "abc123", projectId: "42" });
    expect(parseWtiFile("api_key: 'abc123'\n", {})).toEqual({ apiKey: "abc123" });
    expect(parseWtiFile('api_key: "abc123" # comment\n', {})).toEqual({ apiKey: "abc123" });
  });

  it("expands <%= ENV[...] %> like the gem's ERB", () => {
    const env = { WTI_PROJECT_API_KEY: "from-env", PID: "7" };
    const content = "api_key: <%= ENV['WTI_PROJECT_API_KEY'] %>\nproject_id: <%= ENV.fetch(\"PID\") %>\n";
    expect(parseWtiFile(content, env)).toEqual({ apiKey: "from-env", projectId: "7" });
  });

  it("ignores comments and nested keys", () => {
    const content = "# api_key: commented\nother:\n  api_key: nested\napi_key: real\n";
    expect(parseWtiFile(content, {})).toEqual({ apiKey: "real" });
  });
});

describe("loadConfig", () => {
  it("prefers WTI_API_TOKEN, then WTI_PROJECT_API_KEY, then the .wti file", () => {
    const path = wtiFile("api_key: from-file\n");
    expect(loadConfig({ WTI_API_TOKEN: "a", WTI_PROJECT_API_KEY: "b", WTI_CONFIG_FILE: path }).token).toBe("a");
    expect(loadConfig({ WTI_PROJECT_API_KEY: "b", WTI_CONFIG_FILE: path }).token).toBe("b");
    const fromFile = loadConfig({ WTI_CONFIG_FILE: path });
    expect(fromFile.token).toBe("from-file");
    expect(fromFile.tokenSource).toBe(path);
  });

  it("is read-only for read-only tokens or WTI_READ_ONLY", () => {
    expect(loadConfig({ WTI_API_TOKEN: "wti_pr_xyz" }).readOnly).toBe(true);
    expect(loadConfig({ WTI_API_TOKEN: "wti_ir_xyz" }).readOnly).toBe(true);
    expect(loadConfig({ WTI_API_TOKEN: "wti_pw_xyz" }).readOnly).toBe(false);
    expect(loadConfig({ WTI_API_TOKEN: "legacy", WTI_READ_ONLY: "true" }).readOnly).toBe(true);
  });

  it("only enables deletes when asked", () => {
    expect(loadConfig({ WTI_API_TOKEN: "x" }).allowDelete).toBe(false);
    expect(loadConfig({ WTI_API_TOKEN: "x", WTI_ALLOW_DELETE: "1" }).allowDelete).toBe(true);
  });

  it("rejects missing tokens, bad project ids and plain-http hosts", () => {
    expect(() => loadConfig({})).toThrow(/No WebTranslateIt API token/);
    expect(() => loadConfig({ WTI_API_TOKEN: "x", WTI_PROJECT_ID: "012" })).toThrow(/numeric id/);
    expect(() => loadConfig({ WTI_API_TOKEN: "x", WTI_BASE_URL: "http://example.com" })).toThrow(/https/);
    expect(loadConfig({ WTI_API_TOKEN: "x", WTI_BASE_URL: "http://localhost:3000" }).baseUrl).toBe("http://localhost:3000");
  });
});
