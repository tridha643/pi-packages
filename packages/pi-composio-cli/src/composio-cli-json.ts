import { stripVTControlCharacters } from "node:util";

const AUTHORIZATION_HEADER_PATTERN = /^(\s*(?:authorization|proxy-authorization)\s*:\s*)[^\r\n]+$/gimu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const SECRET_FIELD_NAME_PATTERN = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|password|client[_-]?secret|private[_-]?key|cookie|token|secret)$/iu;
const JSON_SECRET_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|password|client[_-]?secret|private[_-]?key|cookie|token|secret)(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\r\n]+)/giu;

function isSensitiveComposioFieldName(name: string): boolean {
  const canonicalName = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    SECRET_FIELD_NAME_PATTERN.test(name) ||
    canonicalName.endsWith("apikey") ||
    canonicalName.endsWith("authtoken") ||
    canonicalName.endsWith("accesstoken") ||
    canonicalName.endsWith("refreshtoken") ||
    canonicalName.endsWith("sessiontoken") ||
    canonicalName.endsWith("accesskeyid") ||
    canonicalName.endsWith("clientsecret") ||
    canonicalName.endsWith("privatekey") ||
    canonicalName.endsWith("cookie")
  );
}

function redactComposioSecretText(value: string): string {
  return value
    .replace(AUTHORIZATION_HEADER_PATTERN, "$1[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(JSON_SECRET_PATTERN, "$1$2[REDACTED]");
}

function redactParsedComposioSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactParsedComposioSecrets);
  }
  if (typeof value === "string") {
    return redactComposioSecretText(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const redactedEntries = Object.entries(value).map(([key, entry]) => [
    key,
    isSensitiveComposioFieldName(key) ? "[REDACTED]" : redactParsedComposioSecrets(entry),
  ]);
  return Object.fromEntries(redactedEntries);
}

/** Remove terminal formatting from CLI output before parsing or displaying it. */
export function stripComposioCliAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

/** Redact common credential forms from failed CLI output while retaining diagnostics. */
export function sanitizeComposioCliError(value: string): string {
  const normalized = stripComposioCliAnsi(value).trim();
  const parsed = tryParseJson(normalized);
  if (parsed !== undefined) {
    return JSON.stringify(redactParsedComposioSecrets(parsed));
  }

  return redactComposioSecretText(normalized).trim();
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse either pure JSON or the last complete JSON object embedded in human CLI output. */
export function parseComposioCliJson(stdout: string): unknown | undefined {
  const normalized = stripComposioCliAnsi(stdout).trim();
  if (!normalized) {
    return undefined;
  }

  const completeValue = tryParseJson(normalized);
  if (completeValue !== undefined) {
    return completeValue;
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let latestValue: unknown | undefined;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === undefined) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = tryParseJson(normalized.slice(start, index + 1));
        if (candidate !== undefined) {
          latestValue = candidate;
        }
        start = -1;
      }
    }
  }

  return latestValue;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the safest useful message from a failed Composio CLI JSON payload. */
export function getComposioCliFailureMessage(parsed: unknown): string | undefined {
  if (!isUnknownRecord(parsed)) {
    return undefined;
  }

  for (const key of ["error", "message", "detail"] as const) {
    const candidate = parsed[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return sanitizeComposioCliError(candidate);
    }
    if (isUnknownRecord(candidate) && typeof candidate.message === "string") {
      return sanitizeComposioCliError(candidate.message);
    }
  }

  return undefined;
}

/** Narrow unknown JSON into an object without asserting provider-specific fields. */
export function isComposioJsonObject(value: unknown): value is Record<string, unknown> {
  return isUnknownRecord(value);
}
