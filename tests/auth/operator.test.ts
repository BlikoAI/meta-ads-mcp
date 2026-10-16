import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { operatorContext, verifyOperatorIdentity } from "../../src/auth/operator.js";
import { operatorArgumentsAllowed, OPERATOR_WRITES } from "../../src/tools/operator-policy.js";
import { metaApiClient } from "../../src/meta/client.js";

const directory = mkdtempSync(join(tmpdir(), "operator-tests-"));
const aclPath = join(directory, "acl.json");
const identity = { subject: "test-person", connectionId: "test-connection" };
const secret = "unit-test-assertion-secret-not-production";
function allow() { writeFileSync(aclPath, JSON.stringify({ grants: [{ ...identity, expiresAt: Date.now() + 60000 }] })); }
function assertion(body: unknown, overrides = {}, signingKey = secret) {
  const payload = Buffer.from(JSON.stringify({ ...identity, aud: "bliko-meta-ads-operator",
    exp: Date.now() + 15000, nonce: randomBytes(24).toString("base64url"),
    digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"), ...overrides })).toString("base64url");
  return payload + "." + createHmac("sha256", signingKey).update(payload).digest("base64url");
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("operator request authorization", () => {
  it("binds trusted assertions to body, audience, time, grant and one request", () => {
    allow(); vi.stubEnv("OPERATOR_ACL_PATH", aclPath);
    const body = { method: "tools/list" };
    const header = assertion(body);
    expect(verifyOperatorIdentity(header, body, secret)).toEqual(identity);
    expect(verifyOperatorIdentity(header, body, secret)).toBeUndefined();
    expect(verifyOperatorIdentity(undefined, body, secret)).toBeUndefined();
    expect(verifyOperatorIdentity(assertion(body), { method: "tools/call" }, secret)).toBeUndefined();
    for (const override of [{ aud: "other" }, { exp: Date.now() - 1 },
      { exp: Date.now() + 60000 }, { subject: "other" }, { connectionId: "other" }]) {
      expect(verifyOperatorIdentity(assertion(body, override), body, secret)).toBeUndefined();
    }
    expect(verifyOperatorIdentity(assertion(body, {}, secret + "-wrong"), body, secret)).toBeUndefined();
    writeFileSync(aclPath, "{}");
    expect(verifyOperatorIdentity(assertion(body), body, secret)).toBeUndefined();
  });
  it("fails closed with absent or unreadable ACL and short secret", () => {
    vi.stubEnv("OPERATOR_ACL_PATH", join(directory, "missing"));
    expect(verifyOperatorIdentity(assertion({}), {}, secret)).toBeUndefined();
    expect(verifyOperatorIdentity(assertion({}), {}, "short")).toBeUndefined();
  });
});
async function withClient(profile: string, authenticated: boolean, run: (client: Client) => Promise<void>) {
  vi.stubEnv("MCP_TOOL_PROFILE", profile);
  vi.stubEnv("OPERATOR_ACL_PATH", aclPath);
  allow();
  const server = authenticated ? operatorContext.run(identity, createServer) : createServer();
  const client = new Client({ name: "acl-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { await run(client); } finally { await client.close(); await server.close(); }
}
describe("operator tools/list and direct tools/call", () => {
  it("publishes writes only with a grant and denies direct hidden calls", async () => {
    for (const [profile, authenticated] of [["safe", false], ["operator", false]] as const) {
      await withClient(profile, authenticated, async client => {
        const tools = (await client.listTools()).tools;
        expect(tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
        expect((await client.callTool({ name: "ads_create_ad", arguments: {} })).isError).toBe(true);
      });
    }
    await withClient("operator", true, async client => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain("ads_create_ad");
      expect(names).toContain("ads_create_ad_set");
      for (const tool of OPERATOR_WRITES) expect(names).toContain(tool);
      for (const name of ["ads_delete_campaign", "ads_delete_asset_upload", "ads_register_token",
        "ads_list_tokens", "ads_update_entity", "whatsapp_update_business_profile"]) {
        expect(names).not.toContain(name);
        expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
      }
    });
  });
  it("blocks deletion through status and rechecks revocation before calling Meta", async () => {
    const post = vi.spyOn(metaApiClient, "postForm").mockResolvedValue({ success: true });
    await withClient("operator", true, async client => {
      for (const status of ["DELETED", "ARCHIVED"]) {
        expect((await client.callTool({ name: "ads_update_ad",
          arguments: { ad_id: "123456789", status } })).isError).toBe(true);
      }
      expect(post).not.toHaveBeenCalled();
      expect((await client.callTool({ name: "ads_update_ad",
        arguments: { ad_id: "123456789", status: "PAUSED" } })).isError).not.toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
      writeFileSync(aclPath, JSON.stringify({ grants: [] }));
      expect((await client.callTool({ name: "ads_update_ad",
        arguments: { ad_id: "123456789", status: "ACTIVE" } })).isError).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });
  it("keeps admin tools available and restricts status values", async () => {
    await withClient("admin", false, async client => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain("ads_delete_campaign");
      expect(names).toContain("ads_register_token");
    });
    expect(operatorArgumentsAllowed({ status: "DELETED" })).toBe(false);
  });
});
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
