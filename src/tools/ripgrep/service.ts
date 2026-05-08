import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RipgrepService {
  /**
   * Ensure the rg binary is available. Returns the path to the rg executable.
   * Throws RipgrepNotFoundError if rg is not found anywhere.
   */
  ensure(): Promise<string>;
}

export class RipgrepNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RipgrepNotFoundError";
  }
}

/**
 * Injectable seam that wraps all I/O used during binary discovery.
 * Tests can provide a custom seam to avoid real filesystem / PATH lookups.
 */
export interface DiscoverySeam {
  which(command: string): string | null;
  exists(path: string): boolean;
  isExecutable(path: string): boolean;
  homeDir(): string;
  platform: string;
  arch: string;
}

// ---------------------------------------------------------------------------
// Default seam (production)
// ---------------------------------------------------------------------------

function createDefaultSeam(): DiscoverySeam {
  return {
    which(command: string): string | null {
      return Bun.which(command);
    },

    exists(path: string): boolean {
      return existsSync(path);
    },

    isExecutable(path: string): boolean {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },

    homeDir(): string {
      return process.env.HOME ?? homedir();
    },

    platform: process.platform,
    arch: process.arch,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a RipgrepService instance.
 *
 * @param seam - Optional injectable seam for testing. When omitted the
 *               production seam (real Bun.which, fs, os) is used.
 */
export function createRipgrepService(seam?: DiscoverySeam): RipgrepService {
  const s = seam ?? createDefaultSeam();
  let memoizedPath: string | null = null;

  return {
    async ensure(): Promise<string> {
      if (memoizedPath !== null) {
        return memoizedPath;
      }

      // 1. Search PATH via which(1).
      const pathInPath = s.which("rg");
      if (pathInPath !== null) {
        memoizedPath = pathInPath;
        return pathInPath;
      }

      // 2. Check ~/.specra/bin/<platform>-<arch>/rg (cached download).
      const cachedDir = `${s.homeDir()}/.specra/bin/${s.platform}-${s.arch}`;
      const cachedPath = `${cachedDir}/rg`;

      if (s.exists(cachedPath) && s.isExecutable(cachedPath)) {
        memoizedPath = cachedPath;
        return cachedPath;
      }

      // 3. Give up.
      throw new RipgrepNotFoundError(
        [
          "ripgrep (rg) binary not found. Please install it:",
          "  brew install ripgrep        (macOS)",
          "  apt install ripgrep         (Debian / Ubuntu)",
          "  pacman -S ripgrep           (Arch Linux)",
          "  winget install BurntSushi.ripgrep.MSVC  (Windows)",
          "",
          "Or download from: https://github.com/BurntSushi/ripgrep/releases",
        ].join("\n"),
      );
    },
  };
}
