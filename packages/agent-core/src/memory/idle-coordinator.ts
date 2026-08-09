import { randomUUID } from "node:crypto";
import type { MemoryBlockedWarning } from "@archcode/protocol";

import type { ExecutionModelBinding } from "../models";
import { ModelSelectionResolver, type ModelRuntime } from "../models";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import {
	runLlmObject,
	LlmSchemaValidationError,
	type LlmObjectInput,
} from "../llm";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { utf8ByteLength } from "../tool-output/utf8";
import { createMutationQueue } from "../tools/concurrency/mutation-queue";
import {
	DEFAULT_MAX_PREFERENCES_BYTES,
	MAX_MEMORY_TOPIC_BYTES,
	MAX_MEMORY_TOPICS,
} from "./constants";
import {
	MemoryCapacityError,
	MemoryRevisionConflictError,
	MemorySecretError,
	MemoryValidationError,
} from "./errors";
import {
	formatFrontmatter,
	formatIndex,
	parseFrontmatter,
	parseIndex,
} from "./file-manager";
import {
	buildMemoryExtractionInput,
	removeAlreadySavedCandidates,
} from "./learning-input";
import {
	MemoryExtractionResultSchema,
	MemoryPendingApplyReceiptSchema,
	MemoryReconciliationResultSchema,
} from "./learning-schemas";
import {
	MEMORY_IDLE_DELAY_MS,
	type MemoryExtractionCandidate,
	type MemoryLearningBlocked,
	type MemoryLearningBlockedCode,
	type MemoryLearningState,
	type MemoryPendingApplyReceipt,
	type MemoryPolicyEpoch,
} from "./learning-state";
import type {
	MemoryPolicyRuntime,
	MemoryPolicySnapshot,
} from "./policy-runtime";
import {
	applyMemoryReconciliation,
	buildMemoryReconciliationInput,
	filterUnsafeMemoryCandidates,
	type MemoryReconciliationTarget,
} from "./reconciliation";
import {
	memoryRevision,
	type MemoryDocumentTarget,
	type MemoryService,
} from "./service";

type TimerHandle = ReturnType<typeof setTimeout>;
type MemoryObjectRunner = <T>(input: LlmObjectInput<T>) => Promise<T>;

// Automatic learning has a wider read -> LLM -> durable-apply critical section
// than MemoryService's short mutation lanes. Keep its locks separate so manual
// and API writes never wait for a model call. The module singleton coordinates
// all coordinator instances in this process.
const automaticTargetQueue = createMutationQueue();

export interface MemoryIdleCoordinatorOptions {
	readonly sessionStores: SessionStoreManager;
	readonly policyRuntime: MemoryPolicyRuntime;
	readonly modelRuntime: ModelRuntime;
	readonly resolveMemoryService: (
		workspaceRoot: string,
	) => Promise<MemoryService>;
	readonly modelSelectionResolver?: ModelSelectionResolver;
	readonly logger?: Logger;
	readonly runObject?: MemoryObjectRunner;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	readonly clearTimer?: (handle: TimerHandle) => void;
}

interface SessionKey {
	readonly workspaceRoot: string;
	readonly sessionId: string;
}

interface ActiveJob {
	readonly abort: AbortController;
	readonly promise: Promise<void>;
}

interface FinalTarget {
	readonly scope: "user" | "project";
	readonly name: string;
	readonly expectedRevision: string | null;
	readonly finalDocument: string;
	readonly finalRevision: string;
}

/**
 * Runtime-scoped owner of Memory's one narrowly-defined background lifecycle.
 * It is intentionally not a generic scheduler: one root Session maps to one
 * debounce timer, one in-flight batch, one durable cursor and one receipt.
 */
export class MemoryIdleCoordinator {
	readonly #sessionStores: SessionStoreManager;
	readonly #policyRuntime: MemoryPolicyRuntime;
	readonly #modelRuntime: ModelRuntime;
	readonly #resolveMemoryService: MemoryIdleCoordinatorOptions["resolveMemoryService"];
	readonly #modelSelectionResolver: ModelSelectionResolver;
	readonly #logger: Logger;
	readonly #runObject: MemoryObjectRunner;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #setTimer: NonNullable<MemoryIdleCoordinatorOptions["setTimer"]>;
	readonly #clearTimer: NonNullable<MemoryIdleCoordinatorOptions["clearTimer"]>;
	readonly #timers = new Map<string, TimerHandle>();
	readonly #jobs = new Map<string, ActiveJob>();
	readonly #knownWorkspaces = new Set<string>();
	readonly #recoveredThisBoot = new Set<string>();
	readonly #lastAttemptedEligible = new Map<string, string>();
	readonly #suppressedAfterUnexpectedFailure = new Set<string>();
	readonly #enablePreparedSessions = new Set<string>();
	#unsubscribeEvents: (() => void) | undefined;
	#unsubscribePolicy: (() => void) | undefined;
	#started = false;
	#closed = false;
	#lastAutoLearning: boolean;

