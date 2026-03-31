/**
 * Centralized JSONC (JSON with Comments) Parser
 *
 * Provides a single implementation of comment stripping and trailing comma removal
 * for parsing .jsonc files. Previously duplicated across ConfigMerger, Load, and AccountDisabler.
 *
 * Supports:
 * - Single-line comments (//)
 * - Block comments
 * - Trailing commas before } or ]
 * - Preserves strings containing comment-like characters
 */

/**
 * Strip JSON comments from JSONC content while preserving string literals
 *
 * @param input - Raw JSONC string content
 * @returns Clean JSON string without comments
 */
export function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (char === "\\") {
        i++;
        if (i < input.length) result += input[i];
        continue;
      }
      if (char === stringChar) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return result;
}

/**
 * Remove trailing commas from JSON (JSONC allows them but JSON.parse() doesn't)
 *
 * Handles:
 * - ,} or ,]
 * - , } or , ]
 * - ,\n} or ,\n]
 *
 * @param input - JSON string potentially containing trailing commas
 * @returns Clean JSON string without trailing commas
 */
export function removeTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse JSONC content: strip comments, remove trailing commas, and parse as JSON
 *
 * @param input - Raw JSONC string content
 * @returns Parsed JavaScript object
 * @throws {SyntaxError} If the content is not valid JSON after cleanup
 */
export function parseJsonc<T = unknown>(input: string): T {
  const cleaned = stripJsonComments(input);
  const noTrailing = removeTrailingCommas(cleaned);
  return JSON.parse(noTrailing) as T;
}
