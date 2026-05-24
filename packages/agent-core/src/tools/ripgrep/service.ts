import { createBinaryManager, createDefaultBinaryManagerSeam, BinaryNotFoundError, type BinaryManagerSeam } from "../../binary/manager";

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
  which?: BinaryManagerSeam["which"];
  exists?: BinaryManagerSeam["exists"];
  isExecutable?: BinaryManagerSeam["isExecutable"];
  platform?: string;
  arch?: string;
  processRunner?: BinaryManagerSeam["processRunner"];
  download?: BinaryManagerSeam["download"];
  verifySha256?: BinaryManagerSeam["verifySha256"];
  install?: BinaryManagerSeam["install"];
}

function createRipgrepBinaryManagerSeam(seam?: DiscoverySeam): BinaryManagerSeam {
  if (seam !== undefined) {
    return {
      ...createDefaultBinaryManagerSeam(),
      download: async (params) => {
        if (seam.download) return seam.download(params);
        throw new BinaryNotFoundError({ binaryId: "rg", binaryName: "rg" });
      },
      verifySha256: (params) => seam.verifySha256?.(params) ?? false,
      install: async (params) => {
        if (seam.install) return seam.install(params);
        throw new BinaryNotFoundError({ binaryId: "rg", binaryName: "rg" });
      },
      ...seam,
    };
  }

  return {
    ...createDefaultBinaryManagerSeam(),
  };
}

/**
 * Create a RipgrepService instance.
 *
 * @param seam - Optional injectable seam for testing. When omitted the
 *               production seam (BinaryManager default seam) is used.
 */
export function createRipgrepService(seam?: DiscoverySeam): RipgrepService {
  let manager: ReturnType<typeof createBinaryManager> | undefined;
  let memoizedPath: string | null = null;

  function getManager(): ReturnType<typeof createBinaryManager> {
    if (manager === undefined) {
      manager = createBinaryManager(createRipgrepBinaryManagerSeam(seam));
    }
    return manager;
  }

  return {
    async ensure(): Promise<string> {
      if (memoizedPath !== null) {
        return memoizedPath;
      }

      try {
        memoizedPath = await getManager().resolve("rg");
        return memoizedPath;
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("Binary")) {
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
        }

        throw error;
      }
    },
  };
}
