import { randomBytes, timingSafeEqual } from "node:crypto";

const SETUP_TOKEN_BYTES = 32;

/**
 * Process-local proof that the person completing first-run setup can read the
 * server terminal. It has no persistence or configuration responsibility.
 */
export class SetupGrant {
  private readonly token = randomBytes(SETUP_TOKEN_BYTES).toString("base64url");
  private consumed = false;

  setupUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, "")}/setup#token=${this.token}`;
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
