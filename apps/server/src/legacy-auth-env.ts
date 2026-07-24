const RETIRED_SERVER_PASSWORD_ENV = "ARCHCODE_SERVER_PASSWORD";

/**
 * Fails closed so an old deployment cannot silently become unauthenticated
 * after the Basic Auth hard cut.
 */
export function assertRetiredServerPasswordEnvAbsent(
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env[RETIRED_SERVER_PASSWORD_ENV] === undefined) return;
  throw new Error(
    `${RETIRED_SERVER_PASSWORD_ENV} has been removed. Unset it, start ArchCode, `
      + "and configure the optional server password in the Web setup or Security settings.",
  );
}
