import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { enrollmentFor, consumeEnrollment, isOperator } from "./operator.mjs";
import { createStore, issueTokens, rotateRefresh, readAccess, revokeToken } from "./oauth.mjs";

test("enrollment binds exactly one connection; grants expire and cannot be replayed", () => {
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    const path = join(dir, "acl.json");
    const codeHash = createHash("sha256").update("fixture-enrollment").digest("hex");
    writeFileSync(path, JSON.stringify({ enrollments: [{ codeHash, subject: "person", expiresAt: 2000 }], grants: [] }));
    assert.equal(enrollmentFor("wrong", path, 1000), undefined);
    assert.equal(enrollmentFor("fixture-enrollment", path, 3000), undefined);
    assert.equal(consumeEnrollment(path, codeHash, "other", "conn", 1000), false);
    assert.equal(consumeEnrollment(path, codeHash, "person", "conn", 1000), true);
    assert.equal(consumeEnrollment(path, codeHash, "person", "other", 1000), false);
    assert.equal(isOperator({ subject: "person", connectionId: "conn" }, path, 1000), true);
    assert.equal(isOperator({ subject: "person", connectionId: "other" }, path, 1000), false);
    assert.equal(isOperator({ subject: "person", connectionId: "conn" }, path, 31 * 86400000), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("refresh keeps identity and checks client/resource before consuming; revoke invalidates chain", () => {
  const store = createStore();
  const first = issueTokens(store, { clientId: "a", resource: "resource", subject: "person", connectionId: "conn" });
  assert.equal(rotateRefresh(store, first.refreshToken, "b"), null);
  assert.equal(rotateRefresh(store, first.refreshToken, "a", "other"), null);
  const second = rotateRefresh(store, first.refreshToken, "a", "resource");
  assert.equal(readAccess(store, second.accessToken).connectionId, "conn");
  assert.equal(rotateRefresh(store, first.refreshToken, "a"), null);
  revokeToken(store, second.refreshToken);
  assert.equal(readAccess(store, first.accessToken), null);
  assert.equal(readAccess(store, second.accessToken), null);
});

test("HTTP bridge routes only enrolled grants and strips forged identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-integration-"));
  const aclPath = join(dir, "acl.json");
  const code = "fixture-one-time-enrollment";
  writeFileSync(aclPath, JSON.stringify({ grants: [], enrollments: [{
    subject: "person", codeHash: createHash("sha256").update(code).digest("hex"), expiresAt: Date.now() + 60000,
  }] }));
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    captured.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const allocator = http.createServer();
  allocator.listen(0, "127.0.0.1");
  await once(allocator, "listening");
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const base = "http://127.0.0.1:" + port;
  const upstreamBase = "http://127.0.0.1:" + upstream.address().port;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL(".", import.meta.url), env: {
    ...process.env, PORT: String(port), PUBLIC_URL: base, DATA_DIR: dir,
    UPSTREAM_MCP_URL: upstreamBase + "/safe", OPERATOR_MCP_URL: upstreamBase + "/operator",
    UPSTREAM_AUTH_MODE: "api-key", UPSTREAM_MCP_API_KEY: "fixture-upstream",
    OAUTH_LOGIN_PASSWORD: "fixture-safe-password", OAUTH_STORE_ENCRYPTION_KEY: "fixture-store-encryption-secret-long",
    OPERATOR_ASSERTION_SECRET: "fixture-assertion-secret-long-enough", OPERATOR_ACL_PATH: aclPath,
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const post = (path, form) => fetch(base + path, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const registration = await fetch(base + "/oauth/register", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        client_id: "chosen-id", client_secret: "chosen-secret", redirect_uris: ["https://chatgpt.com/callback"],
      }) });
    const client = await registration.json();
    assert.notEqual(client.client_id, "chosen-id");
    const verifier = "fixture-pkce-verifier-for-tests";
    async function authorize(password) {
      const response = await post("/oauth/authorize", {
        response_type: "code", client_id: client.client_id, redirect_uri: "https://chatgpt.com/callback",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", password,
      });
      assert.equal(response.status, 303);
      const authCode = new URL(response.headers.get("location")).searchParams.get("code");
      const token = await post("/oauth/token", { grant_type: "authorization_code",
        client_id: client.client_id, redirect_uri: "https://chatgpt.com/callback", code: authCode, code_verifier: verifier });
      assert.equal(token.status, 200);
      return token.json();
    }
    const safe = await authorize("fixture-safe-password");
    const operator = await authorize(code);
    const rpc = async (token, method = "tools/list") => fetch(base + "/mcp", { method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json",
        "x-bliko-identity": "forged", "x-meta-token": "forged", "x-api-key": "forged" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) });
    assert.equal((await rpc(safe.access_token)).status, 200);
    assert.equal(captured.at(-1).path, "/safe");
    assert.equal(captured.at(-1).headers["x-bliko-identity"], undefined);
    assert.equal(captured.at(-1).headers["x-meta-token"], undefined);
    assert.equal((await rpc(operator.access_token)).status, 200);
    assert.equal(captured.at(-1).path, "/operator");
    assert.notEqual(captured.at(-1).headers["x-bliko-identity"], "forged");
    const claim = JSON.parse(Buffer.from(captured.at(-1).headers["x-bliko-identity"].split(".")[0], "base64url"));
    assert.equal(claim.subject, "person");
    assert.equal(JSON.parse(readFileSync(aclPath)).grants[0].connectionId, claim.connectionId);
    const rotatedResponse = await post("/oauth/token", { grant_type: "refresh_token",
      client_id: client.client_id, refresh_token: operator.refresh_token });
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json();
    await rpc(rotated.access_token);
    assert.equal(captured.at(-1).path, "/operator");
    const replay = await post("/oauth/authorize", { response_type: "code", client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/callback", code_challenge: "test", password: code });
    assert.equal(replay.status, 401);
    const batch = await fetch(base + "/mcp", { method: "POST", headers: {
      authorization: "Bearer " + rotated.access_token, "content-type": "application/json" }, body: "[]" });
    assert.equal(batch.status, 400);
    await post("/oauth/revoke", { token: rotated.refresh_token });
    assert.equal((await rpc(rotated.access_token)).status, 401);
    assert.equal((await rpc(operator.access_token)).status, 401);
    assert.match(logs, /"profile":"operator"/);
    assert.ok(!logs.includes(operator.access_token));
    assert.ok(!logs.includes(code));
  } finally {
    child.kill();
    await once(child, "exit");
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
