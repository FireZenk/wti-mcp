#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WtiClient } from "./client.js";
import { loadConfig } from "./config.js";
import { VERSION, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new WtiClient({
    token: config.token,
    projectId: config.projectId,
    baseUrl: config.baseUrl,
    userAgent: `wti-mcp/${VERSION}`,
  });
  const server = createServer(client, { readOnly: config.readOnly, allowDelete: config.allowDelete });
  await server.connect(new StdioServerTransport());

  const mode = config.readOnly ? "read-only" : config.allowDelete ? "read-write, deletes enabled" : "read-write";
  // stdout carries the MCP protocol: log to stderr only.
  console.error(`wti-mcp ${VERSION}: project ${config.projectId ?? "current"}, ${mode}, token from ${config.tokenSource}`);
}

main().catch((error: unknown) => {
  console.error(`wti-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
