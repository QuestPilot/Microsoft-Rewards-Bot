import crypto from "crypto";

/**
 * Normalize text for stable error ID generation.
 * Removes timestamps, hex addresses, file paths, and line numbers
 * so that structurally identical errors produce the same ID.
 */
export function normalizeForId(text: string): string {
  if (!text) return "";

  let t = String(text);
  // Remove ISO timestamps
  t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "");
  // Remove hex addresses / pointers
  t = t.replace(/0x[0-9a-fA-F]+/g, "");
  // Replace absolute paths with placeholder
  t = t.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:]*)/g, "[PATH]");
  // Remove line/column numbers in stack traces (file:line:col)
  t = t.replace(/:\d+(?::\d+)?/g, "");
  // Collapse whitespace
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Compute a stable 12-character error ID from an error payload.
 * Uses SHA-256 hash of normalized error text, stack trace, and context.
 */
export function computeErrorId(payload: {
  error?: string;
  stack?: string;
  context?: Record<string, unknown>;
  additionalContext?: Record<string, unknown>;
}): string {
  const parts: string[] = [];
  parts.push(normalizeForId(payload.error || ""));
  if (payload.stack) parts.push(normalizeForId(payload.stack));

  const ctx = payload.context || {};
  const ctxKeys = Object.keys(ctx)
    .filter((k) => k !== "timestamp")
    .sort();
  for (const k of ctxKeys) parts.push(`${k}=${String(ctx[k])}`);

  const add = payload.additionalContext || {};
  const addKeys = Object.keys(add).sort();
  for (const k of addKeys) parts.push(`${k}=${String(add[k])}`);

  const canonical = parts.join("|");
  return crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
}
