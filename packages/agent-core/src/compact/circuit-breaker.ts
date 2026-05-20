export interface CircuitBreaker {
  readonly failureCount: number;
  readonly isOpen: boolean;
  recordFailure(): void;
  recordSuccess(): void;
  reset(): void;
}

export function createCircuitBreaker(maxFailures: number = 3): CircuitBreaker {
  let _failureCount = 0;

  return {
    get failureCount(): number {
      return _failureCount;
    },

    get isOpen(): boolean {
      return _failureCount >= maxFailures;
    },

    recordFailure(): void {
      _failureCount++;
    },

    recordSuccess(): void {
      _failureCount = 0;
    },

    reset(): void {
      _failureCount = 0;
    },
  };
}
