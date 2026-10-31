import AdmZip from "adm-zip";
import { normalizePath, getMimeType, isTextMime } from "./utils";

export const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB input
export const MAX_EXTRACTED_SIZE = 150 * 1024 * 1024; // 150MB extracted
export const MAX_FILE_COUNT = 5000;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // single file max

export type ExtractedFile = {
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  mimeType: string;
  isBinary: boolean;
  content?: string; // utf8 text
  binaryContent?: string; // base64
};

export function extractZip(buffer: Buffer): ExtractedFile[] {
  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(
      `ZIP file too large (${buffer.length} bytes, max ${MAX_ZIP_SIZE})`
    );
  }
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_FILE_COUNT) {
    throw new Error(
      `Too many entries in archive (${entries.length}, max ${MAX_FILE_COUNT})`
    );
  }

  // Determine common root to strip (if archive is wrapped in single folder)
  const topLevel = new Set<string>();
  for (const e of entries) {
    const parts = e.entryName.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length > 0) topLevel.add(parts[0]);
  }
  let stripPrefix = "";
  if (topLevel.size === 1) {
    const only = [...topLevel][0];
    // Check if all paths start with it
    const allIn = entries.every((e) => {
      const n = e.entryName.replace(/\\/g, "/");
      return n === only || n.startsWith(only + "/");
    });
    if (allIn) stripPrefix = only + "/";
  }

  let totalSize = 0;
  const out: ExtractedFile[] = [];
  for (const entry of entries) {
    let name = entry.entryName.replace(/\\/g, "/");
    if (stripPrefix && (name === stripPrefix.slice(0, -1) || name.startsWith(stripPrefix))) {
      name = name.slice(stripPrefix.length);
    }
    if (!name) continue;
    // Reject absolute paths & traversal
    if (name.startsWith("/") || name.startsWith("\\")) {
      throw new Error(`Invalid absolute path in archive: ${entry.entryName}`);
    }
    let safePath: string;
    try {
      safePath = normalizePath(name.replace(/\/+$/, ""));
    } catch {
      throw new Error(`Invalid path in archive: ${entry.entryName}`);
    }
    if (!safePath) continue;

    if (entry.isDirectory) {
      out.push({
        path: safePath,
        isDirectory: true,
        sizeBytes: 0,
        mimeType: "inode/directory",
        isBinary: false,
      });
      continue;
    }

    const declaredSize = entry.header.size;
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_FILE_SIZE) {
      throw new Error(`File too large in archive: ${safePath}`);
    }
    totalSize += declaredSize;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw new Error(
        `Extracted size exceeds limit (${MAX_EXTRACTED_SIZE} bytes)`
      );
    }
    const data = entry.getData();
    if (data.length !== declaredSize) {
      throw new Error(`Invalid uncompressed size in archive: ${safePath}`);
    }

    const mimeType = getMimeType(safePath);
    const isBin = !isTextMime(mimeType) || isLikelyBinary(data);
    out.push({
      path: safePath,
      isDirectory: false,
      sizeBytes: data.length,
      mimeType,
      isBinary: isBin,
      content: isBin ? undefined : data.toString("utf8"),
      binaryContent: isBin ? data.toString("base64") : undefined,
    });
  }

  return out;
}

function isLikelyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(1024, buf.length));
  let nonText = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) nonText++;
  }
  return nonText / sample.length > 0.3;
}
