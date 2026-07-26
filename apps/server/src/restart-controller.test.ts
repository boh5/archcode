import { describe, expect, mock, test } from "bun:test";
import { ServerRestartController } from "./restart-controller";

describe("ServerRestartController", () => {
  test("schedules one response-safe restart and ignores duplicate requests", async () => {
    let scheduled: (() => void) | undefined;
    const controller = new ServerRestartController({
      schedule(callback, delayMs) {
        expect(delayMs).toBe(100);
        scheduled = callback;
        return {};
      },
    });
    const restart = mock(async () => undefined);
    controller.bind(restart);

    controller.request();
    controller.request();
    scheduled?.();
    await Promise.resolve();

    expect(restart).toHaveBeenCalledTimes(1);
  });

  test("fails closed until graceful lifecycle shutdown is bound", () => {
    const controller = new ServerRestartController({
      schedule: () => ({}),
    });

    expect(() => controller.request()).toThrow(
      "This ArchCode process cannot restart itself",
    );
  });
});
