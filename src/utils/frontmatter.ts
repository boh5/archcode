const FRONTMATTER_DELIMITER = "---";

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    throw new Error("Content does not start with frontmatter delimiter '---'");
  }

  const afterOpen = trimmed.slice(FRONTMATTER_DELIMITER.length);
  const closeIndex = afterOpen.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (closeIndex === -1) {
    throw new Error("No closing frontmatter delimiter found");
  }

  const yamlBlock = afterOpen.slice(0, closeIndex);
  const body = afterOpen
    .slice(closeIndex + 1 + FRONTMATTER_DELIMITER.length)
    .trimStart();

  return { frontmatter: parseSimpleYaml(yamlBlock), body };
}

export function formatFrontmatter(
  frontmatter: Record<string, string>,
  body: string,
): string {
  const yaml = formatSimpleYaml(frontmatter);
  return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${body}`;
}

export function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

export function formatSimpleYaml(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}
