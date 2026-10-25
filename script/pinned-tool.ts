// A pinned release binary: downloaded on first use, verified by SHA-256, and
// cached in the ignored .tools/ directory. Used by the secret check (Gitleaks)
// and the lint (ShellCheck). Nothing is uploaded anywhere.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export interface PinnedTool {
  name: string;
  version: string;
  /** The executable's path inside the .tar.gz. */
  member: string;
  /** Keyed by `${process.platform}-${process.arch}`. */
  archives: Record<string, { url: string; sha256: string }>;
}

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** One regular file from an uncompressed tar, by its path inside the archive. */
export function tarMember(tar: Buffer, wanted: string): Buffer {
  const field = (h: Buffer, start: number, end: number): string =>
    h.subarray(start, end).toString("utf8").replace(/\0[\s\S]*$/, "");
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    // POSIX ustar keeps a path prefix at 345; old GNU tar uses those bytes for times.
    const prefix = header.subarray(257, 263).toString("latin1") === "ustar\0" ? field(header, 345, 500) : "";
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const size = parseInt(field(header, 124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    const start = off + 512;
    if (full === wanted) {
      if (type !== "0" && type !== "\0") throw new Error(`${wanted} in the archive is not a regular file`);
      return Buffer.from(tar.subarray(start, start + size));
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is missing from the archive`);
}

/**
 * The path of a freshly extracted, verified executable. The caller removes it
 * when done; the verified archive stays cached.
 */
export async function pinnedExecutable(root: string, tool: PinnedTool): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const target = tool.archives[platform];
  if (!target) throw new Error(`${tool.name} is pinned for macOS and Linux on arm64 and x64 only`);
  const cache = path.join(root, ".tools", tool.name, tool.version, platform);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const archive = path.join(cache, `${tool.name}.tar.gz`);
  if (!existsSync(archive)) {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${tool.name} download failed (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_ARCHIVE_BYTES || sha256(data) !== target.sha256) {
      throw new Error(`${tool.name} download failed checksum or size validation`);
    }
    const partial = `${archive}.${process.pid}.partial`;
    writeFileSync(partial, data);
    renameSync(partial, archive);
  }
  const verified = readFileSync(archive);
  if (sha256(verified) !== target.sha256) throw new Error(`cached ${tool.name} archive failed checksum validation`);
  // Re-extract the verified member every run; never trust a cached binary.
  const executable = path.join(cache, `${tool.name}.${process.pid}`);
  writeFileSync(executable, tarMember(gunzipSync(verified), tool.member));
  chmodSync(executable, 0o700);
  return executable;
}
