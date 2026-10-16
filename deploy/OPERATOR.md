# Connection-scoped operator profile

The public OAuth bridge uses a shared password for legacy access. Its CIMD client
identifier identifies ChatGPT software, not a person. Never allowlist that client
identifier as an operator identity, or migrate all its existing grants.

The operator enrollment code is a high-entropy, one-use credential delivered
privately to one user. It identifies a new local principal; it does not claim to
verify a Meta or ChatGPT account identity. The resulting grant is bound to both
that principal and one randomly generated connection ID. No existing token is
promoted. Enrollment expires after seven days; the connection grant expires after
30 days and survives refresh until then. Re-enrollment replaces the principal's
previous grant. The user must reconnect ChatGPT and enter the enrollment code
instead of the shared bridge password. A normal password login remains safe.

## Services and trust boundary

- Public bridge: OAuth access-token validation, per-connection routing, audit
  metadata. No public administrative upstream. Incoming identity, Meta-token and
  API-key headers are removed. The bridge alone signs request assertions.
- Safe MCP: Meta reads only, including plan preparation in local storage. All
  previously guarded Meta writes now require the personal operator grant.
- Private operator MCP: existing service API-key authentication plus a separate
  HMAC assertion with subject, connection, body digest, audience, random nonce and
  15-second expiry. A fresh ACL check occurs for each request and before writes.
  The nonce is consumed to prevent replay; each request has a fresh server.
- Private admin MCP: preserved, with its existing credentials and tools, without
  public routing. The new operator secret is not shared with admin.

Only explicit create/update campaign, ad-set and ad tools, creative/media
uploads, resumable upload completion, guarded publishing/activation and test-lead
creation are allowed. Deletion, archiving, credential and token management,
generic entity updates, WhatsApp writes, clone macros and unknown future writes
are unavailable. Status updates accept only ACTIVE or PAUSED. Internal rollback
inside guarded publishing can remove resources created by that failed operation;
there is no operator-facing delete operation.

ACL JSON has `enrollments` and `grants` arrays. Enrollment entries contain
`subject`, `codeHash` (SHA-256 of a random 32-byte code), `expiresAt`, and
optionally `grantTtlMs`. Grant entries contain `subject`, `connectionId`,
`expiresAt`. The ACL is written atomically by the single bridge process, mounted
read-only into the operator. Removing a grant immediately removes write access.
Do not scale the bridge without moving state and enrollment consumption into a
transactional shared store. Operator replay protection assumes one operator
replica; a shared nonce store is required before scaling.

Runtime variables: bridge OPERATOR_ACL_PATH, OPERATOR_ASSERTION_SECRET,
OPERATOR_MCP_URL; operator OPERATOR_ACL_PATH, OPERATOR_ASSERTION_SECRET,
MCP_TOOL_PROFILE=operator. Missing or invalid credentials/ACL fail closed.
Keep all runtime values and enrollment codes outside this public repository.

## Audit and OAuth hardening

MCP logs contain subject, connection, tool, profile, allow/deny and success/error.
The bridge records HTTP routing outcomes. Hidden direct calls are denied before
execution; handlers recheck revoked grants and status restrictions. Logs omit
tokens, passwords, enrollment codes and tool arguments. Retain Docker JSON logs
with rotation and access controls; ship them to durable storage if required.

Dynamic client registration generates credentials server-side and cannot
overwrite chosen IDs. CIMD fetching is limited to the exact ChatGPT metadata URL
and rejects redirects. Refresh checks the original client/resource before
consuming its token and preserves subject/connection. Revocation invalidates
both refresh and access tokens in that connection. Login rate limiting uses the
socket peer rather than trusting caller-supplied forwarding headers; behind a
proxy it is shared by clients using that peer.

## Validation and reversible rollout

Run the full repository pre-deploy guard (lint, typecheck, vitest, node bridge
integration tests, build, staged/outgoing secret scans with pinned gitleaks).
Tests use fake upstreams and mocked Meta writes. Production checks must use only
tools/list, read tools and requests rejected before any Meta mutation.

Build immutable images from the reviewed commit using Dockerfile.contabo.
Back up the compose file, preserve previous image IDs, record release commit,
and back up the encrypted OAuth volume before replacing only safe/bridge and
adding the operator service. Do not rebuild or expose admin. Health-check all
three paths and verify direct unsigned operator requests are forbidden.
Rollback restores previous compose/images and recreates only the old safe/bridge
services, stopping operator. Normal rollback keeps the OAuth store (new identity
fields are backwards compatible); restoring the older volume backup is a
separate, deliberate recovery action because it would invalidate newer tokens.

ChatGPT needs to reconnect to claim the personal enrollment and refresh its tool
catalog. Safe and operator connections must have different tools/list results.
