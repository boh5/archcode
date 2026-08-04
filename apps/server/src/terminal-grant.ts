import { randomBytes, timingSafeEqual } from "node:crypto";

const TERMINAL_GRANT_BYTES = 32;

/**
 * Process-local proof that a browser can read the server terminal. The same
 * grant can carry Config Recovery into Setup, and is consumed after a valid
 * Config becomes active.
 */
export class TerminalGrant {
  private readonly token = randomBytes(TERMINAL_GRANT_BYTES).toString("base64url");
  private consumed = false;

  url(baseUrl: string, pathname: "/setup" | "/config-recovery"): string {
    return `${baseUrl.replace(/\/$/, "")}${pathname}#token=${this.token}`;
  }

  authorize(header: string | undefined): boolean {
    if (this.consumed) return false;
    const candidate = parseBearerToken(header);
    if (candidate === undefined) return false;

    const expectedBytes = Buffer.from(this.token);
    const candidateBytes = Buffer.from(candidate);
    return expectedBytes.length === candidateBytes.length
      && timingSafeEqual(expectedBytes, candidateBytes);
  }

  consume(): void {
    this.consumed = true;
  }
}

function parseBearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}