	constructor(options: MemoryIdleCoordinatorOptions) {
		this.#sessionStores = options.sessionStores;
		this.#policyRuntime = options.policyRuntime;
		this.#modelRuntime = options.modelRuntime;
		this.#resolveMemoryService = options.resolveMemoryService;
		this.#modelSelectionResolver =
			options.modelSelectionResolver ?? new ModelSelectionResolver();
		this.#logger = (options.logger ?? silentLogger).child({
			module: "memory.idle",
		});
		this.#runObject = options.runObject ?? runLlmObject;
		this.#now = options.now ?? Date.now;
		this.#createId = options.createId ?? randomUUID;
		this.#setTimer =
			options.setTimer ??
			((callback, delayMs) => setTimeout(callback, delayMs));
		this.#clearTimer = options.clearTimer ?? clearTimeout;
		this.#lastAutoLearning = options.policyRuntime.current.policy.autoLearning;
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.#unsubscribeEvents = this.#sessionStores.subscribeToSessionEvents(
			(event) => {
				if (
					event.envelope.payload.type !== "session.message_accepted" &&
					event.envelope.payload.type !== "execution-end"
				)
					return;
				const key = this.#key(event.workspaceRoot, event.sessionId);
				this.#knownWorkspaces.add(event.workspaceRoot);
				if (event.envelope.payload.type === "session.message_accepted") {
					this.#cancelTimer(key);
				}
				void this.#refreshSession(
					{ workspaceRoot: event.workspaceRoot, sessionId: event.sessionId },
					event.envelope.payload.type === "execution-end"
						? "activity"
						: "event",
				).catch((error) =>
					this.#logFailure(
						"memory.idle.event_failed",
						event.workspaceRoot,
						event.sessionId,
						error,
					),
				);
			},
		);
		this.#unsubscribePolicy = this.#policyRuntime.subscribe({
			beforeEnable: async () => {
				await this.#prepareEnable();
			},
			afterEnableFailure: async () => {
				try {
					await this.#skipDisabledPeriod();
				} finally {
					this.#enablePreparedSessions.clear();
				}
			},
			afterCommit: async (snapshot) => {
				await this.#handleCommittedPolicy(snapshot);
			},
		});
	}

	/** Reconciles persisted root state once per Session and boot. */
	async recoverWorkspace(workspaceRoot: string): Promise<void> {
		this.start();
		this.#knownWorkspaces.add(workspaceRoot);
		const summaries =
			await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
		for (const summary of summaries) {
			if (
				summary.parentSessionId !== undefined ||
				summary.rootSessionId !== summary.sessionId
			)
				continue;
			if (summary.agentName !== "lead" && summary.agentName !== "discussion")
				continue;
			if (summary.source?.kind === "automation") continue;
			const key = this.#key(workspaceRoot, summary.sessionId);
			if (this.#recoveredThisBoot.has(key)) continue;
			this.#recoveredThisBoot.add(key);
			await this.#refreshSession(
				{ workspaceRoot, sessionId: summary.sessionId },
				"recovery",
			);
		}
	}

	/**
	 * Called from MemoryService mutation notification. It returns before reading
	 * Memory so a Service mutation lane can never wait on itself.
	 */
	notifyTargetChanged(
		workspaceRoot: string,
		target: MemoryDocumentTarget,
	): void {
		if (this.#closed) return;
		this.start();
		this.#knownWorkspaces.add(workspaceRoot);
		queueMicrotask(() => {
			const workspaces =
				target.scope === "user" ? [...this.#knownWorkspaces] : [workspaceRoot];
			void Promise.allSettled(
				workspaces.map(async (candidateWorkspace) => {
					try {
						await this.#retrySessionsForTarget(candidateWorkspace, target);
					} catch (error) {
						this.#logFailure(
							"memory.idle.target_change_failed",
							candidateWorkspace,
							undefined,
							error,
						);
					}
				}),
			);
		});
	}

	async listWarnings(workspaceRoot: string): Promise<MemoryBlockedWarning[]> {
		const warnings: MemoryBlockedWarning[] = [];
		const summaries =
			await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
		for (const summary of summaries) {
			if (
				summary.parentSessionId !== undefined ||
				summary.rootSessionId !== summary.sessionId
			)
				continue;
			const file = await this.#sessionStores.getSessionFile(
				workspaceRoot,
				summary.sessionId,
			);
			const blocked = file.memoryLearning?.blocked;
			if (blocked === undefined) continue;
			warnings.push({
				code: blocked.code,
				sessionId: file.sessionId,
				blockedAt: blocked.blockedAt,
				...(blocked.target === undefined
					? {}
					: { target: `${blocked.target.scope}:${blocked.target.name}` }),
				message: warningMessage(blocked.code),
			});
		}
		return warnings.sort(
			(left, right) =>
				(left.blockedAt ?? 0) - (right.blockedAt ?? 0) ||
				(left.sessionId ?? "").localeCompare(right.sessionId ?? ""),
		);
	}

	async disposeWorkspace(workspaceRoot: string): Promise<void> {
		this.#knownWorkspaces.delete(workspaceRoot);
		const prefix = `${workspaceRoot}\0`;
		for (const key of [...this.#timers.keys()]) {
			if (key.startsWith(prefix)) this.#cancelTimer(key);
		}
		for (const [key, job] of this.#jobs) {
			if (key.startsWith(prefix)) job.abort.abort();
		}
		for (const key of [...this.#enablePreparedSessions]) {
			if (key.startsWith(prefix)) this.#enablePreparedSessions.delete(key);
		}
		await Promise.allSettled(
			[...this.#jobs.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([, job]) => job.promise),
		);
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribeEvents?.();
		this.#unsubscribePolicy?.();
		for (const key of [...this.#timers.keys()]) this.#cancelTimer(key);
		for (const job of this.#jobs.values()) job.abort.abort();
		this.#enablePreparedSessions.clear();
		await Promise.allSettled(
			[...this.#jobs.values()].map((job) => job.promise),
		);
	}

	async #skipDisabledPeriod(): Promise<void> {
		for (const workspaceRoot of this.#knownWorkspaces) {
			await this.#skipWorkspace(workspaceRoot);
		}
	}

	async #prepareEnable(): Promise<void> {
		this.#enablePreparedSessions.clear();
		for (const workspaceRoot of this.#knownWorkspaces) {
			const summaries =
				await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
			for (const summary of summaries) {
				if (
					summary.parentSessionId !== undefined ||
					summary.rootSessionId !== summary.sessionId
				)
					continue;
				const session = { workspaceRoot, sessionId: summary.sessionId };
				await this.#skipSession(session, true);
				this.#enablePreparedSessions.add(this.#key(workspaceRoot, summary.sessionId));
			}
		}
	}

	async #handleCommittedPolicy(snapshot: MemoryPolicySnapshot): Promise<void> {
		const previous = this.#lastAutoLearning;
		this.#lastAutoLearning = snapshot.policy.autoLearning;
		if (previous === snapshot.policy.autoLearning) return;
		if (snapshot.policy.autoLearning) {
			try {
				for (const workspaceRoot of this.#knownWorkspaces) {
					await this.#refreshWorkspace(workspaceRoot);
				}
			} finally {
				this.#enablePreparedSessions.clear();
			}
			return;
		}
		for (const key of [...this.#timers.keys()]) this.#cancelTimer(key);
		for (const job of this.#jobs.values()) job.abort.abort();
		for (const workspaceRoot of this.#knownWorkspaces) {
			await this.#skipWorkspace(workspaceRoot);
		}
	}

	async #refreshWorkspace(workspaceRoot: string): Promise<void> {
		const summaries =
			await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
		for (const summary of summaries) {
			if (
				summary.parentSessionId !== undefined ||
				summary.rootSessionId !== summary.sessionId
			)
				continue;
			await this.#refreshSession(
				{ workspaceRoot, sessionId: summary.sessionId },
				"activity",
			);
		}
	}

	async #skipWorkspace(workspaceRoot: string): Promise<void> {
		const summaries =
			await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
		for (const summary of summaries) {
			if (
				summary.parentSessionId !== undefined ||
				summary.rootSessionId !== summary.sessionId
			)
				continue;
			await this.#skipSession({ workspaceRoot, sessionId: summary.sessionId });
		}
	}

	async #skipSession(
		session: SessionKey,
		establishEnableBaseline = false,
	): Promise<void> {
		const key = this.#key(session.workspaceRoot, session.sessionId);
		const skipped = await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				// Re-check at the durable mutation boundary. A refresh that observed
				// disabled before enable-pending began must not skip messages admitted
				// after beforeEnable established this Session's exact message-id cursor.
				if (!this.#canSkipSession(key, establishEnableBaseline)) {
					return { result: false };
				}
				const learning = state.memoryLearning;
				if (learning === undefined) return { result: false };
				const through =
					state.messages.at(-1)?.id ?? learning.processedThroughMessageId;
				const next: MemoryLearningState = {
					processedThroughMessageId: through,
				};
				return { result: true, patch: { memoryLearning: next } };
			},
		);
		if (
			skipped &&
			this.#canSkipSession(key, establishEnableBaseline)
		) {
			this.#cancelTimer(key);
		}
	}

	#canSkipSession(key: string, establishEnableBaseline: boolean): boolean {
		const admission = this.#policyRuntime.autoLearningAdmission;
		if (admission === "enabled" || admission === "enable_pending") {
			return false;
		}
		return admission !== "enable_preparing" ||
			establishEnableBaseline ||
			!this.#enablePreparedSessions.has(key);
	}

	async #refreshSession(
		session: SessionKey,
		trigger: "event" | "activity" | "recovery" | "manual" | "settled",
	): Promise<void> {
		if (this.#closed) return;
		const key = this.#key(session.workspaceRoot, session.sessionId);
		if (
			trigger === "activity" ||
			trigger === "recovery" ||
			trigger === "manual"
		) {
			this.#suppressedAfterUnexpectedFailure.delete(key);
		} else if (this.#suppressedAfterUnexpectedFailure.has(key)) {
			return;
		}
		this.#knownWorkspaces.add(session.workspaceRoot);
		const file = await this.#sessionStores.getSessionFile(
			session.workspaceRoot,
			session.sessionId,
		);
		if (!isEligibleRoot(file)) {
			this.#cancelTimer(key);
			return;
		}
		if (!this.#policyRuntime.current.policy.autoLearning) {
			const admission = this.#policyRuntime.autoLearningAdmission;
			if (
				admission === "enable_pending" ||
				(admission === "enable_preparing" &&
					this.#enablePreparedSessions.has(key))
			) {
				this.#cancelTimer(key);
				return;
			}
			await this.#skipSession(session);
			return;
		}
		if (
			file.pendingMessages.some((message) => message.source === "user") ||
			file.executions.some(
				(execution) =>
					execution.status === "running" || execution.status === "suspended",
			)
		) {
			this.#cancelTimer(key);
			return;
		}
		const learning = file.memoryLearning;
		if (learning?.pendingApply !== undefined) {
			if (trigger === "recovery")
				await this.#rebindReceipt(session, learning.pendingApply);
			const newWindowArrived =
				learning.eligibleThroughMessageId !== undefined &&
				learning.eligibleThroughMessageId !==
					learning.pendingApply.captured.eligibleThroughMessageId;
			if (
				learning.blocked === undefined ||
				trigger === "recovery" ||
				trigger === "manual" ||
				(trigger === "activity" && newWindowArrived)
			) {
				this.#launch(session);
			}
			return;
		}
		if (
			learning?.eligibleThroughMessageId === undefined ||
			learning.idleSince === undefined
		) {
			this.#cancelTimer(key);
			return;
		}
		if (
			learning.processedThroughMessageId === learning.eligibleThroughMessageId
		) {
			this.#cancelTimer(key);
			return;
		}
		if (learning.blocked !== undefined) {
			const newWindowArrived =
				this.#lastAttemptedEligible.get(key) !==
				learning.eligibleThroughMessageId;
			if (trigger === "recovery" || trigger === "manual") {
				this.#launch(session);
			} else if (
				(trigger === "activity" || trigger === "settled") &&
				newWindowArrived
			) {
				this.#schedule(session, learning.idleSince);
			}
			return;
		}
		this.#schedule(session, learning.idleSince);
	}

	#schedule(session: SessionKey, idleSince: number): void {
		const key = this.#key(session.workspaceRoot, session.sessionId);
		if (this.#jobs.has(key)) return;
		this.#cancelTimer(key);
		const delay = Math.max(0, idleSince + MEMORY_IDLE_DELAY_MS - this.#now());
		const handle = this.#setTimer(() => {
			if (this.#timers.get(key) !== handle) return;
			this.#timers.delete(key);
			this.#launch(session);
		}, delay);
		this.#timers.set(key, handle);
	}

	#launch(session: SessionKey): void {
		if (this.#closed) return;
		const key = this.#key(session.workspaceRoot, session.sessionId);
		if (this.#jobs.has(key)) return;
		this.#cancelTimer(key);
		const abort = new AbortController();
		const promise = this.#runBatch(session, abort.signal)
			.catch(async (error) => {
				this.#logFailure(
					"memory.idle.batch_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				if (!abort.signal.aborted) {
					this.#suppressedAfterUnexpectedFailure.add(key);
					await this.#blockUnexpected(session);
					this.#suppressedAfterUnexpectedFailure.delete(key);
				}
			})
			.finally(() => {
				if (this.#jobs.get(key)?.promise === promise) this.#jobs.delete(key);
				if (!this.#closed) {
					void this.#refreshSession(session, "settled").catch((error) => {
						this.#logFailure(
							"memory.idle.reschedule_failed",
							session.workspaceRoot,
							session.sessionId,
							error,
						);
					});
				}
			});
		this.#jobs.set(key, { abort, promise });
	}

	async #runBatch(
		session: SessionKey,
		abortSignal: AbortSignal,
	): Promise<void> {
		const file = await this.#sessionStores.getSessionFile(
			session.workspaceRoot,
			session.sessionId,
		);
		const learning = file.memoryLearning;
		if (learning?.pendingApply !== undefined) {
			const memory = await this.#resolveMemoryService(session.workspaceRoot);
			await withAutomaticTargetLocks(
				memory,
				learning.pendingApply.targets,
				async () => {
					await this.#applyReceipt(session, learning.pendingApply!, memory);
				},
			);
			return;
		}
		if (learning?.eligibleThroughMessageId === undefined) return;
		const capturedProcessed = learning.processedThroughMessageId;
		const capturedEligible = learning.eligibleThroughMessageId;
		this.#lastAttemptedEligible.set(
			this.#key(session.workspaceRoot, session.sessionId),
			capturedEligible,
		);
		// Opt-out may durably advance through an admitted user message before its
		// Execution finishes. Its later assistant-only suffix is not a learnable
		// conversation window and is deterministically skipped.
		if (
			!windowContainsUserMessage(
				file.messages,
				capturedProcessed,
				capturedEligible,
			)
		) {
			await this.#advance(session, capturedProcessed, capturedEligible);
			return;
		}
		const claimed = this.#policyRuntime.claim();
		if (!claimed.policy.autoLearning) {
			await this.#skipSession(session);
			return;
		}

		let memory: MemoryService;
		try {
			memory = await this.#resolveMemoryService(session.workspaceRoot);
		} catch (error) {
			await this.#block(session, capturedProcessed, "read_failed");
			this.#logFailure(
				"memory.idle.service_resolve_failed",
				session.workspaceRoot,
				session.sessionId,
				error,
			);
			return;
		}
		let binding: ExecutionModelBinding;
		try {
			binding = this.#resolveFastBinding();
		} catch (error) {
			await this.#block(session, capturedProcessed, "llm_failed");
			this.#logFailure(
				"memory.idle.fast_binding_failed",
				session.workspaceRoot,
				session.sessionId,
				error,
			);
			return;
		}
		let manifest;
		try {
			manifest = await memory.readPromptManifest();
		} catch (error) {
			await this.#block(session, capturedProcessed, "read_failed");
			this.#logFailure(
				"memory.idle.manifest_read_failed",
				session.workspaceRoot,
				session.sessionId,
				error,
			);
			return;
		}
		let extractionInput;
		try {
			extractionInput = buildMemoryExtractionInput({
				messages: file.messages,
				executions: file.executions,
				processedThroughMessageId: capturedProcessed,
				eligibleThroughMessageId: capturedEligible,
				preferences: manifest.preferences?.content ?? null,
				index: manifest.index.availableForPrompt
					? manifest.index.content
					: null,
				contextLimitTokens: binding.modelInfo.limit.context,
			});
		} catch (error) {
			await this.#block(session, capturedProcessed, "schema_failed");
			this.#logFailure(
				"memory.idle.input_build_failed",
				session.workspaceRoot,
				session.sessionId,
				error,
			);
			return;
		}
		if (extractionInput.status === "blocked") {
			await this.#block(session, capturedProcessed, extractionInput.reason);
			return;
		}

		let extracted;
		try {
			extracted = await this.#runObject({
				model: binding.modelInfo.model,
				modelOptions: binding.options,
				system: extractionInput.system,
				prompt: extractionInput.prompt,
				schema: MemoryExtractionResultSchema,
				schemaName: "memory_candidates",
				schemaDescription: "Submit bounded durable Memory candidates",
				abortSignal,
				logger: this.#logger,
				redactSensitiveText: (text) =>
					binding.modelInfo.redactSensitiveText(text),
			});
		} catch (error) {
			if (abortSignal.aborted) return;
			await this.#block(
				session,
				capturedProcessed,
				error instanceof LlmSchemaValidationError
					? "schema_failed"
					: "llm_failed",
			);
			this.#logFailure(
				"memory.idle.extraction_failed",
				session.workspaceRoot,
				session.sessionId,
				error,
			);
			return;
		}

		const safeCandidates = filterUnsafeMemoryCandidates(extracted.candidates);
		const deduped = removeAlreadySavedCandidates(
			safeCandidates,
			extractionInput.savedMarkers,
		);
		const candidates = deduped.candidates;
		if (candidates.length === 0) {
			await this.#advance(session, capturedProcessed, capturedEligible);
			return;
		}
		if (!validCandidateMetadata(candidates)) {
			await this.#block(session, capturedProcessed, "schema_failed");
			return;
		}

		const documentTargets = uniqueCandidateTargets(candidates);
		await withAutomaticTargetLocks(memory, documentTargets, async () => {
			let documents;
			try {
				documents = await memory.readDocuments(documentTargets);
			} catch (error) {
				await this.#block(session, capturedProcessed, "read_failed");
				this.#logFailure(
					"memory.idle.target_read_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}
			const reconciliationTargets = documents.map(
				(document): MemoryReconciliationTarget => {
					if (document.scope === "user") {
						return {
							scope: "user",
							name: "preferences",
							document: document.document ?? "",
							exists: document.document !== null,
						};
					}
					const parsed =
						document.document === null
							? undefined
							: parseFrontmatter(document.document);
					const metadata =
						parsed?.frontmatter ??
						projectCandidateMetadata(candidates, document.name);
					return {
						scope: "project",
						name: document.name,
						document: parsed?.body ?? "",
						rawDocument: document.document ?? "",
						exists: document.document !== null,
						topic: {
							title: metadata.name,
							description: metadata.description,
							type: metadata.type,
						},
					};
				},
			);
			let reconciliationInput;
			try {
				reconciliationInput = buildMemoryReconciliationInput({
					candidates,
					targets: reconciliationTargets,
					contextLimitTokens: binding.modelInfo.limit.context,
				});
			} catch (error) {
				await this.#block(session, capturedProcessed, "schema_failed");
				this.#logFailure(
					"memory.idle.reconciliation_input_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}
			if (reconciliationInput.status === "blocked") {
				await this.#block(
					session,
					capturedProcessed,
					reconciliationInput.reason,
				);
				return;
			}

			let reconciled;
			try {
				reconciled = await this.#runObject({
					model: binding.modelInfo.model,
					modelOptions: binding.options,
					system: reconciliationInput.system,
					prompt: reconciliationInput.prompt,
					schema: MemoryReconciliationResultSchema,
					schemaName: "memory_reconciliation",
					schemaDescription:
						"Submit exactly one safe operation for every touched Memory target",
					abortSignal,
					logger: this.#logger,
					redactSensitiveText: (text) =>
						binding.modelInfo.redactSensitiveText(text),
				});
			} catch (error) {
				if (abortSignal.aborted) return;
				await this.#block(
					session,
					capturedProcessed,
					error instanceof LlmSchemaValidationError
						? "schema_failed"
						: "llm_failed",
				);
				this.#logFailure(
					"memory.idle.reconciliation_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}

			let finalTargets: FinalTarget[];
			try {
				const bodies = applyMemoryReconciliation({
					candidates,
					targets: reconciliationTargets,
					operations: reconciled.operations,
				});
				finalTargets = documents.flatMap((document): FinalTarget[] => {
					const key = targetKey(document);
					const operation = reconciled.operations.find(
						(candidate) =>
							candidate.scope === document.scope &&
							candidate.target === document.name,
					);
					if (operation === undefined)
						throw new Error(`Missing reconciled operation ${key}`);
					// NOOP is absence of a durable mutation. In particular, do not
					// synthesize frontmatter (or an empty preferences file) for a
					// target that did not exist when reconciliation started.
					if (operation.action === "NOOP") return [];
					const body = bodies.get(key);
					if (body === undefined)
						throw new Error(`Missing reconciled target ${key}`);
					const finalDocument =
						document.scope === "user"
							? body
							: formatFrontmatter(
									document.document === null
										? projectCandidateMetadata(candidates, document.name)
										: parseFrontmatter(document.document).frontmatter,
									body,
								);
					if (finalDocument === document.document) return [];
					return [
						{
							scope: document.scope,
							name: document.name,
							expectedRevision: document.revision,
							finalDocument,
							finalRevision: memoryRevision(finalDocument),
						},
					];
				});
			} catch (error) {
				await this.#block(session, capturedProcessed, "schema_failed");
				this.#logFailure(
					"memory.idle.reconciliation_validation_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}

			const epoch = this.#policyRuntime.current;
			if (!epoch.policy.autoLearning || abortSignal.aborted) return;
			if (finalTargets.length === 0) {
				await this.#advance(session, capturedProcessed, capturedEligible);
				return;
			}

			let indexProjection;
			try {
				indexProjection = await memory.readIndexProjection();
				const capacityViolation = validateFinalCapacity(
					finalTargets,
					documents,
					indexProjection.topicCount.count,
				);
				if (capacityViolation !== undefined) {
					await this.#block(
						session,
						capturedProcessed,
						"capacity",
						capacityViolation.target,
					);
					return;
				}
			} catch (error) {
				await this.#block(session, capturedProcessed, "read_failed");
				this.#logFailure(
					"memory.idle.index_projection_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}

			let receipt: MemoryPendingApplyReceipt;
			try {
				const projectTargets = finalTargets.filter(
					(target) => target.scope === "project",
				);
				const finalIndex =
					projectTargets.length === 0
						? undefined
						: buildFinalIndex(
								parseIndex(indexProjection.content ?? ""),
								projectTargets,
								indexProjection.revision,
							);
				receipt = MemoryPendingApplyReceiptSchema.parse({
					id: this.#createId(),
					captured: {
						processedThroughMessageId: capturedProcessed,
						eligibleThroughMessageId: capturedEligible,
						policyEpoch: epoch.epoch,
					},
					targets: finalTargets.sort(compareFinalTargets),
					...(finalIndex === undefined ? {} : { index: finalIndex }),
					createdAt: this.#now(),
				});
			} catch (error) {
				await this.#block(session, capturedProcessed, "schema_failed");
				this.#logFailure(
					"memory.idle.receipt_validation_failed",
					session.workspaceRoot,
					session.sessionId,
					error,
				);
				return;
			}
			const persisted = await this.#persistReceipt(session, receipt);
			if (!persisted) return;
			await this.#applyReceipt(session, receipt, memory);
		});
	}

	#resolveFastBinding(): ExecutionModelBinding {
		return this.#modelSelectionResolver.resolve({
			snapshot: this.#modelRuntime.current,
			profile: "fast",
		});
	}

	async #persistReceipt(
		session: SessionKey,
		receipt: MemoryPendingApplyReceipt,
	): Promise<boolean> {
		const admission = await this.#policyRuntime.withApplyAdmission(
			receipt.captured.policyEpoch,
			async () =>
				await this.#sessionStores.commitDurableSessionMutation(
					session.sessionId,
					session.workspaceRoot,
					(state) => {
						const current = state.memoryLearning;
						if (
							current === undefined ||
							current.pendingApply !== undefined ||
							current.processedThroughMessageId !==
								receipt.captured.processedThroughMessageId
						) {
							return { result: false };
						}
						return {
							result: true,
							patch: {
								memoryLearning: {
									...current,
									blocked: undefined,
									pendingApply: receipt,
								},
							},
						};
					},
				),
		);
		return admission.status === "admitted" && admission.value;
	}

	async #applyReceipt(
		session: SessionKey,
		initialReceipt: MemoryPendingApplyReceipt,
		memory: MemoryService,
	): Promise<void> {
		let receipt = initialReceipt;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const currentPolicy = this.#policyRuntime.current;
			if (!currentPolicy.policy.autoLearning) {
				await this.#skipSession(session);
				return;
			}
			if (!sameEpoch(receipt.captured.policyEpoch, currentPolicy.epoch)) {
				receipt = await this.#rebindReceipt(session, receipt);
			}
			try {
				const admission = await this.#policyRuntime.withApplyAdmission(
					receipt.captured.policyEpoch,
					async () => {
						const result = await memory.applyFinalDocuments(
							receipt.targets,
							receipt.index,
						);
						if (
							receipt.index !== undefined &&
							result.indexRevision !== receipt.index.finalRevision
						) {
							throw new MemoryRevisionConflictError(
								"project index",
								receipt.index.finalRevision,
								result.indexRevision,
							);
						}
					},
				);
				if (admission.status === "stale") {
					if (!admission.snapshot.policy.autoLearning) {
						await this.#skipSession(session);
						return;
					}
					receipt = await this.#rebindReceipt(session, receipt);
					attempt -= 1;
					continue;
				}
				await this.#completeReceipt(session, receipt);
				return;
			} catch (error) {
				if (error instanceof MemoryRevisionConflictError) {
					await this.#discardConflictedReceipt(
						session,
						receipt,
						revisionConflictTarget(error.target),
					);
					return;
				}
				if (error instanceof MemoryCapacityError) {
					await this.#blockReceipt(
						session,
						receipt,
						"capacity",
						logicalTarget(receipt, error.target),
					);
					return;
				}
				if (
					error instanceof MemoryValidationError ||
					error instanceof MemorySecretError
				) {
					await this.#blockReceipt(session, receipt, "schema_failed");
					return;
				}
				if (attempt === 3) {
					await this.#blockReceipt(session, receipt, "apply_failed");
					this.#logFailure(
						"memory.idle.apply_failed",
						session.workspaceRoot,
						session.sessionId,
						error,
					);
					return;
				}
			}
		}
	}

	async #rebindReceipt(
		session: SessionKey,
		receipt: MemoryPendingApplyReceipt,
	): Promise<MemoryPendingApplyReceipt> {
		const epoch = this.#policyRuntime.current.epoch;
		return await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				const current = state.memoryLearning?.pendingApply;
				if (current?.id !== receipt.id) return { result: receipt };
				const rebound = MemoryPendingApplyReceiptSchema.parse({
					...current,
					captured: { ...current.captured, policyEpoch: epoch },
				});
				return {
					result: rebound,
					patch: {
						memoryLearning: { ...state.memoryLearning!, pendingApply: rebound },
					},
				};
			},
		);
	}

	async #completeReceipt(
		session: SessionKey,
		receipt: MemoryPendingApplyReceipt,
	): Promise<void> {
		await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				const current = state.memoryLearning;
				if (current?.pendingApply?.id !== receipt.id)
					return { result: undefined };
				return {
					result: undefined,
					patch: {
						memoryLearning: advancedLearningState(
							current,
							receipt.captured.eligibleThroughMessageId,
						),
					},
				};
			},
		);
	}

	async #advance(
		session: SessionKey,
		processed: string | null,
		eligible: string,
	): Promise<void> {
		await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				const current = state.memoryLearning;
				if (
					current === undefined ||
					current.pendingApply !== undefined ||
					current.processedThroughMessageId !== processed
				)
					return { result: undefined };
				return {
					result: undefined,
					patch: { memoryLearning: advancedLearningState(current, eligible) },
				};
			},
		);
	}

	async #block(
		session: SessionKey,
		processed: string | null,
		code: MemoryLearningBlockedCode,
		target?: MemoryDocumentTarget,
	): Promise<void> {
		await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				const current = state.memoryLearning;
				if (
					current === undefined ||
					current.pendingApply !== undefined ||
					current.processedThroughMessageId !== processed
				)
					return { result: undefined };
				return {
					result: undefined,
					patch: {
						memoryLearning: {
							...current,
							blocked: createBlocked(code, this.#now(), target),
						},
					},
				};
			},
		);
	}

	async #blockReceipt(
		session: SessionKey,
		receipt: MemoryPendingApplyReceipt,
		code: MemoryLearningBlockedCode,
		target?: MemoryDocumentTarget,
	): Promise<void> {
		await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				if (state.memoryLearning?.pendingApply?.id !== receipt.id)
					return { result: undefined };
				return {
					result: undefined,
					patch: {
						memoryLearning: {
							...state.memoryLearning,
							blocked: createBlocked(code, this.#now(), target),
						},
					},
				};
			},
		);
	}

	async #discardConflictedReceipt(
		session: SessionKey,
		receipt: MemoryPendingApplyReceipt,
		target?: MemoryDocumentTarget,
	): Promise<void> {
		await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				if (state.memoryLearning?.pendingApply?.id !== receipt.id) {
					return { result: undefined };
				}
				return {
					result: undefined,
					patch: {
						memoryLearning: {
							...state.memoryLearning,
							pendingApply: undefined,
							blocked: createBlocked(
								"revision_conflict",
								this.#now(),
								target,
							),
						},
					},
				};
			},
		);
	}

	async #blockUnexpected(session: SessionKey): Promise<void> {
		const file = await this.#sessionStores.getSessionFile(
			session.workspaceRoot,
			session.sessionId,
		);
		const learning = file.memoryLearning;
		if (learning === undefined) return;
		if (learning.pendingApply !== undefined) {
			await this.#blockReceipt(session, learning.pendingApply, "apply_failed");
			return;
		}
		if (learning.eligibleThroughMessageId !== undefined) {
			await this.#block(
				session,
				learning.processedThroughMessageId,
				"read_failed",
			);
		}
	}

	async #retrySessionsForTarget(
		workspaceRoot: string,
		target: MemoryDocumentTarget,
	): Promise<void> {
		const summaries =
			await this.#sessionStores.listAllSessionSummaries(workspaceRoot);
		for (const summary of summaries) {
			if (
				summary.parentSessionId !== undefined ||
				summary.rootSessionId !== summary.sessionId
			)
				continue;
			const session = { workspaceRoot, sessionId: summary.sessionId };
			const activeJob = this.#jobs.get(
				this.#key(workspaceRoot, summary.sessionId),
			)?.promise;
			let shouldRetry = await this.#clearRetryableTargetState(session, target);
			if (!shouldRetry && activeJob !== undefined) {
				// A manual/API mutation can notify after reconciliation completes but
				// before its receipt is durable. Recheck once after that admitted batch
				// settles so the notification can clear the resulting conflict instead
				// of being lost until process restart.
				await activeJob;
				if (this.#closed) return;
				shouldRetry = await this.#clearRetryableTargetState(session, target);
			}
			if (shouldRetry && this.#policyRuntime.current.policy.autoLearning) {
				this.#launch(session);
			}
		}
	}

	async #clearRetryableTargetState(
		session: SessionKey,
		target: MemoryDocumentTarget,
	): Promise<boolean> {
		return await this.#sessionStores.commitDurableSessionMutation(
			session.sessionId,
			session.workspaceRoot,
			(state) => {
				const learning = state.memoryLearning;
				if (learning === undefined) return { result: false };
				const receiptMatches =
					learning.pendingApply?.targets.some((candidate) =>
						sameTarget(candidate, target),
					) === true;
				const warningMatches =
					learning.blocked !== undefined &&
					isMemoryChangeRetryableWarning(learning.blocked.code) &&
					(learning.blocked.target === undefined ||
						sameTarget(learning.blocked.target, target));
				if (!receiptMatches && !warningMatches) return { result: false };
				return {
					result: true,
					patch: {
						memoryLearning: {
							...learning,
							pendingApply: undefined,
							blocked: undefined,
						},
					},
				};
			},
		);
	}

	#cancelTimer(key: string): void {
		const timer = this.#timers.get(key);
		if (timer === undefined) return;
		this.#timers.delete(key);
		this.#clearTimer(timer);
	}

	#key(workspaceRoot: string, sessionId: string): string {
		return `${workspaceRoot}\0${sessionId}`;
	}

	#logFailure(
		event: string,
		workspaceRoot: string,
		sessionId: string | undefined,
		error: unknown,
	): void {
		void workspaceRoot;
		this.#logger.warn(event, {
			context: {
				...(sessionId === undefined ? {} : { sessionId }),
				errorKind: safeErrorKind(error),
			},
		});
	}
}

