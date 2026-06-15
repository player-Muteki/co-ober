/**
 * Minimal YAML frontmatter parser for command/skill .md files.
 *
 * Supports the subset needed by Opencode-compatible command definitions:
 * scalars, inline arrays, block arrays, and one level of nested mappings.
 *
 * ```markdown
 * ---
 * description: Review the codebase
 * argument-hint: "[file-pattern]"
 * allowed-tools: [read, search]
 * model: claude-sonnet-4-20250514
 * agent: review
 * context:
 *   - src/
 * hooks:
 *   pre: ["echo starting"]
 * ---
 * Template body with $ARGUMENTS here.
 * ```
 */

export interface CommandFrontmatter {
  description?: string;
  /** @deprecated use hyphenated form */
  'argument-hint'?: string;
  argumentHint?: string;
  model?: string;
  agent?: string;
  'allowed-tools'?: string[];
  allowedTools?: string[];
  context?: string[];
  /** User-invocable flag — if false, command is hidden from / popover. */
  'user-invocable'?: boolean;
  userInvocable?: boolean;
  hooks?: {
    pre?: string[];
    post?: string[];
  };
  [key: string]: unknown;
}

export interface ParsedCommandFile {
  frontmatter: CommandFrontmatter;
  /** Body text after frontmatter (the template). */
  body: string;
}

/**
 * Parse frontmatter + body from a markdown file string.
 *
 * Returns null when no frontmatter delimiters are found.
 */
export function parseCommandFile(raw: string): ParsedCommandFile | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return null;

  const fmRaw = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  return {
    frontmatter: parseFrontmatter(fmRaw),
    body,
  };
}

/**
 * Parse a YAML frontmatter string into a structured object.
 */
function parseFrontmatter(raw: string): CommandFrontmatter {
  const result: CommandFrontmatter = {};
  const lines = raw.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Match key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const valuePart = trimmed.slice(colonIndex + 1).trim();

    // Inline array: [a, b, c]
    if (valuePart.startsWith('[')) {
      result[key] = parseInlineArray(valuePart);
      i++;
      continue;
    }

    // Inline scalar
    if (valuePart.length > 0) {
      result[key] = parseScalar(valuePart);
      i++;
      continue;
    }

    // Block value (next lines starting with "  - " or "    ")
    i++;
    const blockLines: string[] = [];
    while (i < lines.length) {
      const nextLine = lines[i];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed || nextTrimmed.startsWith('#')) {
        i++;
        continue;
      }
      // Block items start with "- "
      if (nextTrimmed.startsWith('- ')) {
        blockLines.push(nextTrimmed.slice(2).trim());
        i++;
        continue;
      }
      // Nested mapping
      if (nextTrimmed.includes(':') && lineIndent(nextLine) >= 2) {
        // Collect nested mapping
        const nestedKey = nextTrimmed.slice(0, nextTrimmed.indexOf(':')).trim();
        const nestedValue = nextTrimmed.slice(nextTrimmed.indexOf(':') + 1).trim();
        const nestedObj: Record<string, string[]> = {};
        if (nestedValue.startsWith('[')) {
          nestedObj[nestedKey] = parseInlineArray(nestedValue);
        } else if (!nestedValue) {
          // Block array under nested key
          const arr: string[] = [];
          i++;
          while (i < lines.length) {
            const al = lines[i].trim();
            if (al.startsWith('- ')) {
              arr.push(al.slice(2).trim());
              i++;
            } else {
              break;
            }
          }
          nestedObj[nestedKey] = arr;
        } else {
          nestedObj[nestedKey] = [String(parseScalar(nestedValue))];
        }
        result[key] = { ...(result[key] as object ?? {}), ...nestedObj };
        continue;
      }
      break; // Not a block continuation
    }

    if (blockLines.length > 0) {
      result[key] = blockLines;
    }

    // Normalize hyphenated field names to camelCase
    normalizeField(result, key);
  }

  return result;
}

function parseScalar(value: string): string | boolean | number {
  const unquoted = value.replace(/^["']|["']$/g, '').trim();
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  const num = Number(unquoted);
  if (!Number.isNaN(num) && String(num) === unquoted) return num;
  return unquoted;
}

function parseInlineArray(value: string): string[] {
  const inner = value.slice(1, value.lastIndexOf(']') > -1 ? value.lastIndexOf(']') : value.length);
  return inner.split(',').map((s) => String(parseScalar(s.trim()))).filter(Boolean);
}

function lineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function normalizeField(obj: Record<string, unknown>, key: string): void {
  // Map hyphenated keys to camelCase equivalents
  const camelKey = key.replace(/-([a-z])/g, (_, c) => (c as string).toUpperCase());
  if (camelKey !== key && obj[key] !== undefined) {
    (obj as Record<string, unknown>)[camelKey] = obj[key];
  }
}
