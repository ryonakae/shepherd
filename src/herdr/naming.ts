const HERDR_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_HERDR_NAME_BYTES = 64;

export function validateHerdrName(name: string): void {
  if (!HERDR_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Herdr name: ${name}`);
  }

  if (Buffer.byteLength(name, "utf8") > MAX_HERDR_NAME_BYTES) {
    throw new Error(`Herdr name is longer than ${MAX_HERDR_NAME_BYTES} bytes: ${name}`);
  }
}

export function slugifyHerdrName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length > 0 ? slug : "untitled";
}

export function herdrSessionNameForWorkingContext(slug: string): string {
  const name = truncateToHerdrName(`shepherd-${slugifyHerdrName(slug)}`);
  validateHerdrName(name);
  return name;
}

export function herdrWorkspaceNameForTask(taskSlug: string, shortId: string): string {
  const name = truncateToHerdrName(
    `shepherd-${slugifyHerdrName(taskSlug)}-${slugifyHerdrName(shortId)}`,
  );
  validateHerdrName(name);
  return name;
}

function truncateToHerdrName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_HERDR_NAME_BYTES) {
    return name;
  }

  let result = "";
  for (const char of name) {
    const next = `${result}${char}`;
    if (Buffer.byteLength(next, "utf8") > MAX_HERDR_NAME_BYTES) {
      break;
    }
    result = next;
  }

  return result.replace(/[._-]+$/g, "");
}