function isEligibleRoot(file: {
	readonly sessionId: string;
	readonly rootSessionId: string;
	readonly parentSessionId?: string;
	readonly agentName: string;
	readonly source?: { readonly kind: string };
}): boolean {
	return (
		file.parentSessionId === undefined &&
		file.rootSessionId === file.sessionId &&
		(file.agentName === "lead" || file.agentName === "discussion") &&
		file.source?.kind !== "automation"
	);
}

function windowContainsUserMessage(
	messages: readonly { readonly id: string; readonly role: string }[],
	processed: string | null,
	eligible: string,
): boolean {
	const start =
		processed === null
			? 0
			: messages.findIndex((message) => message.id === processed) + 1;
	const end = messages.findIndex((message) => message.id === eligible);
	return (
		start >= 0 &&
		end >= start &&
		messages.slice(start, end + 1).some((message) => message.role === "user")
	);
}

function uniqueCandidateTargets(
	candidates: readonly MemoryExtractionCandidate[],
): MemoryDocumentTarget[] {
	const targets = new Map<string, MemoryDocumentTarget>();
	for (const candidate of candidates) {
		const target = { scope: candidate.scope, name: candidate.target } as const;
		targets.set(targetKey(target), target);
	}
	return [...targets.values()].sort((left, right) =>
		targetKey(left).localeCompare(targetKey(right)),
	);
}

