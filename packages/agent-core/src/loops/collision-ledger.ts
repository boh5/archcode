import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { CollisionConflict, CollisionLease, CollisionTarget, LoopCollisionSnapshot, LoopState } from "./state";
import { CollisionConflictSchema, CollisionLeaseSchema, LoopCollisionSnapshotSchema, LoopStateManager } from "./state";
import { atomicWrite, isContained } from "../utils/safe-file";

export interface CollisionLedgerClock {
  now(): number;
}

export interface CollisionLedgerOptions {
  readonly stateManager: LoopStateManager;
  readonly workspaceRoot: string;
  readonly clock?: CollisionLedgerClock;
  readonly leaseTtlMs?: number;
}

export interface CollisionAcquireInput {
  readonly target: CollisionTarget;
  readonly loopId: string;
  readonly runId: string;
  readonly actionId?: string;
  readonly toolCallId?: string;
  readonly priority: number;
  readonly createdAt?: number;
  readonly expiresAt?: number;
}

export interface CollisionAcquireResult {
  readonly acquired: boolean;
  readonly lease?: CollisionLease;
  readonly conflict?: CollisionConflict;
}

interface CollisionLedgerFile {
  readonly leases: CollisionLease[];
  readonly conflicts: CollisionConflict[];
  readonly updatedAt: number;
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const MAX_SNAPSHOT_ITEMS = 100;

const systemClock: CollisionLedgerClock = {
  now: () => Date.now(),
};

export class CollisionLedger {
  readonly #stateManager: LoopStateManager;
  readonly #workspaceRoot: string;
  readonly #clock: CollisionLedgerClock;
  readonly #leaseTtlMs: number;

  constructor(options: CollisionLedgerOptions) {
    this.#stateManager = options.stateManager;
    this.#workspaceRoot = options.workspaceRoot;
    this.#clock = options.clock ?? systemClock;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  get clock(): CollisionLedgerClock {
    return this.#clock;
  }

