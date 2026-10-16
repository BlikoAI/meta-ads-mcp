import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeRedirect,
  createStore,
  isChatgptRedirect,
  issueCode,
  consumeCode,
  issueTokens,
  readAccess,
  registerClient,
  sha256Base64Url,
  verifyPkce,
  wwwAuthenticate,
} from "./oauth.mjs";

describe("pkce", () => {
  it("accepts S256 verifier", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = sha256Base64Url(verifier);
    assert.equal(verifyPkce(verifier, challenge, "S256"), true);
  });

  it("rejects a bad verifier", () => {
    assert.equal(verifyPkce("nope", sha256Base64Url("other"), "S256"), false);
  });
});

describe("tokens", () => {
  it("issues and reads an access token", () => {
    const store = createStore();
    const { accessToken } = issueTokens(store, {
      clientId: "chatgpt",
      resource: "https://langfuse.bliko.ai/mcp",
    });
    assert.ok(readAccess(store, accessToken));
    assert.equal(readAccess(store, "missing"), null);
  });

  it("consumes authorization codes once", () => {
    const store = createStore();
    const code = issueCode(store, { clientId: "c" });
    assert.ok(consumeCode(store, code));
    assert.equal(consumeCode(store, code), null);
  });
});

describe("oauth extras", () => {
  it("adds RFC 9207 iss to the authorize redirect", () => {
    const url = authorizeRedirect({
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code: "abc",
      state: "s1",
      issuer: "https://langfuse.bliko.ai/",
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("iss"), "https://langfuse.bliko.ai");
    assert.equal(parsed.searchParams.get("code"), "abc");
  });

  it("advertises resource metadata on 401", () => {
    assert.match(
      wwwAuthenticate("https://langfuse.bliko.ai"),
      /oauth-protected-resource/,
    );
  });

  it("trusts ChatGPT callback hosts", () => {
    assert.equal(
      isChatgptRedirect("https://chatgpt.com/connector/oauth/abc"),
      true,
    );
    assert.equal(isChatgptRedirect("https://evil.example/oauth"), false);
  });

  it("registers a public DCR client", () => {
    const store = createStore();
    const client = registerClient(store, {
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(client.client_secret, null);
    assert.ok(store.clients.has(client.client_id));
  });
});
