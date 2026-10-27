// Content-addressed local file storage for the demo. Production swaps this for object storage with per-tenant keys.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "@fe/core";

const ROOT = process.env.FE_UPLOADS ?? path.resolve(process.cwd(), "../../.uploads");

export async function putFile(buf: Buffer): Promise<{ key: string; sha256: string }> {
  const hash = sha256(buf);
  const key = `${hash.slice(0, 2)}/${hash}`;
  const full = path.join(ROOT, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  return { key, sha256: hash };
}

export async function getFile(key: string): Promise<Buffer> {
  if (key.includes("..")) throw new Error("Invalid storage key");
  return readFile(path.join(ROOT, key));
}
