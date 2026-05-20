import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { getSystemErrorCode } from "../utils";

const AGENTS_MD_FILENAME = "AGENTS.md";

export class AgentsMdNotFoundError extends Error {
  constructor(
    message: string,
    public readonly searchedFrom: string,
  ) {
    super(message);
    this.name = "AgentsMdNotFoundError";
  }
}

export class AgentsMdLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentsMdLoadError";
  }
}

/**
 * Search upward from `startDir` for an AGENTS.md file.
 * Returns the absolute file path if found, or undefined.
 * Distinguishes ENOENT (not found → keep searching) from EACCES
 * (permission denied → throw AgentsMdLoadError).
 */
export async function findAgentsMd(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, AGENTS_MD_FILENAME);

    // existsSync is synchronous but cheap; avoids try/catch on file.stat()
    // which would swallow permission errors.
    if (existsSync(candidate)) {
      // Verify it's actually readable (not EACCES)
      try {
        const file = Bun.file(candidate);
        await file.stat();
        return candidate;
      } catch (err) {
        const code = getSystemErrorCode(err);
        if (code === "EACCES" || code === "EPERM") {
          throw new AgentsMdLoadError(
            `AGENTS.md found but not readable: ${candidate}`,
            candidate,
            { cause: err },
          );
        }
        // Other stat errors (e.g. broken symlink) — skip and continue upward
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return undefined;
}

/**
 * Load AGENTS.md content starting from `startDir`, walking up directories.
 * Returns undefined if no AGENTS.md is found.
 * Throws AgentsMdLoadError if found but unreadable.
 */
export async function loadAgentsMd(startDir: string): Promise<string | undefined> {
  const filePath = await findAgentsMd(startDir);
  if (!filePath) return undefined;

  try {
    return await Bun.file(filePath).text();
  } catch (err) {
    throw new AgentsMdLoadError(
      `Failed to read AGENTS.md: ${filePath}`,
      filePath,
      { cause: err },
    );
  }
}