function validCandidateMetadata(
	candidates: readonly MemoryExtractionCandidate[],
): boolean {
	const metadata = new Map<string, string>();
	for (const candidate of candidates) {
		if (candidate.scope !== "project") continue;
		const key = `${candidate.title}\0${candidate.description}\0${candidate.type}`;
		const previous = metadata.get(candidate.target);
		if (previous !== undefined && previous !== key) return false;
		metadata.set(candidate.target, key);
	}
	return true;
}

function projectCandidateMetadata(
	candidates: readonly MemoryExtractionCandidate[],
	target: string,
) {
	const candidate = candidates.find(
		(entry) => entry.scope === "project" && entry.target === target,
	);
	if (candidate?.scope !== "project")
		throw new Error(`Missing project metadata for ${target}`);
	return {
		name: candidate.title,
		description: candidate.description,
		type: candidate.type,
	};
}

function validateFinalCapacity(
	targets: readonly FinalTarget[],
	snapshots: readonly {
		readonly scope: "user" | "project";
		readonly name: string;
		readonly document: string | null;
	}[],
	topicCount: number,
): { readonly target?: MemoryDocumentTarget } | undefined {
	const currentByKey = new Map(
		snapshots.map((snapshot) => [targetKey(snapshot), snapshot.document]),
	);
	let newTopics = 0;
	for (const target of targets) {
		const current = currentByKey.get(targetKey(target)) ?? null;
		const currentBytes = utf8ByteLength(current ?? "");
		const finalBytes = utf8ByteLength(target.finalDocument);
		const limit =
			target.scope === "user"
				? DEFAULT_MAX_PREFERENCES_BYTES
				: MAX_MEMORY_TOPIC_BYTES;
		if (
			finalBytes > limit &&
			!(currentBytes > limit && finalBytes <= currentBytes)
		) {
			return { target: { scope: target.scope, name: target.name } };
		}
		if (target.scope === "project" && current === null) newTopics += 1;
	}
	if (topicCount + newTopics > MAX_MEMORY_TOPICS) {
		// Topic-count capacity is a project-wide condition. Any project Memory
		// mutation can free capacity, so do not pin the warning to the attempted
		// new topic.
		return {};
	}
	return undefined;
}

