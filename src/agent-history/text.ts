export function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block !== "object" || block === null) return "";
      const record = block as Record<string, unknown>;
      if (record.type === "thinking" || record.type === "reasoning") return "";
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (Array.isArray(record.content)) return textFromContent(record.content) ?? "";
      return "";
    })
    .filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function sanitizeText(value: unknown): { redacted: boolean; text: string } {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) text = String(value);
  let redacted = false;
  for (const pattern of [
    /(Authorization:\s*Bearer\s+)[^\s]+/gi,
    /\b(token=)[^\s&]+/gi,
    /\b(password=)[^\s&]+/gi,
    /\b(secret=)[^\s&]+/gi,
    /\b(api_key=)[^\s&]+/gi,
  ]) {
    text = text.replace(pattern, (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  }
  return { redacted, text };
}

export function truncateChars(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join("")}...`;
}

export function messageRef(path: string, id: string | undefined, line: number): string {
  return id ? `${path}#entry=${id}` : `${path}#line=${line}`;
}

export function timestampFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

export function pathToPiSessionSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}
