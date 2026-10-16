import { randomBytes } from "node:crypto";
import { enrollmentFor, consumeEnrollment, isOperator, signIdentity } from "./operator.mjs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";

import {
  authenticateClient,
  decryptStore,
  encryptStore,
  authorizationServerMetadata,
  authorizeRedirect,
  consumeCode,
  createStore,
  errorRedirect,
  hydrateStore,
  isCimdClientId,
  isTrustedRedirect,
  issueCode,
  issueTokens,
  parseBasicAuth,
  parseForm,
  parseIssuer,
  protectedResourceMetadata,
  readAccess,
  registerClient,
  resourceMatches,
  resourceUris,
  revokeToken,
  rotateRefresh,
  serializeStore,
  tokenResponse,
  verifyPkce,
  wwwAuthenticate,
  safeEqual,
} from "./oauth.mjs";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const issuer = parseIssuer(process.env.PUBLIC_URL ?? "http://127.0.0.1:8080");
const upstreamUrl = new URL(
  process.env.UPSTREAM_MCP_URL ?? "http://langfuse-web:3000/api/public/mcp",
);
const upstreamHost = process.env.UPSTREAM_HOST ?? "langfuse.bliko.ai";
const displayName = process.env.MCP_DISPLAY_NAME ?? "Langfuse MCP";
const upstreamAuthMode = process.env.UPSTREAM_AUTH_MODE ?? "basic";
const operatorAclPath = process.env.OPERATOR_ACL_PATH;
const operatorUrl = process.env.OPERATOR_MCP_URL ? new URL(process.env.OPERATOR_MCP_URL) : null;
const assertionSecret = process.env.OPERATOR_ASSERTION_SECRET;
const loginPassword = process.env.OAUTH_LOGIN_PASSWORD ?? "";
const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
const upstreamApiKey = process.env.UPSTREAM_MCP_API_KEY ?? "";
const dataDir = process.env.DATA_DIR ?? "/data";
const storeEncryptionSecret = process.env.OAUTH_STORE_ENCRYPTION_KEY ?? "";
const storePath = join(dataDir, "store.json");
const allowedResources = resourceUris(issuer);
const upstreamAuth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
const loginAttempts = new Map();
const loginWindowMs = Number.parseInt(process.env.OAUTH_LOGIN_WINDOW_MS ?? "900000", 10);
const loginMaxAttempts = Number.parseInt(process.env.OAUTH_LOGIN_MAX_ATTEMPTS ?? "5", 10);

if (!storeEncryptionSecret) throw new Error("OAUTH_STORE_ENCRYPTION_KEY is required");

if (!["basic", "api-key"].includes(upstreamAuthMode)) {
  throw new Error("UPSTREAM_AUTH_MODE must be basic or api-key");
}

mkdirSync(dataDir, { recursive: true });

const store = loadStore();

