import type { SpecraRuntime } from "../main";

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export async function bootServer(_runtime: SpecraRuntime): Promise<void> {
  throw new NotImplementedError("bootServer is pending W2.S1 implementation");
}
