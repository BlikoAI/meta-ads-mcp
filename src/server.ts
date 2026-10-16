import { operatorContext, operatorGrantAllowed } from "./auth/operator.js";
import { OPERATOR_WRITES, safeRead, operatorArgumentsAllowed, publishedTools } from "./tools/operator-policy.js";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import { SERVER_INSTRUCTIONS } from "./skills/instructions.js";
import { registerSkillPrompts } from "./skills/prompts.js";
import { registerSkillResources } from "./skills/resources.js";
import { logger } from "./utils/logger.js";

/**
 * Read from package.json rather than kept in step by hand: the two had already
 * drifted. `rootDir: src` rules out importing the file, so it is read at
 * startup, once, and a failure falls back rather than taking the server down.
 */
let cachedVersion: string | undefined;

function serverVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
      cachedVersion = version;
      return version;
    }
  } catch {
    // fall through
  }
  logger.warn({ event: "server_version_unknown" }, "Could not read the version from package.json");
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/**
 * Create a new MCP server instance with all Meta Ads tools registered.
 *
 * In stateless HTTP mode, a new server is created per request.
 * In stdio mode, a single server is used for the session.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "meta-ads-mcp",
      version: serverVersion(),
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const profile = process.env["MCP_TOOL_PROFILE"];
  if (profile && !["safe", "operator", "admin"].includes(profile)) throw new Error("Unknown MCP_TOOL_PROFILE");
  if (profile === "safe" || profile === "operator") {
    const identity = operatorContext.getStore();
    const isOperator = () => profile === "operator" && identity !== undefined && operatorGrantAllowed(identity);
    const names = new Set<string>();
    publishedTools.set(server, names);
    const original = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: (...args: unknown[]) => Promise<unknown>) => {
      const read = safeRead(name, config.annotations?.readOnlyHint);
      if (!read && !(isOperator() && OPERATOR_WRITES.has(name))) return undefined as never;
      names.add(name);
      const guarded = async (...args: unknown[]) => {
        const allowed = read || (isOperator() && OPERATOR_WRITES.has(name) && operatorArgumentsAllowed(args[0]));
        const audit = { event: "operator_tool", tool: name, subject: identity?.subject,
          connection_id: identity?.connectionId, profile, write: !read };
        logger.info({ ...audit, decision: allowed ? "allow" : "deny" }, "MCP access decision");
        if (!allowed) return { isError: true, content: [{ type: "text", text: "Access denied by operator policy" }] };
        try {
          const result = await handler(...args);
          logger.info({ ...audit, outcome: (result as { isError?: boolean })?.isError ? "error" : "success" }, "MCP tool completed");
          return result;
        } catch (error) {
          logger.info({ ...audit, outcome: "error" }, "MCP tool failed");
          throw error;
        }
      };
      return original(name, config as never, guarded as never);
    }) as typeof server.registerTool;
  }

  registerAllTools(server);
  registerSkillPrompts(server);
  registerSkillResources(server);

  return server;
}
