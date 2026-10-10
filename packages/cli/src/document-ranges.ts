/**
 * Structural read ranges for documents and data files.
 *
 * Source code gets ranges from its symbols; Markdown and JSON have none, so
 * a recommended doc used to come back with zero ranges and agents read it
 * whole — the main early context cost in long phase-by-phase workstreams.
 * These helpers only find STRUCTURE (Markdown sections, JSON property /
 * element spans) with real 1-based line numbers of the original file;
 * deciding which sections matter for a task is the caller's job.
 */

export interface DocumentSection {
  /** "markdown heading" | "json key" | "json item" | one nested key of a top-level object ("json child") */
  kind: "markdown" | "json-key" | "json-item" | "json-child";
  /** Heading text, top-level key, `key[index]` (with an id hint when the element has one), or `parent.child`. */
  name: string;
  startLine: number;
  endLine: number;
  /** Text the section is scored against (heading/key plus its own body, bounded). */
  text: string;
  /** Markdown heading level (1-6); 0 for JSON. */
  level: number;
}

const MAX_SECTION_TEXT = 4000;
const MAX_SECTION_LINES = 120;
const JSON_SCAN_LIMIT = 2_000_000;

/**
 * Markdown sections from ATX headings (`#`..`######`), ignoring headings
 * inside fenced code blocks. A section runs from its heading to the line
 * before the next heading of the same or a higher level; when that is very
 * long it is cut at the next heading of any level so ranges stay focused.
 */
