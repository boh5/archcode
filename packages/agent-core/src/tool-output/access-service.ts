import type {
  ArtifactAuthorizationScope,
  OutputReadInput,
  OutputReadPage,
  OutputSearchInput,
  OutputSearchPage,
} from "./artifact-types";
import { ToolOutputArtifactStore, computeProjectIdentity } from "./artifact-store";

export type ScopedOutputReadInput = Omit<OutputReadInput, keyof ArtifactAuthorizationScope>;
export type ScopedOutputSearchInput = Omit<OutputSearchInput, keyof ArtifactAuthorizationScope>;

/** Scope-bound output recovery exposed to Tools and HTTP adapters. */
export interface ToolOutputAccessService {
  read(input: ScopedOutputReadInput): Promise<OutputReadPage>;
  search(input: ScopedOutputSearchInput): Promise<OutputSearchPage>;
  countRecoverable(): Promise<number>;
}

export interface ScopeBoundToolOutputAccessOptions {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
}

export class ScopeBoundToolOutputAccess implements ToolOutputAccessService {
  readonly #store: ToolOutputArtifactStore;
  readonly #scope: Promise<ArtifactAuthorizationScope>;

  constructor(
    store: ToolOutputArtifactStore,
    options: ScopeBoundToolOutputAccessOptions,
  ) {
    this.#store = store;
    this.#scope = computeProjectIdentity(options.workspaceRoot).then((projectIdentity) => ({
      projectIdentity,
      rootSessionId: options.rootSessionId,
    }));
  }

  async read(input: ScopedOutputReadInput): Promise<OutputReadPage> {
    return await this.#store.read({ ...input, ...await this.#scope });
  }

  async search(input: ScopedOutputSearchInput): Promise<OutputSearchPage> {
    return await this.#store.search({ ...input, ...await this.#scope });
  }

  async countRecoverable(): Promise<number> {
    return await this.#store.countRecoverable(await this.#scope);
  }
}

export function createScopeBoundToolOutputAccess(
  store: ToolOutputArtifactStore,
  options: ScopeBoundToolOutputAccessOptions,
): ToolOutputAccessService {
  return new ScopeBoundToolOutputAccess(store, options);
}
