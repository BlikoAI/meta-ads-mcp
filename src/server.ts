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

  // The public Bliko endpoint exposes every read plus only the guarded writes
  // required for plan/apply publishing. A separate private instance runs with
  // MCP_TOOL_PROFILE=admin for backwards-compatible access to all tools.
  if (process.env["MCP_TOOL_PROFILE"] === "safe") {
    const guardedWrites = new Set([
      "ads_begin_asset_upload", "ads_upload_asset_chunk", "ads_finalize_asset_upload", "ads_delete_asset_upload",
      "ads_apply_publish_bundle", "ads_apply_activate_bundle", "ads_pause_publish_bundle",
      "ads_create_test_lead",
    ]);
    const hiddenReads = new Set([
      "ads_list_tokens", "ads_get_gemini_key_status", "ads_library_get_apify_token_status",
    ]);
    const original = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: unknown) => {
      if (!name.startsWith("whatsapp_") && !hiddenReads.has(name)
        && (config.annotations?.readOnlyHint === true || guardedWrites.has(name))) {
        return original(name, config as never, handler as never);
      }
      logger.debug({ event: "safe_profile_tool_hidden", tool: name }, "Tool hidden by safe profile");
      return undefined as never;
    }) as typeof server.registerTool;
  }

  registerAllTools(server);
  registerSkillPrompts(server);
  registerSkillResources(server);

  return server;
}