function buildFinalIndex(
	topics: readonly {
		readonly name: string;
		readonly title: string;
		readonly summary: string;
	}[],
	finalTargets: readonly FinalTarget[],
	expectedRevision: string | null,
) {
	const entries = new Map(
		topics.map((topic) => [
			topic.name,
			{
				name: topic.name,
				title: topic.title,
				summary: topic.summary,
			},
		]),
	);
	for (const target of finalTargets) {
		const parsed = parseFrontmatter(target.finalDocument);
		entries.set(target.name, {
			name: target.name,
			title: parsed.frontmatter.name,
			summary: parsed.frontmatter.description,
		});
	}
	const finalDocument = formatIndex(
		[...entries.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
	);
	return {
		expectedRevision,
		finalDocument,
		finalRevision: memoryRevision(finalDocument),
	};
}

function advancedLearningState(
	current: MemoryLearningState,
	through: string,
): MemoryLearningState {
	const hasLaterWindow =
		current.eligibleThroughMessageId !== undefined &&
		current.eligibleThroughMessageId !== through;
	return {
		processedThroughMessageId: through,
		...(hasLaterWindow
			? {
					eligibleThroughMessageId: current.eligibleThroughMessageId,
					...(current.idleSince === undefined
						? {}
						: { idleSince: current.idleSince }),
				}
			: {}),
	};
}

function createBlocked(
	code: MemoryLearningBlockedCode,
	blockedAt: number,
	target?: MemoryDocumentTarget,
): MemoryLearningBlocked {
	return { code, blockedAt, ...(target === undefined ? {} : { target }) };
}

function revisionConflictTarget(
	target: string,
): MemoryDocumentTarget | undefined {
	if (target === "project:index") return undefined;
	const separator = target.indexOf(":");
	if (separator < 0) return undefined;
	const scope = target.slice(0, separator);
	const name = target.slice(separator + 1);
	if ((scope !== "user" && scope !== "project") || name.length === 0) {
		return undefined;
	}
	return { scope, name };
}

function compareFinalTargets(left: FinalTarget, right: FinalTarget): number {
	return targetKey(left).localeCompare(targetKey(right));
}

async function withAutomaticTargetLocks<T>(
	memory: MemoryService,
	targets: readonly MemoryDocumentTarget[],
	operation: () => Promise<T>,
): Promise<T> {
	const keys = new Set(
		targets.map((target) => automaticTargetLockKey(memory, target)),
	);
	if (targets.some((target) => target.scope === "project")) {
		keys.add(`${memory.projectRoot}\0project\0index`);
	}
	const orderedKeys = [...keys].sort();

	const acquire = async (index: number): Promise<T> => {
		const key = orderedKeys[index];
		if (key === undefined) return await operation();
		return await automaticTargetQueue.enqueue(key, () => acquire(index + 1));
	};
	return await acquire(0);
}

function automaticTargetLockKey(
	memory: MemoryService,
	target: MemoryDocumentTarget,
): string {
	const root = target.scope === "user" ? memory.userRoot : memory.projectRoot;
	return `${root}\0${target.scope}\0${target.name}`;
}

function targetKey(target: {
	readonly scope: string;
	readonly name: string;
}): string {
	return `${target.scope}\0${target.name}`;
}

function sameTarget(
	left: { readonly scope: string; readonly name: string },
	right: { readonly scope: string; readonly name: string },
): boolean {
	return left.scope === right.scope && left.name === right.name;
}

function sameEpoch(left: MemoryPolicyEpoch, right: MemoryPolicyEpoch): boolean {
	return left.bootId === right.bootId && left.generation === right.generation;
}

function logicalTarget(
	receipt: MemoryPendingApplyReceipt,
	label: string,
): MemoryDocumentTarget | undefined {
	return receipt.targets.find((target) => label.includes(target.name));
}

function warningMessage(code: MemoryLearningBlockedCode): string {
	switch (code) {
		case "input_budget":
			return "Memory learning input exceeds the fast model safety budget.";
		case "reconciliation_budget":
			return "Selected complete Memory files exceed the reconciliation budget.";
		case "capacity":
			return "Memory learning is blocked by a storage capacity limit.";
		case "revision_conflict":
			return "Memory changed before the pending learning result could be applied.";
		case "read_failed":
			return "Memory learning could not read its bounded source files.";
		case "llm_failed":
			return "The fast model could not complete Memory learning.";
		case "schema_failed":
			return "The fast model returned an invalid Memory learning result.";
		case "apply_failed":
			return "A durable Memory learning result could not be applied after three attempts.";
	}
}

function isMemoryChangeRetryableWarning(
	code: MemoryLearningBlockedCode,
): boolean {
	return (
		code === "input_budget" ||
		code === "reconciliation_budget" ||
		code === "capacity" ||
		code === "revision_conflict"
	);
}

function safeErrorKind(error: unknown): string {
	if (error instanceof LlmSchemaValidationError)
		return "LlmSchemaValidationError";
	if (error instanceof MemoryRevisionConflictError)
		return "MemoryRevisionConflictError";
	if (error instanceof MemoryCapacityError) return "MemoryCapacityError";
	if (error instanceof MemoryValidationError) return "MemoryValidationError";
	if (error instanceof MemorySecretError) return "MemorySecretError";
	return error instanceof Error ? "Error" : "NonError";
}
