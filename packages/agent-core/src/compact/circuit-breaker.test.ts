import { describe, expect, test } from "bun:test";
import { createCircuitBreaker } from "./circuit-breaker";

describe("createCircuitBreaker", () => {
  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  test("isOpen is false initially", () => {
    const breaker = createCircuitBreaker();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  test("accepts custom maxFailures parameter", () => {
    const breaker = createCircuitBreaker(5);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // recordFailure
  // ---------------------------------------------------------------------------

  test("recordFailure increments failure count", () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure();
    expect(breaker.failureCount).toBe(1);
    expect(breaker.isOpen).toBe(false);
  });

  test("opens after 3 consecutive failures (default maxFailures)", () => {
    const breaker = createCircuitBreaker();

    breaker.recordFailure(); // 1
    expect(breaker.isOpen).toBe(false);

    breaker.recordFailure(); // 2
    expect(breaker.isOpen).toBe(false);

    breaker.recordFailure(); // 3
    expect(breaker.failureCount).toBe(3);
    expect(breaker.isOpen).toBe(true);
  });

  test("opens after custom maxFailures", () => {
    const breaker = createCircuitBreaker(2);

    breaker.recordFailure(); // 1
    expect(breaker.isOpen).toBe(false);

    breaker.recordFailure(); // 2
    expect(breaker.failureCount).toBe(2);
    expect(breaker.isOpen).toBe(true);
  });

  test("stays open on additional failures", () => {
    const breaker = createCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);

    breaker.recordFailure(); // 4th failure
    expect(breaker.failureCount).toBe(4);
    expect(breaker.isOpen).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // recordSuccess
  // ---------------------------------------------------------------------------

  test("recordSuccess resets failure count to 0", () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.failureCount).toBe(2);

    breaker.recordSuccess();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  test("recordSuccess closes an open breaker", () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);

    breaker.recordSuccess();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  test("recordSuccess after partial failures resets counter", () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failureCount).toBe(0);

    // Subsequent failures start from 0
    breaker.recordFailure();
    expect(breaker.failureCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  test("reset clears failure count", () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);

    breaker.reset();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  test("reset on a clean breaker is a no-op", () => {
    const breaker = createCircuitBreaker();
    breaker.reset();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.isOpen).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Per-session isolation
  // ---------------------------------------------------------------------------

  test("two breakers are isolated (per-session)", () => {
    const breakerA = createCircuitBreaker();
    const breakerB = createCircuitBreaker();

    breakerA.recordFailure();
    breakerA.recordFailure();
    breakerA.recordFailure();

    expect(breakerA.isOpen).toBe(true);
    expect(breakerA.failureCount).toBe(3);

    // Breaker B is unaffected
    expect(breakerB.isOpen).toBe(false);
    expect(breakerB.failureCount).toBe(0);
  });

  test("breaker does not share state with another breaker with different maxFailures", () => {
    const breakerA = createCircuitBreaker(2);
    const breakerB = createCircuitBreaker(5);

    breakerA.recordFailure();
    breakerA.recordFailure();
    expect(breakerA.isOpen).toBe(true);

    expect(breakerB.isOpen).toBe(false);
    expect(breakerB.failureCount).toBe(0);
  });
});
