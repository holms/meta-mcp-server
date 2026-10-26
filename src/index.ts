#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MetaApiClient } from "./services/api.js";
import { registerPageTools } from "./tools/pages.js";
import { registerInstagramTools } from "./tools/instagram.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerAudiencesTools } from "./tools/audiences.js";
import { registerInsightsTools } from "./tools/insights.js";
import { registerThreadsTools } from "./tools/threads.js";
import { registerAdLibraryTools } from "./tools/ad_library.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerChartTools } from "./tools/charts.js";
import { registerCommerceTools } from "./tools/commerce.js";
import { resolveApiKey } from "./op-fallback.js";
import {
  captureFatalError,
  captureToolError,
  errorReportingEnabled,
  flushErrorReporting,
  initErrorReporting,
} from "./error-reporting.js";
import { instrumentToolErrors } from "./services/tool-errors.js";

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

// Optional Sentry reporting; a no-op unless SENTRY_DSN is set.
await initErrorReporting({ release: `meta-mcp-server@${VERSION}` });
if (errorReportingEnabled()) {
  // Exit after a bounded Sentry flush. These handlers replace Node's
  // defaults, so they are installed only when reporting is on.
  const exitAfterFlush = (code: number) => {
    void flushErrorReporting(2000).finally(() => process.exit(code));
  };
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    captureFatalError("uncaughtException", error);
    exitAfterFlush(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
    captureFatalError("unhandledRejection", reason);
    exitAfterFlush(1);
  });
  process.once("SIGTERM", () => exitAfterFlush(143));
  process.once("SIGINT", () => exitAfterFlush(130));
}

resolveApiKey("META_ACCESS_TOKEN", "op://Development/Meta Access Token/credential");
resolveApiKey("THREADS_ACCESS_TOKEN", "op://Development/Threads Access Token/credential");

const token = process.env.META_ACCESS_TOKEN ?? "";
const threadsToken = process.env.THREADS_ACCESS_TOKEN;

const client = new MetaApiClient(token, threadsToken);

const server = new McpServer({
  name: "meta-mcp-server",
  version: VERSION,
});
if (errorReportingEnabled()) instrumentToolErrors(server, captureToolError);

registerPageTools(server, client);
registerInstagramTools(server, client);
registerAdsTools(server, client);
registerAudiencesTools(server, client);
registerInsightsTools(server, client);
registerThreadsTools(server, client);
registerAdLibraryTools(server, client);
registerConversionTools(server, client);
registerUtilityTools(server, client);
registerChartTools(server);
registerCommerceTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
