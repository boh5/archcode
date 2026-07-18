import type { ScopeRef } from "@archcode/protocol";

import { normalizeScopeRef, scopeRefsOverlap } from "../delegation/contract";
import { scopedKey } from "../store/key";

export interface BuildOwnershipLease {
  readonly sessionId: string;
  release(): void;
}

interface ActiveBuildOwnershipLease {
  readonly token: symbol;
  readonly sessionId: string;
  readonly ownedScope: readonly ScopeRef[];
}

export class BuildOwnershipConflictError extends Error {
  readonly code = "BUILD_OWNERSHIP_CONFLICT";

  constructor(
    public readonly sessionId: string,
    public readonly conflictingSessionId: string,
    public readonly requestedPath: string,
    public readonly conflictingPath: string,
  ) {
    super(
      `Build Session "${sessionId}" scope "${requestedPath}" overlaps active Build Session "${conflictingSessionId}" scope "${conflictingPath}"`,
    );
    this.name = "BuildOwnershipConflictError";
  }
}

/**
 * Runtime ownership admission for Build executions.
 *
 * The durable delegation contract remains the authority for owned scope. This
 * registry only holds one process-local lease for each active execution and is
 * rebuilt by cold activation from that persisted contract.
 */
export class BuildOwnershipLeaseRegistry {
  readonly #leasesByExecutionDomain = new Map<string, Map<symbol, ActiveBuildOwnershipLease>>();

  acquire(input: {
    readonly workspaceRoot: string;
    readonly executionCwd: string;
    readonly sessionId: string;
    readonly ownedScope: readonly ScopeRef[];
  }): BuildOwnershipLease {
    const ownedScope = input.ownedScope.map(normalizeScopeRef);
    if (ownedScope.length === 0) {
      throw new Error(`Build Session "${input.sessionId}" requires at least one owned scope`);
    }

    const domainKey = scopedKey(input.workspaceRoot, input.executionCwd);
    const active = this.#leasesByExecutionDomain.get(domainKey) ?? new Map();
    for (const existing of active.values()) {
      const overlap = firstScopeOverlap(ownedScope, existing.ownedScope);
      if (overlap !== undefined) {
        throw new BuildOwnershipConflictError(
          input.sessionId,
          existing.sessionId,
          overlap.requested.path,
          overlap.existing.path,
        );
      }
    }

    const token = Symbol(`build-ownership:${input.sessionId}`);
    active.set(token, { token, sessionId: input.sessionId, ownedScope });
    this.#leasesByExecutionDomain.set(domainKey, active);
    let released = false;
    return {
      sessionId: input.sessionId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#leasesByExecutionDomain.get(domainKey);
        if (current?.get(token)?.token !== token) return;
        current.delete(token);
        if (current.size === 0) this.#leasesByExecutionDomain.delete(domainKey);
      },
    };
  }
}

function firstScopeOverlap(
  requested: readonly ScopeRef[],
  existing: readonly ScopeRef[],
): { readonly requested: ScopeRef; readonly existing: ScopeRef } | undefined {
  for (const requestedScope of requested) {
    for (const existingScope of existing) {
      if (scopesOverlap(requestedScope, existingScope)) {
        return { requested: requestedScope, existing: existingScope };
      }
    }
  }
  return undefined;
}

function scopesOverlap(left: ScopeRef, right: ScopeRef): boolean {
  return scopeRefsOverlap(left, right);
}
