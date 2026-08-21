import { randomHex } from "./ids";

const MAX_HTML_BYTES = 16 * 1024 * 1024;

export class UploadValidationError extends Error {
  constructor(readonly code: "INVALID_EXTENSION" | "EMPTY_FILE" | "FILE_TOO_LARGE" | "INVALID_HTML") {
    super(code);
  }
}

export interface ValidatedHtml {
  bytes: ArrayBuffer;
  originalFilename: string;
  extension: ".html" | ".htm";
  fileSize: number;
  sha256: string;
}

const hexDigest = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function validateHtml(file: File): Promise<ValidatedHtml> {
  const lowerName = file.name.toLowerCase();
  const extension = lowerName.endsWith(".html") ? ".html" : lowerName.endsWith(".htm") ? ".htm" : null;
  if (!extension) throw new UploadValidationError("INVALID_EXTENSION");
  if (file.size === 0) throw new UploadValidationError("EMPTY_FILE");
  if (file.size > MAX_HTML_BYTES) throw new UploadValidationError("FILE_TOO_LARGE");

  const bytes = await file.arrayBuffer();
  const sample = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 4096))).toLowerCase();
  if (!sample.includes("<html") && !sample.includes("<!doctype html")) {
    throw new UploadValidationError("INVALID_HTML");
  }
  const sha256 = hexDigest(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes, originalFilename: file.name, extension, fileSize: file.size, sha256 };
}

export async function putVersionObject(
  bucket: R2Bucket,
  projectId: string,
  versionId: string,
  html: ValidatedHtml
): Promise<{ objectKey: string; sha256: string; fileSize: number }> {
  const objectKey = `projects/${projectId}/versions/${versionId}/${randomHex(16)}${html.extension}`;
  await bucket.put(objectKey, html.bytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { originalFilename: html.originalFilename, sha256: html.sha256 }
  });
  return { objectKey, sha256: html.sha256, fileSize: html.fileSize };
}

export async function copyVersionObject(bucket: R2Bucket, sourceKey: string, targetKey: string): Promise<void> {
  const source = await bucket.get(sourceKey);
  if (!source) throw new Error("SOURCE_OBJECT_NOT_FOUND");
  await bucket.put(targetKey, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata
  });
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length > 0) await bucket.delete(keys);
}
