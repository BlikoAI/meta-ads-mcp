import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_TTL_SEC = 8 * 60 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
export const CODE_TTL_MS = 10 * 60 * 1000;

const CHATGPT_REDIRECT_HOSTS = new Set([
  "chatgpt.com",
  "www.chatgpt.com",
  "chat.openai.com",
  "platform.openai.com",
]);

export function stripSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

export function parseIssuer(publicUrl) {
  return stripSlash(publicUrl);
}

export function resourceUris(issuer) {
  const base = parseIssuer(issuer);
  return [`${base}/mcp`, base];
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function encryptionKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error("OAuth store encryption secret must contain at least 32 characters");
  return createHash("sha256").update(String(secret)).digest();
}

export function encryptStore(data, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptStore(envelope, secret) {
  if (envelope?.version !== 1 || envelope?.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted OAuth store format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

export function verifyPkce(verifier, challenge, method = "S256") {
  if (!verifier || !challenge) return false;
  if (method !== "S256") return false;
  return safeEqual(sha256Base64Url(verifier), challenge);
}

export function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLoopbackRedirect(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export function isChatgptRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && CHATGPT_REDIRECT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isTrustedRedirect(value, registered = []) {
  if (registered.includes(value)) return true;
  return isChatgptRedirect(value) || isLoopbackRedirect(value);
}

export function isCimdClientId(clientId) {
  return isHttpsUrl(clientId);
}

export function authorizationServerMetadata(issuer) {
  const base = parseIssuer(issuer);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    scopes_supported: ["mcp"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(issuer, resourceName = "Langfuse MCP") {
  const base = parseIssuer(issuer);
  const resource = `${base}/mcp`;
  return {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: resourceName,
  };
}

export function wwwAuthenticate(issuer) {
  const metadata = `${parseIssuer(issuer)}/.well-known/oauth-protected-resource`;
  return `Bearer realm="mcp", resource_metadata="${metadata}"`;
}

export function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return {
      user: decoded.slice(0, index),
      pass: decoded.slice(index + 1),
    };
  } catch {
    return null;
  }
}

export function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

export function authorizeRedirect({ redirectUri, code, state, issuer }) {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", parseIssuer(issuer));
  return url.toString();
}

export function errorRedirect({ redirectUri, error, description, state, issuer }) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", parseIssuer(issuer));
  return url.toString();
}

export function tokenResponse({ accessToken, refreshToken, resource, scope = "mcp" }) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope,
    resource,
  };
}

export function now() {
  return Date.now();
}

export function expired(expiresAt, clock = now) {
  return clock() >= expiresAt;
}

export function createStore() {
  return {
    clients: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
  };
}

export function registerClient(store, input = {}) {
  const clientId = input.client_id || `mcp-${randomToken(16)}`;
  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter(Boolean)
    : [];
  const authMethod = input.token_endpoint_auth_method || "none";
  const clientSecret = authMethod === "none" ? null : input.client_secret || randomToken(24);
  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    client_name: input.client_name || "mcp-client",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    created_at: Math.floor(now() / 1000),
  };
  store.clients.set(clientId, client);
  return client;
}

export function serializeStore(store) {
  return {
    clients: [...store.clients.entries()],
    access: [...store.access.entries()],
    refresh: [...store.refresh.entries()],
  };
}

export function hydrateStore(data) {
  const store = createStore();
  for (const [id, client] of data.clients ?? []) store.clients.set(id, client);
  for (const [token, record] of data.access ?? []) store.access.set(token, record);
  for (const [token, record] of data.refresh ?? []) store.refresh.set(token, record);
  return store;
}

export function authenticateClient(store, { clientId, clientSecret }) {
  const client = store.clients.get(clientId);
  if (!client) {
    if (isCimdClientId(clientId) && !clientSecret) {
      return { client_id: clientId, client_secret: null, redirect_uris: [] };
    }
    return null;
  }
  if (client.client_secret && !safeEqual(client.client_secret, clientSecret ?? "")) return null;
  return client;
}

export function issueCode(store, payload) {
  const code = randomToken(24);
  store.codes.set(code, {
    ...payload,
    expiresAt: now() + CODE_TTL_MS,
  });
  return code;
}

export function consumeCode(store, code) {
  const record = store.codes.get(code);
  store.codes.delete(code);
  if (!record || expired(record.expiresAt)) return null;
  return record;
}

export function issueTokens(store, { clientId, resource, scope = "mcp", subject, connectionId }) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  store.access.set(accessToken, {
    clientId,
    resource,
    scope,
    subject,
    connectionId,
    expiresAt: now() + ACCESS_TTL_SEC * 1000,
  });
  store.refresh.set(refreshToken, {
    clientId,
    resource,
    scope,
    subject,
    connectionId,
    expiresAt: now() + REFRESH_TTL_SEC * 1000,
  });
  return { accessToken, refreshToken, resource, scope };
}

export function readAccess(store, token) {
  const record = store.access.get(token);
  if (!record || expired(record.expiresAt)) {
    if (record) store.access.delete(token);
    return null;
  }
  return record;
}

export function rotateRefresh(store, refreshToken, clientId, resource) {
  const record = store.refresh.get(refreshToken);
  if (!record || expired(record.expiresAt) || record.clientId !== clientId
    || (resource && record.resource !== resource)) return null;
  store.refresh.delete(refreshToken);
  return issueTokens(store, record);
}

export function revokeToken(store, token) {
  const record = store.access.get(token) ?? store.refresh.get(token);
  for (const collection of [store.access, store.refresh]) {
    for (const [key, value] of collection) {
      if (key === token || (record?.connectionId && value.connectionId === record.connectionId)) collection.delete(key);
    }
  }
}

export function resourceMatches(requested, allowed) {
  if (!requested) return true;
  const normalized = stripSlash(requested);
  return allowed.some((item) => stripSlash(item) === normalized);
}