function loadStore() {
  try {
    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    const plain = persisted?.ciphertext ? decryptStore(persisted, storeEncryptionSecret) : persisted;
    return hydrateStore(plain);
  } catch (error) {
    if (error?.code === "ENOENT") return createStore();
    throw new Error(`Could not decrypt or load OAuth store: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function persistStore() {
  mkdirSync(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(encryptStore(serializeStore(store), storeEncryptionSecret)), { mode: 0o600 });
  renameSync(temporary, storePath);
}

function requestIp(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function loginRateState(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + loginWindowMs };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return current;
}

function logEvent(event) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, Accept, MCP-Session-Id, Last-Event-ID, mcp-protocol-version",
    "access-control-expose-headers": "MCP-Session-Id, WWW-Authenticate, mcp-protocol-version",
    ...extra,
  };
}

function sendJson(response, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...corsHeaders({
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    }),
  });
  response.end(body);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    ...corsHeaders({ "content-type": "text/html; charset=utf-8" }),
  });
  response.end(html);
}

function sendText(response, status, text, extra = {}) {
  response.writeHead(status, {
    ...corsHeaders({ "content-type": "text/plain; charset=utf-8", ...extra }),
  });
  response.end(text);
}

async function readBody(request, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestClientCredentials(request, form) {
  const basic = parseBasicAuth(request.headers.authorization ?? "");
  return {
    clientId: basic?.user || form.client_id || "",
    clientSecret: basic?.pass || form.client_secret || "",
  };
}

function loginPage({ error, values }) {
  const hidden = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "resource",
    "scope",
  ]
    .map((name) => {
      const value = values[name] ?? "";
      return `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
    })
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conectar ${escapeHtml(displayName)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
    main { max-width: 420px; margin: 12vh auto; padding: 24px; background: #1e293b; border-radius: 16px; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #94a3b8; line-height: 1.5; }
    label { display: block; margin: 16px 0 8px; font-size: 0.9rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #fff; }
    button { margin-top: 20px; width: 100%; padding: 12px; border: 0; border-radius: 10px; background: #38bdf8; color: #0f172a; font-weight: 700; cursor: pointer; }
    .error { color: #fda4af; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(displayName)}</h1>
    <p>Aprueba el acceso de ChatGPT (u otro cliente OAuth) a ${escapeHtml(displayName)}.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="password">Contraseña del puente o código personal</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Autorizar</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

async function resolveClient(clientId, redirectUri) {
  if (!clientId) return null;
  const existing = store.clients.get(clientId);
  if (existing) return existing;
  if (clientId !== "https://chatgpt.com/oauth/client.json") return null;

  try {
    const response = await fetch(clientId, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (response.ok) {
      const metadata = await response.json();
      return registerClient(store, {
        client_id: clientId,
        redirect_uris: metadata.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
        client_name: metadata.client_name,
        client_secret: null,
      });
    }
  } catch {
    // CIMD fetch is best-effort; ChatGPT redirects are still trusted below.
  }

  return registerClient(store, {
    client_id: clientId,
    redirect_uris: redirectUri ? [redirectUri] : [],
    token_endpoint_auth_method: "none",
    client_secret: null,
    client_name: "cimd-client",
  });
}

function provisionTrustedClient(clientId, redirectUri) {
  if (!clientId || isCimdClientId(clientId) || !redirectUri || !isTrustedRedirect(redirectUri)) return null;
  return registerClient(store, {
    client_id: clientId,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    client_name: isCimdClientId(clientId) ? "cimd-client" : "dynamic-client",
  });
}

function validateAuthorize(params) {
  if (params.response_type !== "code") return "unsupported_response_type";
  if (!params.client_id) return "invalid_request";
  if (!params.redirect_uri) return "invalid_request";
  if (!params.code_challenge) return "invalid_request";
  if ((params.code_challenge_method || "S256") !== "S256") return "invalid_request";
  if (params.resource && !resourceMatches(params.resource, allowedResources)) return "invalid_target";
  return null;
}

async function handleAuthorizeGet(url, response) {
  const params = Object.fromEntries(url.searchParams.entries());
  const error = validateAuthorize(params);
  if (error && params.redirect_uri && isTrustedRedirect(params.redirect_uri)) {
    return redirect(
      response,
      errorRedirect({
        redirectUri: params.redirect_uri,
        error,
        state: params.state,
        issuer,
      }),
    );
  }
  if (error) return sendText(response, 400, error);
  return sendHtml(response, 200, loginPage({ values: params }));
}

async function handleAuthorizePost(request, response) {
  const ip = requestIp(request);
  const rate = loginRateState(ip);
  if (rate.count >= loginMaxAttempts) {
    logEvent({ msg: "authorize", status: 429, reason: "rate_limited" });
    return sendText(response, 429, "too_many_attempts", { "retry-after": String(Math.ceil((rate.resetAt - Date.now()) / 1000)) });
  }
  const form = parseForm((await readBody(request)).toString("utf8"));
  const error = validateAuthorize(form);
  if (error) return sendText(response, 400, error);

  const client =
    (await resolveClient(form.client_id, form.redirect_uri)) ||
    provisionTrustedClient(form.client_id, form.redirect_uri);
  if (!client || !isTrustedRedirect(form.redirect_uri, client.redirect_uris)) {
    logEvent({
      msg: "authorize",
      status: 400,
      reason: "invalid_client",
      client_kind: isCimdClientId(form.client_id) ? "url" : "opaque",
      redirect_host: safeHost(form.redirect_uri),
    });
    return sendText(response, 400, "invalid_client");
  }
  persistStore();

  const enrollment = enrollmentFor(form.password, operatorAclPath);
  if (!enrollment && (!loginPassword || !safeEqual(form.password ?? "", loginPassword))) {
    rate.count += 1;
    logEvent({ msg: "authorize", status: 401, reason: "bad_password" });
    return sendHtml(
      response,
      401,
      loginPage({ error: "Contraseña incorrecta.", values: form }),
    );
  }
  loginAttempts.delete(ip);

  if (!client.redirect_uris.includes(form.redirect_uri)) {
    client.redirect_uris.push(form.redirect_uri);
    persistStore();
  }

  const code = issueCode(store, {
    subject: enrollment?.subject,
    connectionId: enrollment ? randomBytes(24).toString("base64url") : undefined,
    enrollmentHash: enrollment?.codeHash,
    clientId: client.client_id,
    redirectUri: form.redirect_uri,
    codeChallenge: form.code_challenge,
    codeChallengeMethod: form.code_challenge_method || "S256",
    resource: form.resource || `${issuer}/mcp`,
    scope: "mcp",
  });

  logEvent({
    msg: "authorize",
    status: 303,
    client: client.client_name || "unknown",
    redirect_host: safeHost(form.redirect_uri),
  });
  return redirect(
    response,
    authorizeRedirect({
      redirectUri: form.redirect_uri,
      code,
      state: form.state,
      issuer,
    }),
  );
}

async function handleRegister(request, response) {
  const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
  // Dynamic registration cannot overwrite an existing client or choose credentials.
  const client = registerClient(store, {
    redirect_uris: body.redirect_uris, client_name: body.client_name,
    token_endpoint_auth_method: body.token_endpoint_auth_method,
  });
  persistStore();
  logEvent({
    msg: "register",
    status: 201,
    auth: client.token_endpoint_auth_method,
    redirect_count: client.redirect_uris.length,
  });
  sendJson(response, 201, {
    ...client,
    client_id_issued_at: client.created_at,
    redirect_uris: client.redirect_uris,
  });
}

async function handleToken(request, response) {
  const form = parseForm((await readBody(request)).toString("utf8"));
  const { clientId, clientSecret } = requestClientCredentials(request, form);
  const client = authenticateClient(store, { clientId, clientSecret });
  if (!client) {
    logEvent({ msg: "token", status: 401, reason: "invalid_client", grant: form.grant_type });
    return sendJson(response, 401, { error: "invalid_client" });
  }

  if (form.grant_type === "authorization_code") {
    const record = consumeCode(store, form.code);
    if (!record) {
      logEvent({ msg: "token", status: 400, reason: "code_missing" });
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    if (record.clientId !== clientId) {
      logEvent({ msg: "token", status: 400, reason: "client_mismatch" });
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    if (record.redirectUri !== form.redirect_uri) {
      logEvent({ msg: "token", status: 400, reason: "redirect_mismatch" });
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    if (!verifyPkce(form.code_verifier, record.codeChallenge, record.codeChallengeMethod)) {
      logEvent({ msg: "token", status: 400, reason: "pkce" });
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    if (record.enrollmentHash && !consumeEnrollment(operatorAclPath, record.enrollmentHash,
      record.subject, record.connectionId)) {
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    const tokens = issueTokens(store, {
      subject: record.subject,
      connectionId: record.connectionId,
      clientId: record.clientId,
      resource: record.resource,
      scope: record.scope,
    });
    persistStore();
    logEvent({ msg: "token", status: 200, grant: "authorization_code" });
    return sendJson(response, 200, tokenResponse(tokens));
  }

  if (form.grant_type === "refresh_token") {
    if (!resourceMatches(form.resource, allowedResources)) return sendJson(response, 400, { error: "invalid_target" });
    const tokens = rotateRefresh(store, form.refresh_token, clientId, form.resource);
    if (!tokens) {
      logEvent({ msg: "token", status: 400, reason: "refresh" });
      return sendJson(response, 400, { error: "invalid_grant" });
    }
    persistStore();
    logEvent({ msg: "token", status: 200, grant: "refresh_token" });
    return sendJson(response, 200, tokenResponse(tokens));
  }

  logEvent({ msg: "token", status: 400, reason: "unsupported_grant", grant: form.grant_type });
  return sendJson(response, 400, { error: "unsupported_grant_type" });
}

async function handleRevoke(request, response) {
  const form = parseForm((await readBody(request)).toString("utf8"));
  revokeToken(store, form.token);
  persistStore();
  sendJson(response, 200, {});
}

function bearerToken(request) {
  const header = String(request.headers.authorization ?? "").trim();
  const match = header.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function unauthorized(response) {
  sendJson(
    response,
    401,
    { error: "invalid_token", error_description: "Missing or invalid access token" },
    { "www-authenticate": wwwAuthenticate(issuer) },
  );
}

function hopByHop() {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "authorization",
  ]);
}

async function proxyMcp(request, response) {
  const token = bearerToken(request);
  const access = readAccess(store, token);
  if (!access) {
    const scheme = String(request.headers.authorization ?? "").split(/\s+/)[0] || "none";
    logEvent({
      msg: "mcp",
      status: 401,
      method: request.method,
      auth_scheme: scheme,
      has_bearer: Boolean(token),
    });
    return unauthorized(response);
  }
  if (
    (upstreamAuthMode === "basic" && (!publicKey || !secretKey)) ||
    (upstreamAuthMode === "api-key" && !upstreamApiKey)
  ) {
    return sendJson(response, 503, { error: "upstream_not_configured" });
  }

  const method = request.method ?? "POST";
  const requestBody = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const operator = isOperator(access, operatorAclPath);
  const targetUrl = operator && operatorUrl ? operatorUrl : upstreamUrl;
  let rpcBody;
  let rpcMethod;
  let toolName;
  let referencedIds = {};
  if (requestBody?.length) {
    try {
      const rpc = JSON.parse(requestBody.toString("utf8"));
      rpcBody = rpc;
      rpcMethod = rpc.method;
      toolName = rpc.method === "tools/call" ? rpc.params?.name : undefined;
      const args = rpc.params?.arguments;
      if (args && typeof args === "object") {
        referencedIds = Object.fromEntries(Object.entries(args).filter(([key, value]) =>
          (key === "plan_id" || key === "bundle_id" || key === "upload_id" || key === "idempotency_key" || key.endsWith("_id"))
          && typeof value === "string" && value.length < 220,
        ));
      }
    } catch {
      // Non-JSON MCP requests remain valid and are proxied without tool metadata.
    }
  }
  if (Array.isArray(rpcBody)) return sendJson(response, 400, { error: "batch_not_supported" });
  const skip = hopByHop();
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || skip.has(name) || name === "x-api-key" || name === "x-meta-token" || name.startsWith("x-bliko-")) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (operator && operatorUrl && method === "POST") {
    headers["x-bliko-identity"] = signIdentity(access, rpcBody, assertionSecret);
  }
  headers.host = upstreamHost;
  if (upstreamAuthMode === "basic") headers.authorization = `Basic ${upstreamAuth}`;
  if (upstreamAuthMode === "api-key") headers["x-api-key"] = upstreamApiKey;
  if (upstreamAuthMode === "api-key") headers["x-forwarded-proto"] = "https";
  headers.accept = request.headers.accept || "application/json, text/event-stream";

  const transport = targetUrl.protocol === "https:" ? https : http;
  const proxyReq = transport.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method,
    headers,
  });

  const closeUpstream = () => {
    proxyReq.destroy();
  };
  response.on("close", () => {
    if (!response.writableFinished) closeUpstream();
  });

  return new Promise((resolve, reject) => {
    proxyReq.on("response", (proxyRes) => {
      logEvent({
        msg: "mcp",
        status: proxyRes.statusCode,
        method,
        upstream: proxyRes.statusCode,
        client_id: access.clientId,
        subject: access.subject,
        connection_id: access.connectionId,
        profile: operator ? "operator" : "safe",
        rpc_method: rpcMethod,
        tool: toolName,
        ids: referencedIds,
      });
      const outHeaders = corsHeaders();
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (!value || skip.has(name)) continue;
        outHeaders[name] = value;
      }
      if (response.writableEnded || response.destroyed) {
        proxyRes.resume();
        resolve();
        return;
      }
      response.writeHead(proxyRes.statusCode ?? 502, outHeaders);
      proxyRes.on("end", resolve);
      proxyRes.on("error", (error) => {
        if (request.destroyed || response.destroyed) {
          logEvent({ msg: "mcp", event: "client_closed", method });
          resolve();
          return;
        }
        reject(error);
      });
      proxyRes.pipe(response);
    });

    proxyReq.on("error", (error) => {
      if (request.destroyed || response.destroyed || error.code === "ECONNRESET") {
        logEvent({ msg: "mcp", event: "client_closed", method });
        resolve();
        return;
      }
      reject(error);
    });

    if (method === "GET" || method === "HEAD") {
      proxyReq.end();
      return;
    }
    proxyReq.setHeader("content-length", String(requestBody?.length ?? 0));
    proxyReq.end(requestBody);
  });
}

function redirect(response, location, status = 303) {
  response.writeHead(status, corsHeaders({ location }));
  response.end();
}

function isWellKnown(pathname, name) {
  return pathname === `/.well-known/${name}` || pathname.startsWith(`/.well-known/${name}/`);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/oauth/health")
    ) {
      return sendJson(response, 200, { status: "ok" });
    }

    if (request.method === "GET" && isWellKnown(url.pathname, "oauth-protected-resource")) {
      return sendJson(response, 200, protectedResourceMetadata(issuer, displayName));
    }

    if (
      request.method === "GET" &&
      (isWellKnown(url.pathname, "oauth-authorization-server") ||
        isWellKnown(url.pathname, "openid-configuration"))
    ) {
      return sendJson(response, 200, authorizationServerMetadata(issuer));
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/oauth/authorize" || url.pathname === "/authorize")
    ) {
      return handleAuthorizeGet(url, response);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/oauth/authorize" || url.pathname === "/authorize")
    ) {
      return handleAuthorizePost(request, response);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/oauth/register" || url.pathname === "/register")
    ) {
      return handleRegister(request, response);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/oauth/token" || url.pathname === "/token")
    ) {
      return handleToken(request, response);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/oauth/revoke" || url.pathname === "/revoke")
    ) {
      return handleRevoke(request, response);
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/" || url.pathname === "/") {
      return proxyMcp(request, response);
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    logEvent({
      msg: "request_failed",
      path: url.pathname,
      method: request.method,
      error: error instanceof Error ? error.message : "unknown",
    });
    if (!response.headersSent) sendJson(response, 500, { error: "server_error" });
    else response.end();
  }
});

process.on("unhandledRejection", (error) => {
  if (error && typeof error === "object" && error.code === "ERR_STREAM_PREMATURE_CLOSE") {
    logEvent({ msg: "stream_closed" });
    return;
  }
  logEvent({
    msg: "unhandled_rejection",
    error: error instanceof Error ? error.message : "unknown",
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${displayName} OAuth bridge listening on ${port}`);
});
