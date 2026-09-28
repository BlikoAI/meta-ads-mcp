import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env["BLIKO_E2E_DATA_DIR"] ?? "/data/bliko-e2e";

export async function ensureDataDirectories(): Promise<void> {
  await Promise.all(["uploads", "assets", "plans", "bundles", "activation-plans", "audit", "dedupe"]
    .map((entry) => mkdir(join(DATA_DIR, entry), { recursive: true })));
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function recordPath(kind: "plans" | "bundles" | "activation-plans" | "dedupe", id: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`Invalid ${kind} record id.`);
  return join(DATA_DIR, kind, `${id}.json`);
}

export async function appendAudit(event: Record<string, unknown>): Promise<void> {
  await ensureDataDirectories();
  const timestamp = new Date().toISOString();
  const id = `${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}`;
  await atomicWriteJson(join(DATA_DIR, "audit", `${id}.json`), { timestamp, ...event });
}

export async function cleanupExpiredJson(directory: string, expiresField = "expires_at"): Promise<number> {
  await ensureDataDirectories();
  let deleted = 0;
  for (const name of await readdir(join(DATA_DIR, directory)).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const path = join(DATA_DIR, directory, name);
    const value = await readJson<Record<string, unknown>>(path);
    const expiresAt = typeof value?.[expiresField] === "string" ? Date.parse(value[expiresField] as string) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      await rm(path, { force: true });
      deleted += 1;
    }
  }
  return deleted;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
