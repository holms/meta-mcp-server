// Sentry reporting must never carry Meta account data. These tests run the
// real @sentry/node client against a loopback DSN and inspect the raw
// envelopes.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as reporting from "../error-reporting.js";
import { MetaApiClient } from "../services/api.js";
import { instrumentToolErrors } from "../services/tool-errors.js";
import { registerPageTools } from "../tools/pages.js";

// Synthetic private strings that must never appear in an envelope.
const POST_TEXT = "Synthetic page post sentinel about a secret launch";
const MESSAGE = "synthetic Messenger message sentinel 4417";
const TOKEN = "fake-bearer-token-a";

const envelopes: string[] = [];
let sink: Server;
let enabled = false;

beforeAll(async () => {
  delete process.env.SENTRY_DSN;
  sink = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      envelopes.push(body.toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  enabled = await reporting.initErrorReporting({
    env: { SENTRY_DSN: `http://publickey@127.0.0.1:${(sink.address() as AddressInfo).port}/1` },
    release: "meta-mcp-server@0.0.0-test",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => sink.close(() => resolve()));
});

beforeEach(() => {
  envelopes.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function eventsFrom(raw: string): any[] {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.exception);
}

// An axios failure that carries the request config (token, post body) and a
// response body echoing private content, as a real Sprout failure would.
function axiosFailure(status: number | null): AxiosError {
  const config = {
    url: `https://graph.facebook.com/v23.0/me/accounts?message=${encodeURIComponent(POST_TEXT)}`,
    params: { access_token: TOKEN, message: POST_TEXT },
    headers: new AxiosHeaders({ Accept: "application/json" }),
  } as any;
  const response = status === null ? undefined : ({ status, statusText: "x", headers: {}, config, data: { error: { message: MESSAGE, code: 1 } } } as any);
  return new AxiosError(`Request failed: ${POST_TEXT}`, status === null ? "ECONNRESET" : "ERR_BAD_RESPONSE", config, {}, response);
}

async function callTool(error: unknown, name: string, args: Record<string, unknown>, token = TOKEN) {
  vi.spyOn(axios, "get").mockRejectedValue(error);
  const server = new McpServer({ name: "meta-mcp-server", version: "0.0.0-test" });
  instrumentToolErrors(server, reporting.captureToolError);
  const client = new MetaApiClient(token);
  registerPageTools(server, client);
  const mcp = new Client({ name: "sentry-scrub-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return await mcp.callTool({ name, arguments: args });
  } finally {
    await mcp.close();
  }
}

describe("Sentry error reporting", () => {
  it("scrubEvent drops request, user, extra, breadcrumbs, and unsafe tags and contexts", () => {
    const event = reporting.scrubEvent({
      message: `Post ${POST_TEXT}`,
      request: { data: { text: POST_TEXT } },
      user: { ip_address: "203.0.113.9", email: "someone@example.com" },
      extra: { args: { text: POST_TEXT } },
      breadcrumbs: [{ message: MESSAGE }],
      server_name: "someones-laptop",
      tags: { tool: "meta_list_pages", text: POST_TEXT, source: `x ${MESSAGE}` },
      contexts: { runtime: { name: "node" }, app: { message: MESSAGE } },
      exception: { values: [{ type: "TypeError", value: `bad ${POST_TEXT}`, mechanism: { type: "generic", data: { m: MESSAGE } }, stacktrace: { frames: [{ filename: "/Users/someone/project/index.js", vars: { m: MESSAGE }, context_line: MESSAGE }] } }] },
    });
    const text = JSON.stringify(event);
    for (const secret of [POST_TEXT, MESSAGE, "203.0.113.9", "someone@example.com", "someones-laptop"]) {
      expect(text.includes(secret), `event still contains ${secret}`).toBe(false);
    }
    expect(event.tags).toEqual({ tool: "meta_list_pages" });
    expect(Object.keys(event.contexts)).toEqual(["runtime"]);
    expect(event.exception.values[0].value).toBe(reporting.SCRUBBED_MESSAGE);
  });

  it("never takes stack frames or paths from message text", () => {
    const safe = reporting.sanitizeError(new Error(`lookup failed\n    at /Users/x/secret.js:1:1\n    at ${POST_TEXT} (${MESSAGE}:2:3)`));
    for (const secret of ["/Users/x/secret.js", "secret.js", POST_TEXT, MESSAGE]) {
      expect(safe.stack?.includes(secret), `stack still contains ${secret}`).toBe(false);
    }
    expect(safe.stack).toMatch(/\n\s+at /);
    expect(reporting.relativeFramePath("C:\\Users\\someone\\Documents\\launch plan.js")).toBe("launch plan.js");
    expect(reporting.relativeFramePath("C:\\Users\\someone\\AppData\\npm-cache\\_npx\\abc\\node_modules\\axios\\index.js")).toBe("app:///node_modules/axios/index.js");
    expect(reporting.relativeFramePath(new URL("../../dist/index.js", import.meta.url).pathname)).toBe("app:///dist/index.js");
  });

  it("reports a network failure by tool name with no content, messages, or token", async () => {
    expect(enabled).toBe(true);
    const result = await callTool(axiosFailure(null), "meta_list_pages", { response_format: "json" });
    expect(result.isError).toBe(true);
    expect(await reporting.flushErrorReporting(5000)).toBe(true);

    const raw = envelopes.join("\n");
    const events = eventsFrom(raw);
    expect(events, raw).toHaveLength(1);
    const [event] = events;
    for (const secret of [POST_TEXT, "Synthetic", MESSAGE, TOKEN, "graph.facebook.com", "me/accounts", homedir()]) {
      expect(raw.includes(secret), `envelope contains ${secret}`).toBe(false);
    }
    expect(event.tags.tool).toBe("meta_list_pages");
    expect(event.tags.source).toBe("tool_handler");
    expect(event.exception.values[0].type).toBe("AxiosError");
    expect(event.exception.values[0].value).toBe(reporting.SCRUBBED_MESSAGE);
    const frames = event.exception.values[0].stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame: any) => /^(app:\/\/\/|node:)/.test(frame.filename))).toBe(true);
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.release).toBe("meta-mcp-server@0.0.0-test");
  });

  it("does not report a missing token or 4xx failures, and reports 5xx with its status", async () => {
    expect((await callTool(axiosFailure(503), "meta_list_pages", {}, "")).isError).toBe(true);
    for (const error of [axiosFailure(401), axiosFailure(400), axiosFailure(503)]) {
      expect((await callTool(error, "meta_list_pages", {})).isError).toBe(true);
    }
    expect(await reporting.flushErrorReporting(5000)).toBe(true);
    const raw = envelopes.join("\n");
    const events = eventsFrom(raw);
    expect(events, raw).toHaveLength(1);
    expect(events[0].tags).toMatchObject({ tool: "meta_list_pages", source: "meta_api", http_status: "503" });
    expect(raw.includes(POST_TEXT)).toBe(false);
    expect(raw.includes(MESSAGE)).toBe(false);
  });
});
