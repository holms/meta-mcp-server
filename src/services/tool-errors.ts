import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaUserError } from "./api.js";

// Called with (toolName, error, details) when a tool fails unexpectedly.
// Tool arguments are never passed.
export type ToolErrorReporter = (toolName: string, error: unknown, details: { httpStatus?: number }) => void;


const toolErrorContext = new AsyncLocalStorage<{ toolName: string; onToolError: ToolErrorReporter }>();

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("isAxiosError" in error)) return undefined;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : undefined;
}

// Missing tokens, bad input, and Graph API 4xx answers (bad parameters,
// permissions, expired tokens, rate limits) are the caller's to fix, not
// defects. Code errors, Graph API 5xx answers, network failures, and
// timeouts are.
export function shouldReportToolError(error: unknown): boolean {
  if (error instanceof MetaUserError) return false;
  const status = responseStatus(error);
  return !(status !== undefined && status >= 400 && status < 500);
}

/** Report a failed tool call from inside a tool handler, by tool name only. */
export function reportToolError(error: unknown): void {
  const context = toolErrorContext.getStore();
  if (!context || !shouldReportToolError(error)) return;
  try {
    context.onToolError(context.toolName, error, { httpStatus: responseStatus(error) });
  } catch {
    // Reporting must never change a tool's result.
  }
}

/**
 * Track the active tool name for reportToolError, and report handler errors
 * that escape errorResult before the MCP SDK turns them into an error
 * result. Call before registering tools; covers server.tool and
 * server.registerTool.
 */
export function instrumentToolErrors(server: McpServer, onToolError: ToolErrorReporter): void {
  const wrap = (name: string, handler: (...args: any[]) => unknown) => (...args: any[]) =>
    toolErrorContext.run({ toolName: name, onToolError }, async () => {
      try {
        return await handler(...args);
      } catch (error) {
        reportToolError(error);
        throw error;
      }
    });
  const target = server as any;
  for (const method of ["tool", "registerTool"] as const) {
    const original = target[method].bind(server);
    target[method] = (name: string, ...rest: any[]) => {
      const handler = rest.pop();
      return original(name, ...rest, typeof handler === "function" ? wrap(name, handler) : handler);
    };
  }
}
