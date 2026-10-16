import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function readAcl(path) {
  if (!path) return { enrollments: [], grants: [] };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value.enrollments) || !Array.isArray(value.grants)) throw new Error("Invalid operator ACL");
  return value;
}
export function enrollmentFor(password, path, clock = Date.now()) {
  const hash = createHash("sha256").update(password ?? "").digest("hex");
  return readAcl(path).enrollments.find(e => e.codeHash === hash && e.expiresAt > clock);
}
export function consumeEnrollment(path, enrollmentHash, subject, connectionId, clock = Date.now()) {
  const acl = readAcl(path);
  const index = acl.enrollments.findIndex(e => e.codeHash === enrollmentHash
    && e.subject === subject && e.expiresAt > clock);
  if (index < 0) return false;
  const enrollment = acl.enrollments[index];
  acl.enrollments.splice(index, 1);
  acl.grants = acl.grants.filter(g => g.subject !== subject);
  acl.grants.push({ subject, connectionId, expiresAt: clock + (enrollment.grantTtlMs ?? 30 * 86400000) });
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(acl), { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}
export function isOperator(access, path, clock = Date.now()) {
  if (!access.subject || !access.connectionId) return false;
  return readAcl(path).grants.some(g => g.subject === access.subject
    && g.connectionId === access.connectionId && g.expiresAt > clock);
}
export function signIdentity(access, body, secret, clock = Date.now()) {
  if (!secret || secret.length < 32) throw new Error("Operator assertion secret must contain at least 32 characters");
  const payload = Buffer.from(JSON.stringify({
    subject: access.subject, connectionId: access.connectionId,
    aud: "bliko-meta-ads-operator", exp: clock + 15000,
    nonce: randomBytes(24).toString("base64url"),
    digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  })).toString("base64url");
  return payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
}
