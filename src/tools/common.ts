import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecError } from "../exec.js";

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

export function errorResult(e: unknown): ToolResult {
  const msg =
    e instanceof ExecError
      ? `${e.message}${e.result.stderr.trim() ? `\n\nstderr:\n${e.result.stderr.trim()}` : ""}`
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/**
 * Every tool goes through here so a thrown error becomes a readable isError
 * result rather than tearing down the stdio transport.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: S;
    readOnly?: boolean;
    destructive?: boolean;
  },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: config.readOnly ?? false,
        destructiveHint: config.destructive ?? false,
      },
    },
    (async (args: unknown) => {
      try {
        return await handler(args as z.objectOutputType<S, z.ZodTypeAny>);
      } catch (e) {
        return errorResult(e);
      }
    }) as never,
  );
}

/** Shared input fragments. */
export const vmArg = {
  vm: z
    .string()
    .describe("VM name (folder under VM_ROOT) or an absolute path to its .vmx file"),
};

export const credArgs = {
  credentialRef: z
    .string()
    .optional()
    .describe("Name of a stored credential in credentials.json"),
  guestUser: z.string().optional().describe("Guest username (overrides credentialRef)"),
  guestPassword: z.string().optional().describe("Guest password (overrides credentialRef)"),
};

export const confirmArg = {
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. This operation is destructive and is refused without it."),
};

export function requireConfirm(confirm: boolean | undefined, what: string): void {
  if (!confirm) {
    throw new Error(
      `Refused: ${what} is destructive. Re-issue with confirm: true if you really intend this.`,
    );
  }
}