export function markdownSections(content: string): DocumentSection[] {
  const lines = content.split(/\r?\n/);
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // Emphasis markers only: `ROUTE_500_CLASSIFICATION` keeps its underscores (it is a name, not __bold__).
    if (match) headings.push({ line: index + 1, level: match[1].length, text: match[2].replace(/[*`]/g, "").replace(/(^|\s)__?(\S(?:.*?\S)?)__?(?=\s|$)/g, "$1$2").trim() });
  }
  return headings.map((heading, position) => {
    const nextAny = headings[position + 1]?.line ?? lines.length + 1;
    const nextSameOrHigher = headings.slice(position + 1).find((other) => other.level <= heading.level)?.line ?? lines.length + 1;
    let end = nextSameOrHigher - 1;
    if (end - heading.line + 1 > MAX_SECTION_LINES) end = nextAny - 1;
    end = Math.max(heading.line, trimTrailingBlank(lines, heading.line, end));
    const ownBodyEnd = Math.max(heading.line, nextAny - 1);
    return {
      kind: "markdown" as const,
      name: heading.text,
      startLine: heading.line,
      endLine: end,
      text: `${heading.text}\n${lines.slice(heading.line, ownBodyEnd).join("\n")}`.slice(0, MAX_SECTION_TEXT),
      level: heading.level
    };
  });
}

function trimTrailingBlank(lines: string[], start: number, end: number): number {
  let last = end;
  while (last > start && !lines[last - 1]?.trim()) last -= 1;
  return last;
}

/**
 * JSON structure with ORIGINAL line numbers, from a small single-pass
 * scanner (no dependency): it tracks strings and escapes, so braces or
 * brackets inside string values never change depth. JSON.parse is not used
 * for positions because it discards them.
 *
 * Returns top-level object properties, plus elements of top-level array
 * properties (with an id hint from the element's own `id`/`name`/`key`/
 * `code`/`case` string field), plus the properties one level inside a
 * top-level object value ("json child") so a very large object can be read
 * part by part — never deeper. Minified or single-line JSON returns nothing
 * — a line range is meaningless there, and pretty-printing would invent
 * line numbers that do not exist in the file.
 */
export function jsonSections(content: string): DocumentSection[] {
  if (content.length > JSON_SCAN_LIMIT) return [];
  const lines = content.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length < 3) return [];
  const sections: DocumentSection[] = [];
  let line = 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString: { value: string; line: number } | undefined;
  // Top-level property being read: key + start line + container type of its value.
  let current: { key: string; line: number; valueStart: number; isArray: boolean } | undefined;
  let pendingKey: { value: string; line: number } | undefined;
  let element: { start: number; line: number; index: number; idHint?: string } | undefined;
  let elementIndex = 0;
  let elementKey: string | undefined;
  let rootIsObject = false;
  // One nested level: a property of the current top-level OBJECT value.
  let child: { key: string; line: number; valueStart: number } | undefined;
  let pendingChildKey: { value: string; line: number } | undefined;
  let lastNonSpaceLine = 1;
  const closeChild = (endOffset: number, endLine: number) => {
    if (!child || !current) return;
    sections.push({
      kind: "json-child",
      name: `${current.key}.${child.key}`,
      startLine: child.line,
      endLine,
      text: `${current.key} ${child.key}\n${content.slice(child.valueStart, Math.min(endOffset + 1, child.valueStart + MAX_SECTION_TEXT))}`,
      level: 1
    });
    child = undefined;
  };

  const closeCurrent = (endOffset: number, endLine: number) => {
    if (!current) return;
    sections.push({
      kind: "json-key",
      name: current.key,
      startLine: current.line,
      endLine,
      text: `${current.key}\n${content.slice(current.valueStart, Math.min(endOffset + 1, current.valueStart + MAX_SECTION_TEXT))}`,
      level: 0
    });
    current = undefined;
  };

  const captureIdHint = () => {
    if (element && !element.idHint && elementKey && lastString && /^(?:id|name|key|code|case|phase|step)$/i.test(elementKey)) element.idHint = lastString.value.slice(0, 40);
  };

  let lastValueLine = 1;
  for (let offset = 0; offset < content.length; offset += 1) {
    const char = content[offset];
    // Line of the last non-space character BEFORE this one.
    const previousNonSpaceLine = lastNonSpaceLine;
    if (!/\s/.test(char)) lastNonSpaceLine = line;
    if (char === "\n") line += 1;
    else if (!/\s/.test(char) && char !== "}" && char !== "]") lastValueLine = line;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        let value = content.slice(stringStart + 1, offset);
        try {
          value = JSON.parse(`"${value}"`) as string;
        } catch {
          // Keep the raw text; it is only used as a label/id hint.
        }
        lastString = { value, line };
      }
      continue;
    }
    if (char === '"') {
      if (depth === 2 && pendingChildKey) {
        child = { key: pendingChildKey.value, line: pendingChildKey.line, valueStart: offset };
        pendingChildKey = undefined;
      }
      if (depth === 1 && pendingKey) {
        current = { key: pendingKey.value, line: pendingKey.line, valueStart: offset, isArray: false };
        pendingKey = undefined;
      }
      inString = true;
      stringStart = offset;
      continue;
    }
    if (char === ":") {
      if (depth === 1 && rootIsObject && lastString) pendingKey = lastString;
      if (depth === 2 && current && !current.isArray && lastString) pendingChildKey = lastString;
      if (element && depth === 3 && lastString) elementKey = lastString.value;
      lastString = undefined;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) rootIsObject = char === "{";
      if (depth === 2 && pendingChildKey) {
        child = { key: pendingChildKey.value, line: pendingChildKey.line, valueStart: offset };
        pendingChildKey = undefined;
      }
      depth += 1;
      if (depth === 2 && pendingKey && rootIsObject) {
        current = { key: pendingKey.value, line: pendingKey.line, valueStart: offset, isArray: char === "[" };
        elementIndex = 0;
        pendingKey = undefined;
      } else if (depth === 3 && current?.isArray) {
        element = { start: offset, line, index: elementIndex };
      }
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth === 3 && element) captureIdHint();
      if (depth === 2 && child) closeChild(offset - 1, previousNonSpaceLine);
      if (depth === 1 && current) closeCurrent(offset - 1, lastValueLine);
      if (depth === 3 && element && current) {
        sections.push({
          kind: "json-item",
          name: `${current.key}[${element.index}]${element.idHint ? ` ${element.idHint}` : ""}`,
          startLine: element.line,
          endLine: line,
          text: `${current.key} ${element.idHint ?? ""}\n${content.slice(element.start, Math.min(offset + 1, element.start + MAX_SECTION_TEXT))}`,
          level: 0
        });
        element = undefined;
      }
      if (depth === 2 && current) closeCurrent(offset, line);
      depth -= 1;
      continue;
    }
    if (char === ",") {
      if (depth === 2 && child) closeChild(offset - 1, previousNonSpaceLine);
      if (depth === 2 && current?.isArray) elementIndex += 1;
      if (element && depth === 3) captureIdHint();
      if (depth === 1 && current) {
        // Scalar top-level value ended.
        closeCurrent(offset, line);
      }
      elementKey = depth === 3 ? undefined : elementKey;
      lastString = undefined;
      continue;
    }
    if (depth === 2 && pendingChildKey && !/\s/.test(char)) {
      // Scalar value of a nested property starts here.
      child = { key: pendingChildKey.value, line: pendingChildKey.line, valueStart: offset };
      pendingChildKey = undefined;
    }
    if (depth === 1 && pendingKey && !/\s/.test(char)) {
      // Scalar value of a top-level property starts here.
      current = { key: pendingKey.value, line: pendingKey.line, valueStart: offset, isArray: false };
      pendingKey = undefined;
    }
  }
  if (current && depth <= 1) closeCurrent(content.length - 1, line);
  return sections.filter((section) => section.endLine >= section.startLine);
}
