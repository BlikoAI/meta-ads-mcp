import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface OperatorIdentity { subject: string; connectionId: string }
export const operatorContext = new AsyncLocalStorage<OperatorIdentity>();
const seen = new Map<string, number>();

export function operatorGrantAllowed(identity: OperatorIdentity, path = process.env.OPERATOR_ACL_PATH): boolean {
  if (!path) return false;
  try {
    const acl = JSON.parse(readFileSync(path, "utf8")) as {
      grants?: Array<OperatorIdentity & { expiresAt: number }>;
    };
    return acl.grants?.some(g => g.subject === identity.subject
      && g.connectionId === identity.connectionId && g.expiresAt > Date.now()) === true;
  } catch { return false; }
}

export function verifyOperatorIdentity(
  header: string | undefined, body: unknown,
  secret = process.env.OPERATOR_ASSERTION_SECRET, clock = Date.now(),
): OperatorIdentity | undefined {
  if (!header || !secret || secret.length < 32 || header.length > 4096) return;
  const parts = header.split(".");
  if (parts.length !== 2) return;
  const [payload, signature] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      subject: string; connectionId: string; aud: string; exp: number; nonce: string; digest: string;
    };
    if (claim.aud !== "bliko-meta-ads-operator" || !Number.isSafeInteger(claim.exp)
      || claim.exp <= clock || claim.exp > clock + 30000
      || typeof claim.subject !== "string" || typeof claim.connectionId !== "string"
      || typeof claim.nonce !== "string" || claim.nonce.length < 20
      || claim.digest !== createHash("sha256").update(JSON.stringify(body)).digest("hex")) return;
    for (const [key, expiry] of seen) if (expiry <= clock) seen.delete(key);
    if (seen.has(claim.nonce) || seen.size >= 10000) return;
    if (!operatorGrantAllowed(claim)) return;
    seen.set(claim.nonce, claim.exp);
    return { subject: claim.subject, connectionId: claim.connectionId };
  } catch { return; }
}