  async acquire(input: CollisionAcquireInput): Promise<CollisionAcquireResult> {
    const target = normalizeCollisionTarget(input.target, this.#workspaceRoot);
    const targetKey = canonicalTargetKey(target);
    const createdAt = input.createdAt ?? this.#clock.now();
    const incoming = CollisionLeaseSchema.parse({
      targetKey,
      target,
      loopId: input.loopId,
      runId: input.runId,
      actionId: input.actionId,
      toolCallId: input.toolCallId,
      priority: input.priority,
      createdAt,
      expiresAt: input.expiresAt ?? createdAt + this.#leaseTtlMs,
    });

    const ledger = await this.#readPrunedLedger();
    const existing = ledger.leases.find((lease) => lease.targetKey === targetKey);
    if (existing !== undefined && existing.loopId === incoming.loopId && existing.runId === incoming.runId) {
      const next = {
        leases: [...ledger.leases.filter((lease) => lease.targetKey !== targetKey), incoming],
        conflicts: ledger.conflicts,
        updatedAt: this.#clock.now(),
      } satisfies CollisionLedgerFile;
      await this.#writeLedger(next);
      await this.#persistSnapshots(next, [input.loopId]);
      return { acquired: true, lease: incoming };
    }

    if (existing !== undefined && leaseWins(existing, incoming)) {
      const conflict = CollisionConflictSchema.parse({
        targetKey,
        target,
        conflictingLease: existing,
        detectedAt: this.#clock.now(),
      });
      const next = {
        leases: ledger.leases,
        conflicts: trimNewest([...ledger.conflicts, conflict]),
        updatedAt: this.#clock.now(),
      } satisfies CollisionLedgerFile;
      await this.#writeLedger(next);
      await this.#persistSnapshots(next, [input.loopId, existing.loopId]);
      return { acquired: false, conflict };
    }

    const next = {
      leases: [...ledger.leases.filter((lease) => lease.targetKey !== targetKey), incoming],
      conflicts: ledger.conflicts,
      updatedAt: this.#clock.now(),
    } satisfies CollisionLedgerFile;
    await this.#writeLedger(next);
    await this.#persistSnapshots(next, existing ? [input.loopId, existing.loopId] : [input.loopId]);
    return { acquired: true, lease: incoming };
  }

  async acquireAll(inputs: readonly CollisionAcquireInput[]): Promise<CollisionAcquireResult[]> {
    const results: CollisionAcquireResult[] = [];
    const acquired: CollisionLease[] = [];
    for (const input of inputs) {
      const result = await this.acquire(input);
      results.push(result);
      if (result.lease !== undefined) acquired.push(result.lease);
      if (!result.acquired) {
        await Promise.all(acquired.map((lease) => this.release({
          targetKey: lease.targetKey,
          loopId: lease.loopId,
          runId: lease.runId,
          toolCallId: lease.toolCallId,
        })));
        break;
      }
    }
    return results;
  }

  async acquireStaticTargets(input: {
    readonly loop: LoopState;
    readonly runId: string;
    readonly priority: number;
    readonly actionId?: string;
  }): Promise<CollisionAcquireResult[]> {
    return await this.acquireAll((input.loop.config.collisionTargets ?? []).map((target) => ({
      target,
      loopId: input.loop.loopId,
      runId: input.runId,
      actionId: input.actionId,
      priority: input.priority,
    })));
  }

  async release(input: { readonly targetKey: string; readonly loopId: string; readonly runId: string; readonly toolCallId?: string }): Promise<void> {
    const ledger = await this.#readPrunedLedger();
    const nextLeases = ledger.leases.filter((lease) => {
      if (lease.targetKey !== input.targetKey) return true;
      if (lease.loopId !== input.loopId || lease.runId !== input.runId) return true;
      if (input.toolCallId !== undefined && lease.toolCallId !== input.toolCallId) return true;
      return false;
    });
    if (nextLeases.length === ledger.leases.length) return;

    const next = { ...ledger, leases: nextLeases, updatedAt: this.#clock.now() };
    await this.#writeLedger(next);
    await this.#persistSnapshots(next, [input.loopId]);
  }

  async releaseRun(loopId: string, runId: string): Promise<void> {
    const ledger = await this.#readPrunedLedger();
    const nextLeases = ledger.leases.filter((lease) => lease.loopId !== loopId || lease.runId !== runId);
    if (nextLeases.length === ledger.leases.length) return;

    const next = { ...ledger, leases: nextLeases, updatedAt: this.#clock.now() };
    await this.#writeLedger(next);
    await this.#persistSnapshots(next, [loopId]);
  }

  async releaseToolCall(loopId: string, runId: string, toolCallId: string): Promise<void> {
    const ledger = await this.#readPrunedLedger();
    const nextLeases = ledger.leases.filter((lease) => {
      if (lease.loopId !== loopId || lease.runId !== runId) return true;
      return lease.toolCallId !== toolCallId;
    });
    if (nextLeases.length === ledger.leases.length) return;

    const next = { ...ledger, leases: nextLeases, updatedAt: this.#clock.now() };
    await this.#writeLedger(next);
    await this.#persistSnapshots(next, [loopId]);
  }

  async cleanupStale(): Promise<CollisionLease[]> {
    const ledger = await this.#readLedger();
    const active = this.#activeLeases(ledger.leases);
    const removed = ledger.leases.filter((lease) => !active.includes(lease));
    if (removed.length === 0) return [];

    const next = { ...ledger, leases: active, updatedAt: this.#clock.now() };
    await this.#writeLedger(next);
    await this.#persistSnapshots(next, [...new Set(removed.map((lease) => lease.loopId))]);
    return removed;
  }

  async readActiveLeases(): Promise<CollisionLease[]> {
    return (await this.#readPrunedLedger()).leases;
  }

  async readConflicts(): Promise<CollisionConflict[]> {
    return (await this.#readPrunedLedger()).conflicts;
  }

  async #readPrunedLedger(): Promise<CollisionLedgerFile> {
    const ledger = await this.#readLedger();
    const active = this.#activeLeases(ledger.leases);
    if (active.length === ledger.leases.length) return ledger;

    const next = { ...ledger, leases: active, updatedAt: this.#clock.now() };
    await this.#writeLedger(next);
    return next;
  }

  async #readLedger(): Promise<CollisionLedgerFile> {
    const filePath = await collisionLedgerPath(this.#workspaceRoot);
    if (!(await Bun.file(filePath).exists())) {
      return { leases: [], conflicts: [], updatedAt: this.#clock.now() };
    }

    const parsed = JSON.parse(await Bun.file(filePath).text()) as Partial<CollisionLedgerFile>;
    return {
      leases: (parsed.leases ?? []).map((lease) => CollisionLeaseSchema.parse(lease)),
      conflicts: (parsed.conflicts ?? []).map((conflict) => CollisionConflictSchema.parse(conflict)),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : this.#clock.now(),
    };
  }

  async #writeLedger(ledger: CollisionLedgerFile): Promise<void> {
    const filePath = await collisionLedgerPath(this.#workspaceRoot);
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWrite(filePath, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  async #persistSnapshots(ledger: CollisionLedgerFile, loopIds: readonly string[]): Promise<void> {
    const uniqueLoopIds = [...new Set(loopIds)];
    await Promise.all(uniqueLoopIds.map(async (loopId) => {
      try {
        await this.#stateManager.updateCollisionSnapshot(loopId, this.#snapshotForLoop(ledger, loopId));
      } catch {
        // A lease can outlive a deleted loop. The ledger remains authoritative.
      }
    }));
  }

  #snapshotForLoop(ledger: CollisionLedgerFile, loopId: string): LoopCollisionSnapshot {
    const activeLeases = ledger.leases.filter((lease) => lease.loopId === loopId);
    const conflicts = ledger.conflicts.filter((conflict) => conflict.conflictingLease.loopId === loopId);
    const targets = activeLeases.map((lease) => lease.target);
    return LoopCollisionSnapshotSchema.parse({
      targets: trimNewest(targets),
      activeLeases: trimNewest(activeLeases),
      conflicts: trimNewest(conflicts),
      updatedAt: this.#clock.now(),
    });
  }

  #activeLeases(leases: readonly CollisionLease[]): CollisionLease[] {
    const now = this.#clock.now();
    return leases.filter((lease) => lease.expiresAt > now);
  }
}

export function canonicalTargetKey(target: CollisionTarget): string {
  if (target.type === "pr") return `github:${target.owner}/${target.repo}:pr:${target.number}`;
  if (target.type === "issue") return `github:${target.owner}/${target.repo}:issue:${target.number}`;
  if (target.type === "branch") return `git:${target.owner}/${target.repo}:branch:${target.branch}`;
  return `file:${target.path}`;
}

export function normalizeCollisionTarget(target: CollisionTarget, workspaceRoot: string): CollisionTarget {
  if (target.type !== "file") return target;
  return { type: "file", path: normalizeWorkspaceRelativePath(target.path, workspaceRoot) };
}

export function normalizeWorkspaceRelativePath(inputPath: string, workspaceRoot: string): string {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absolutePath = resolve(absoluteWorkspaceRoot, inputPath);
  const workspaceRealPath = safeRealpathSync(absoluteWorkspaceRoot);
  const resolvedPath = resolveExistingAncestorWithTail(absolutePath);
  if (!isContained(resolvedPath, workspaceRealPath)) {
    throw new CollisionPathError(inputPath, workspaceRoot);
  }
  const projectRelative = relative(workspaceRealPath, resolvedPath).split(sep).join("/");
  return projectRelative.length === 0 ? "." : projectRelative;
}

export class CollisionPathError extends Error {
  constructor(public readonly inputPath: string, public readonly workspaceRoot: string) {
    super(`Collision target path is outside the workspace: ${inputPath}`);
    this.name = "CollisionPathError";
  }
}

function leaseWins(existing: CollisionLease, incoming: CollisionLease): boolean {
  if (existing.priority !== incoming.priority) return existing.priority > incoming.priority;
  return existing.createdAt <= incoming.createdAt;
}

function trimNewest<T>(items: readonly T[]): T[] {
  return items.slice(-MAX_SNAPSHOT_ITEMS);
}

async function collisionLedgerPath(workspaceRoot: string): Promise<string> {
  const root = resolve(workspaceRoot, ".archcode", "loops");
  const filePath = resolve(root, "collision-ledger.json");
  if (!isContained(filePath, root)) throw new Error("Invalid collision ledger path");
  return filePath;
}

function resolveExistingAncestorWithTail(absolutePath: string): string {
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const parent = dirname(absolutePath);
    if (parent === absolutePath) return absolutePath;
    return join(resolveExistingAncestorWithTail(parent), basename(absolutePath));
  }
}

function safeRealpathSync(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export async function removeCollisionLedgerForTest(workspaceRoot: string): Promise<void> {
  await rm(await collisionLedgerPath(workspaceRoot), { force: true });
}
