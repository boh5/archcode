import type { Logger } from "../../../logger";
import { silentLogger } from "../../../logger";

let _logger: Logger = silentLogger;

export function getLspToolLogger(): Logger {
  return _logger;
}

export function configureDefaultLspToolLogger(logger: Logger): void {
  _logger = logger;
}

export function resetLspToolLoggerForTest(): void {
  _logger = silentLogger;
}