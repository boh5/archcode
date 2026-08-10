import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	SessionExecutionRecord,
	SessionMessage,
	ToolPart,
} from "@archcode/protocol";
import { createEmptySessionStats } from "@archcode/protocol";

import { MemoryPolicyRuntime } from "./policy-runtime";
import { MemoryIdleCoordinator } from "./idle-coordinator";
import { MAX_MEMORY_TOPICS } from "./constants";
import { MemoryFileManager } from "./file-manager";
import { MemoryRevisionConflictError } from "./errors";
import {
	MEMORY_IDLE_DELAY_MS,
	type MemoryPendingApplyReceipt,
} from "./learning-state";
import {
	MemoryService,
	memoryRevision,
	type MemoryDocumentTarget,
} from "./service";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import type { ModelRuntime } from "../models";
import { createInMemoryLogger, silentLogger, type Logger } from "../logger";
import { SkillService } from "../skills";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext } from "../tools/types";
import { ToolOutputArtifactStore } from "../tool-output/artifact-store";
import { ToolOutputFinalizer } from "../tool-output/finalizer";
import { LlmSchemaValidationError } from "../llm";

const WORKSPACE = "/workspace";
const SESSION = "00000000-0000-4000-8000-000000000001";
const SECOND_SESSION = "00000000-0000-4000-8000-000000000002";

class FakeClock {
	now = 0;
	#nextId = 1;
	readonly timers = new Map<number, { at: number; callback: () => void }>();

	setTimer = (callback: () => void, delayMs: number) => {
		const id = this.#nextId++;
		this.timers.set(id, { at: this.now + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (handle: ReturnType<typeof setTimeout>) => {
		this.timers.delete(handle as unknown as number);
	};

	advance(ms: number): void {
		this.now += ms;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.now)
				.sort(
					(left, right) => left[1].at - right[1].at || left[0] - right[0],
				)[0];
			if (due === undefined) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

class FakeSessionStores {
	file: any = rootFile();
	listener: ((event: any) => void) | undefined;
	beforePatchCommit:
		| ((patch: Partial<SessionStoreState> | undefined) => Promise<void>)
		| undefined;

	subscribeToSessionEvents(listener: (event: any) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	emit(type: "session.message_accepted" | "execution-end"): void {
		this.listener?.({
			workspaceRoot: WORKSPACE,
			sessionId: SESSION,
			agentName: "lead",
			envelope: { payload: { type } },
		});
	}

	async listAllSessionSummaries(): Promise<any[]> {
		return [
			{
				sessionId: SESSION,
				rootSessionId: SESSION,
				agentName: "lead",
				source: { kind: "user" },
			},
		];
	}

	async getSessionFile(): Promise<any> {
		return structuredClone(this.file);
	}

	async commitDurableSessionMutation<T>(
		_sessionId: string,
		_workspaceRoot: string,
		mutate: (state: Readonly<SessionStoreState>) => {
			result: T;
			patch?: Partial<SessionStoreState>;
		},
	): Promise<T> {
		const outcome = mutate(this.file as unknown as SessionStoreState);
		await this.beforePatchCommit?.(outcome.patch);
		if (outcome.patch !== undefined)
			Object.assign(this.file, structuredClone(outcome.patch));
		return outcome.result;
	}
}

interface VoidDeferred {
	readonly promise: Promise<void>;
	readonly resolve: (value: void | PromiseLike<void>) => void;
}

class TwoSessionStores extends FakeSessionStores {
	readonly files = new Map<string, any>();
	#blockedCommit:
		| {
				sessionId: string;
				claimed: boolean;
				started: VoidDeferred;
				release: VoidDeferred;
			}
		| undefined;

	constructor() {
		super();
		this.files.set(SESSION, this.file);
		const second = structuredClone(this.file);
		second.sessionId = SECOND_SESSION;
		second.rootSessionId = SECOND_SESSION;
		this.files.set(SECOND_SESSION, second);
	}

	emitFor(
		sessionId: string,
		type: "session.message_accepted" | "execution-end",
	): void {
		this.listener?.({
			workspaceRoot: WORKSPACE,
			sessionId,
			agentName: "lead",
			envelope: { payload: { type } },
		});
	}

	deferNextCommit(sessionId: string): {
		started: Promise<void>;
		release: () => void;
	} {
		const started = deferred();
		const release = deferred();
		this.#blockedCommit = {
			sessionId,
			claimed: false,
			started,
			release,
		};
		return {
			started: started.promise,
			release: () => release.resolve(undefined),
		};
	}

	override async listAllSessionSummaries(): Promise<any[]> {
		return [SESSION, SECOND_SESSION].map((sessionId) => ({
			sessionId,
			rootSessionId: sessionId,
			agentName: "lead",
			source: { kind: "user" },
		}));
	}

	override async getSessionFile(
		_workspaceRoot?: string,
		sessionId: string = SESSION,
	): Promise<any> {
		return structuredClone(this.files.get(sessionId));
	}

	override async commitDurableSessionMutation<T>(
		sessionId: string,
		_workspaceRoot: string,
		mutate: (state: Readonly<SessionStoreState>) => {
			result: T;
			patch?: Partial<SessionStoreState>;
		},
	): Promise<T> {
		const blocked = this.#blockedCommit;
		if (
			blocked !== undefined &&
			blocked.sessionId === sessionId &&
			!blocked.claimed
		) {
			blocked.claimed = true;
			blocked.started.resolve(undefined);
			await blocked.release.promise;
			this.#blockedCommit = undefined;
		}
		const file = this.files.get(sessionId);
		if (file === undefined) throw new Error(`Unknown Session ${sessionId}`);
		const outcome = mutate(file as unknown as SessionStoreState);
		await this.beforePatchCommit?.(outcome.patch);
		if (outcome.patch !== undefined)
			Object.assign(file, structuredClone(outcome.patch));
		return outcome.result;
	}
}

function rootFile() {
	const messages = conversation();
	return {
		sessionId: SESSION,
		rootSessionId: SESSION,
		agentName: "lead",
		source: { kind: "user" },
		messages,
		pendingMessages: [],
		executions: [execution("execution-1")],
		memoryLearning: {
			processedThroughMessageId: null,
			eligibleThroughMessageId: "assistant-1",
			idleSince: 0,
		},
	};
}

function conversation(): SessionMessage[] {
	return [
		{
			id: "user-1",
			role: "user",
			executionId: "execution-1",
			parts: [
				{
					type: "text",
					id: "user-text",
					text: "Keep answers concise.",
					createdAt: 0,
					completedAt: 0,
				},
			],
			createdAt: 0,
			completedAt: 0,
		},
		{
			id: "assistant-1",
			role: "assistant",
			executionId: "execution-1",
			runOrdinal: 0,
			stepId: "final-step",
			outputPhase: "final_answer",
			parts: [
				{
					type: "assistant-output",
					id: "assistant-output",
					blockId: "output",
					text: "I will keep answers concise.",
					createdAt: 0,
					completedAt: 0,
				},
			],
			createdAt: 0,
			completedAt: 0,
		},
	];
}

function execution(id: string): SessionExecutionRecord {
	const binding = {
		selection: { model: "test:model" },
		providerId: "test",
		modelId: "model",
		providerDisplayName: "Test",
		modelDisplayName: "Model",
		resolution: "profile_default" as const,
		modelRuntimeRevision: "runtime-1",
	};
	return {
		id,
		startedAt: 1,
		endedAt: 2,
		status: "completed",
		executionSkills: [],
		memoryPolicy: {
			policy: { useMemory: true, autoLearning: true },
			epoch: { bootId: "boot-test", generation: 0 },
		},
		origin: "user_message",
		maxSteps: 50,
		durationMs: 1,
		finalOutputStepId: "final-step",
		runs: [
			{
				ordinal: 0,
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
				binding,
				usageDelta: {
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					reasoningTokens: 0,
					cachedInputTokens: 0,
				},
				settlement: { key: `run:${id}:0`, goalInstanceId: null },
			},
		],
		terminalSettlement: { key: `terminal:${id}`, goalInstanceId: null },
	};
}

function appendCompletedConversation(
	stores: { file: any },
	suffix: string,
	at: number,
): string {
	const executionId = `execution-${suffix}`;
	const userId = `user-${suffix}`;
	const assistantId = `assistant-${suffix}`;
	stores.file.messages.push(
		{
			id: userId,
			role: "user",
			executionId,
			parts: [
				{
					type: "text",
					id: `user-text-${suffix}`,
					text: "Also prefer examples.",
					createdAt: at,
					completedAt: at,
				},
			],
			createdAt: at,
			completedAt: at,
		},
		{
			id: assistantId,
			role: "assistant",
			executionId,
			runOrdinal: 0,
			stepId: "final-step",
			outputPhase: "final_answer",
			parts: [
				{
					type: "assistant-output",
					id: `assistant-output-${suffix}`,
					blockId: `output-${suffix}`,
					text: "I will include examples.",
					createdAt: at,
					completedAt: at,
				},
			],
			createdAt: at,
			completedAt: at,
		},
	);
	stores.file.executions.push(execution(executionId));
	stores.file.memoryLearning = {
		processedThroughMessageId:
			stores.file.memoryLearning.processedThroughMessageId,
		eligibleThroughMessageId: assistantId,
		idleSince: at,
	};
	return assistantId;
}

function binding() {
	return {
		modelInfo: {
			model: {},
			limit: { context: 100_000, output: 10_000 },
			redactSensitiveText: (text: string) => text,
		},
		options: undefined,
		summary: {},
	};
}

function memory(
	overrides: Partial<Record<keyof MemoryService, any>> = {},
): MemoryService {
	return {
		projectRoot: "/memory/project",
		userRoot: "/memory/user",
		readPromptManifest: async () => ({
			preferences: null,
			index: {
				content: null,
				revision: null,
				topicCount: {
					count: 0,
					max: 200,
					state: "within-limit",
					canCreate: true,
				},
				availableForPrompt: true,
			},
		}),
		readDocuments: async (targets: any[]) =>
			targets.map((target) => ({ ...target, document: null, revision: null })),
		readIndexProjection: async () => ({
			content: null,
			revision: null,
			topicCount: {
				count: 0,
				max: 200,
				state: "within-limit",
				canCreate: true,
			},
			availableForPrompt: true,
		}),
		snapshot: async () => ({
			preferences: null,
			topics: [],
			index: {
				revision: null,
				bytes: 0,
				topicCount: {
					count: 0,
					max: 200,
					state: "within-limit",
					canCreate: true,
				},
				availableForPrompt: true,
			},
			warnings: [],
		}),
		applyFinalDocuments: async () => ({
			applied: 1,
			alreadyApplied: 0,
			indexRevision: null,
		}),
		...overrides,
	} as unknown as MemoryService;
}

function coordinator(input: {
	stores: FakeSessionStores;
	clock: FakeClock;
	policy?: MemoryPolicyRuntime;
	service?: MemoryService;
	runObject?: (input: any) => Promise<any>;
	logger?: Logger;
}) {
	const policy =
		input.policy ??
		new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"boot-test",
		);
	const instance = new MemoryIdleCoordinator({
		sessionStores: input.stores as unknown as SessionStoreManager,
		policyRuntime: policy,
		modelRuntime: { current: {} } as ModelRuntime,
		modelSelectionResolver: { resolve: () => binding() } as any,
		resolveMemoryService: async () => input.service ?? memory(),
		runObject: (input.runObject ?? (async () => ({ candidates: [] }))) as any,
		logger: input.logger,
		now: () => input.clock.now,
		createId: () => "receipt-1",
		setTimer: input.clock.setTimer,
		clearTimer: input.clock.clearTimer,
	});
	return { instance, policy };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 64; index += 1) await Promise.resolve();
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

type CrashPoint =
	| "after_receipt_persisted"
	| "after_first_target_written"
	| "after_all_memory_written";

interface PersistenceCounters {
	cursorAdvances: number;
}

class InstrumentedSessionStores {
	#crashed = false;

	constructor(
		readonly inner: SessionStoreManager,
		readonly crashPoint: CrashPoint | undefined,
		readonly counters: PersistenceCounters,
	) {}

	subscribeToSessionEvents(
		listener: Parameters<SessionStoreManager["subscribeToSessionEvents"]>[0],
	): () => void {
		return this.inner.subscribeToSessionEvents(listener);
	}

	async listAllSessionSummaries(workspaceRoot: string) {
		return await this.inner.listAllSessionSummaries(workspaceRoot);
	}

	async getSessionFile(workspaceRoot: string, sessionId: string) {
		return await this.inner.getSessionFile(workspaceRoot, sessionId);
	}

	async commitDurableSessionMutation<T>(
		sessionId: string,
		workspaceRoot: string,
		mutate: Parameters<SessionStoreManager["commitDurableSessionMutation"]>[2],
	): Promise<T> {
		let crashAfterCommit = false;
		let advancesCursor = false;
		const result = await this.inner.commitDurableSessionMutation(
			sessionId,
			workspaceRoot,
			(state) => {
				const outcome = mutate(state) as {
					result: T;
					patch?: Partial<SessionStoreState>;
				};
				const current = state.memoryLearning;
				const next = outcome.patch?.memoryLearning;
				advancesCursor =
					next !== undefined &&
					next.processedThroughMessageId !==
						current?.processedThroughMessageId;
				if (
					this.crashPoint === "after_all_memory_written" &&
					current?.pendingApply !== undefined &&
					next?.pendingApply === undefined &&
					advancesCursor
				) {
					this.#crashed = true;
					throw new Error("simulated crash before cursor persistence");
				}
				if (
					!this.#crashed &&
					this.crashPoint === "after_receipt_persisted" &&
					current?.pendingApply === undefined &&
					next?.pendingApply !== undefined
				) {
					crashAfterCommit = true;
				}
				return outcome;
			},
		);
		if (advancesCursor) this.counters.cursorAdvances += 1;
		if (crashAfterCommit) {
			this.#crashed = true;
			throw new Error("simulated crash after receipt persistence");
		}
		return result as T;
	}
}

class CrashAfterFirstTargetFileManager extends MemoryFileManager {
	#firstTargetWritten = false;

	override async writeTopicDocument(
		name: string,
		document: string,
	): Promise<void> {
		if (!this.#firstTargetWritten) {
			await super.writeTopicDocument(name, document);
			this.#firstTargetWritten = true;
			throw new Error("simulated crash after first target write");
		}
		throw new Error("simulated process remains unavailable");
	}

	override async writePreferences(content: string): Promise<void> {
		if (this.#firstTargetWritten)
			throw new Error("simulated process remains unavailable");
		await super.writePreferences(content);
	}
}

class ObservedMemoryService extends MemoryService {
	constructor(
		files: MemoryFileManager,
		readonly onRead?: (
			targets: readonly MemoryDocumentTarget[],
			revisions: readonly (string | null)[],
		) => void,
	) {
		super(files);
	}

	override async readDocuments(targets: readonly MemoryDocumentTarget[]) {
		const documents = await super.readDocuments(targets);
		this.onRead?.(
			targets,
			documents.map((document) => document.revision),
		);
		return documents;
	}
}

class ApplyObservedMemoryService extends MemoryService {
	applyCalls = 0;

	override async applyFinalDocuments(
		...args: Parameters<MemoryService["applyFinalDocuments"]>
	) {
		this.applyCalls += 1;
		return await super.applyFinalDocuments(...args);
	}
}

async function createPersistentLearningSession(
	manager: SessionStoreManager,
	workspaceRoot: string,
	sessionId = SESSION,
): Promise<void> {
	await manager.createSessionFile(
		workspaceRoot,
		{ agentName: "lead", source: { kind: "direct" } },
		sessionId,
	);
	const store = await manager.getOrLoad(sessionId, workspaceRoot);
	const executionId = "execution-1";
	const pendingId = "user-1";
	store.getState().append({
		type: "session.message_accepted",
		message: {
			id: pendingId,
			clientRequestId: "request-1",
			content: "Keep answers concise.",
			attachments: [],
			executionSkillNames: [],
			source: "user",
			state: "queued",
			revision: 0,
			acceptedAt: 0,
			updatedAt: 0,
			requestedModelSelection: {
				mode: "profile_default",
				selection: { model: "test:model" },
			},
		},
	});
	store.getState().append({
		type: "execution-start",
		executionId,
		binding: execution(executionId).runs[0]!.binding,
		executionSkills: [],
		memoryPolicy: {
			policy: { useMemory: true, autoLearning: true },
			epoch: { bootId: "fixture-boot", generation: 0 },
		},
		origin: "user_message",
		maxSteps: 50,
	});
	store.getState().append({
		type: "session.messages_committed",
		executionId,
		messages: [
			{
				id: pendingId,
				role: "user",
				executionId,
				runOrdinal: 0,
				clientRequestId: "request-1",
				modelAudit: {
					requested: {
						mode: "profile_default",
						selection: { model: "test:model" },
					},
					actual: { model: "test:model" },
				},
				parts: [
					{
						type: "text",
						id: "user-text",
						text: "Keep answers concise.",
						createdAt: 0,
						completedAt: 0,
					},
				],
				createdAt: 0,
				completedAt: 0,
			},
		],
	});
	store.getState().append({
		type: "step-start",
		stepId: "final-step",
		step: 0,
	});
	store.getState().append({
		type: "text-start",
		stepId: "final-step",
		blockId: "output",
	});
	store.getState().append({
		type: "text-delta",
		stepId: "final-step",
		blockId: "output",
		text: "I will keep answers concise.",
	});
	store.getState().append({
		type: "text-end",
		stepId: "final-step",
		blockId: "output",
	});
	store.getState().append({
		type: "step-end",
		stepId: "final-step",
		step: 0,
		finishReason: "stop",
	});
	const running = store
		.getState()
		.executions.find((candidate) => candidate.id === executionId);
	if (running === undefined || running.status !== "running")
		throw new Error("Expected running fixture Execution");
	const run = running.runs.at(-1)!;
	const endedAt = Math.max(Date.now(), run.startedAt);
	store.getState().append({
		type: "execution-end",
		executionId,
		terminalStatus: "completed",
		finalOutputStepId: "final-step",
		endedAt,
		runEndedAt: endedAt,
		runUsageDelta: createEmptySessionStats().usage,
		runSettlement: {
			key: `run:${sessionId}:${executionId}:0`,
			goalInstanceId: null,
		},
		terminalSettlement: {
			key: `terminal:${sessionId}:${executionId}`,
			goalInstanceId: null,
		},
	});
	await manager.commitDurableSessionMutation(
		sessionId,
		workspaceRoot,
		(state) => ({
			result: undefined,
			patch: {
				memoryLearning: { ...state.memoryLearning!, idleSince: 0 },
			},
		}),
	);
}

function createPersistentCoordinator(input: {
	stores: InstrumentedSessionStores;
	clock: FakeClock;
	policy: MemoryPolicyRuntime;
	resolveMemoryService: (workspaceRoot: string) => Promise<MemoryService>;
	runObject: (input: any) => Promise<any>;
}) {
	return new MemoryIdleCoordinator({
		sessionStores: input.stores as unknown as SessionStoreManager,
		policyRuntime: input.policy,
		modelRuntime: { current: {} } as ModelRuntime,
		modelSelectionResolver: { resolve: () => binding() } as any,
		resolveMemoryService: input.resolveMemoryService,
		runObject: input.runObject as any,
		now: () => input.clock.now,
		createId: () => "acceptance-receipt",
		setTimer: input.clock.setTimer,
		clearTimer: input.clock.clearTimer,
	});
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

function countOccurrences(value: string, expected: string): number {
	return value.split(expected).length - 1;
}

async function runCrashRestartFixture(crashPoint: CrashPoint): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "archcode-memory-restart-"));
	try {
		const workspaceRoot = join(root, "workspace");
		const projectRoot = join(root, "project-memory");
		const userRoot = join(root, "user-memory");
		await mkdir(workspaceRoot, { recursive: true });
		const counters: PersistenceCounters = { cursorAdvances: 0 };
		let llmCalls = 0;
		const runObject = async (input: any) => {
			llmCalls += 1;
			if (input.schemaName === "memory_candidates") {
				return {
					candidates: [
						{
							scope: "project",
							target: "build_tools",
							title: "Build Tools",
							description: "Stable build conventions",
							type: "project",
							content: "Use Bun for workspace commands.",
							basis: "explicit",
							intent: "add",
						},
						{
							scope: "user",
							target: "preferences",
							content: "Prefer concise answers.",
							basis: "explicit",
							intent: "add",
						},
					],
				};
			}
			return {
				operations: [
					{
						scope: "project",
						target: "build_tools",
						action: "ADD",
						content: "Use Bun for workspace commands.",
					},
					{
						scope: "user",
						target: "preferences",
						action: "ADD",
						content: "Prefer concise answers.",
					},
				],
			};
		};

		const initialManager = new SessionStoreManager({ logger: silentLogger });
		await createPersistentLearningSession(initialManager, workspaceRoot);
		const initialStores = new InstrumentedSessionStores(
			initialManager,
			crashPoint,
			counters,
		);
		const initialFiles =
			crashPoint === "after_first_target_written"
				? new CrashAfterFirstTargetFileManager({
						project: projectRoot,
						user: userRoot,
					})
				: new MemoryFileManager({ project: projectRoot, user: userRoot });
		const initialService = new MemoryService(initialFiles);
		const initialClock = new FakeClock();
		initialClock.now = MEMORY_IDLE_DELAY_MS;
		const initial = createPersistentCoordinator({
			stores: initialStores,
			clock: initialClock,
			policy: new MemoryPolicyRuntime(
				{ useMemory: true, autoLearning: true },
				"initial-boot",
			),
			resolveMemoryService: async () => initialService,
			runObject,
		});
		await initial.recoverWorkspace(workspaceRoot);
		initialClock.advance(0);
		await waitUntil(async () => {
			const file = await initialManager.getSessionFile(workspaceRoot, SESSION);
			return (
				file.memoryLearning?.pendingApply !== undefined &&
				file.memoryLearning.blocked?.code === "apply_failed"
			);
		}, `${crashPoint} durable crash checkpoint`);
		await initial.shutdown();

		const crashed = await initialManager.getSessionFile(workspaceRoot, SESSION);
		expect(crashed.memoryLearning?.processedThroughMessageId).toBeNull();
		expect(crashed.memoryLearning?.pendingApply?.targets).toHaveLength(2);
		const capturedEligible =
			crashed.memoryLearning!.pendingApply!.captured.eligibleThroughMessageId;
		expect(llmCalls).toBe(2);
		const crashedDisk = new MemoryService(
			new MemoryFileManager({ project: projectRoot, user: userRoot }),
		);
		if (crashPoint === "after_receipt_persisted") {
			expect(await crashedDisk.readPreferences()).toBeNull();
			expect(await crashedDisk.readTopic("build_tools")).toBeNull();
		} else if (crashPoint === "after_first_target_written") {
			expect(await crashedDisk.readPreferences()).toBeNull();
			expect(
				(await crashedDisk.readTopic("build_tools"))?.content,
			).toBe("Use Bun for workspace commands.");
			expect(await crashedDisk.readIndex()).toBeNull();
		} else {
			expect((await crashedDisk.readPreferences())?.content).toBe(
				"Prefer concise answers.",
			);
			expect(
				(await crashedDisk.readTopic("build_tools"))?.content,
			).toBe("Use Bun for workspace commands.");
			expect(await crashedDisk.readIndex()).toContain("build_tools");
		}

		const restartedManager = new SessionStoreManager({ logger: silentLogger });
		const restartedStores = new InstrumentedSessionStores(
			restartedManager,
			undefined,
			counters,
		);
		const restartedService = new MemoryService(
			new MemoryFileManager({ project: projectRoot, user: userRoot }),
		);
		const restartedClock = new FakeClock();
		restartedClock.now = MEMORY_IDLE_DELAY_MS;
		const restarted = createPersistentCoordinator({
			stores: restartedStores,
			clock: restartedClock,
			policy: new MemoryPolicyRuntime(
				{ useMemory: true, autoLearning: true },
				"restarted-boot",
			),
			resolveMemoryService: async () => restartedService,
			runObject,
		});
		await restarted.recoverWorkspace(workspaceRoot);
		await waitUntil(async () => {
			const file = await restartedManager.getSessionFile(workspaceRoot, SESSION);
			return (
				file.memoryLearning?.processedThroughMessageId === capturedEligible &&
				file.memoryLearning.pendingApply === undefined
			);
		}, `${crashPoint} restart receipt replay`);
		await restarted.shutdown();

		expect(llmCalls).toBe(2);
		expect(counters.cursorAdvances).toBe(1);
		const preferences = await restartedService.readPreferences();
		const topic = await restartedService.readTopic("build_tools");
		const index = await restartedService.readIndex();
		expect(countOccurrences(preferences?.content ?? "", "Prefer concise answers.")).toBe(1);
		expect(
			countOccurrences(topic?.content ?? "", "Use Bun for workspace commands."),
		).toBe(1);
		expect(countOccurrences(index ?? "", "(build_tools)")).toBe(1);

		const finalManager = new SessionStoreManager({ logger: silentLogger });
		const final = createPersistentCoordinator({
			stores: new InstrumentedSessionStores(
				finalManager,
				undefined,
				counters,
			),
			clock: restartedClock,
			policy: new MemoryPolicyRuntime(
				{ useMemory: true, autoLearning: true },
				"final-boot",
			),
			resolveMemoryService: async () => restartedService,
			runObject,
		});
		await final.recoverWorkspace(workspaceRoot);
		await settle();
		await final.shutdown();
		expect(llmCalls).toBe(2);
		expect(counters.cursorAdvances).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("MemoryIdleCoordinator", () => {
	test("runs once at exactly ten idle minutes and advances an empty batch", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS - 1);
		await settle();
		expect(calls).toBe(0);
		clock.advance(1);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("recovery preserves the remaining idle countdown and runs overdue work immediately", async () => {
		const remainingStores = new FakeSessionStores();
		const remainingClock = new FakeClock();
		remainingClock.now = MEMORY_IDLE_DELAY_MS - 100;
		let remainingCalls = 0;
		const remaining = coordinator({
			stores: remainingStores,
			clock: remainingClock,
			runObject: async () => {
				remainingCalls += 1;
				return { candidates: [] };
			},
		}).instance;
		await remaining.recoverWorkspace(WORKSPACE);
		remainingClock.advance(99);
		await settle();
		expect(remainingCalls).toBe(0);
		remainingClock.advance(1);
		await settle();
		expect(remainingCalls).toBe(1);
		await remaining.shutdown();

		const overdueStores = new FakeSessionStores();
		const overdueClock = new FakeClock();
		overdueClock.now = MEMORY_IDLE_DELAY_MS + 1;
		let overdueCalls = 0;
		const overdue = coordinator({
			stores: overdueStores,
			clock: overdueClock,
			runObject: async () => {
				overdueCalls += 1;
				return { candidates: [] };
			},
		}).instance;
		await overdue.recoverWorkspace(WORKSPACE);
		overdueClock.advance(0);
		await settle();
		expect(overdueCalls).toBe(1);
		await overdue.shutdown();
	});

	test("a new user message cancels the old timer and a later success resets it", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS - 1);
		stores.file.memoryLearning.idleSince = undefined as never;
		stores.emit("session.message_accepted");
		await settle();
		clock.advance(1);
		expect(calls).toBe(0);

		stores.file.memoryLearning = {
			...stores.file.memoryLearning,
			eligibleThroughMessageId: "assistant-1",
			idleSince: clock.now,
		};
		stores.emit("execution-end");
		await settle();
		clock.advance(MEMORY_IDLE_DELAY_MS - 1);
		await settle();
		expect(calls).toBe(0);
		clock.advance(1);
		await settle();
		expect(calls).toBe(1);
		await instance.shutdown();
	});

	test("cancelled or aborted roots and child Sessions never schedule coordinator work", async () => {
		for (const status of ["cancelled", "aborted"] as const) {
			const stores = new FakeSessionStores();
			const clock = new FakeClock();
			stores.file.executions = [
				{ ...execution("execution-1"), status },
			];
			stores.file.memoryLearning = { processedThroughMessageId: null };
			let calls = 0;
			const instance = coordinator({
				stores,
				clock,
				runObject: async () => {
					calls += 1;
					return { candidates: [] };
				},
			}).instance;
			await instance.recoverWorkspace(WORKSPACE);
			clock.advance(MEMORY_IDLE_DELAY_MS * 2);
			await settle();
			expect(calls).toBe(0);
			expect(clock.timers.size).toBe(0);
			await instance.shutdown();
		}

		const childStores = new FakeSessionStores();
		childStores.listAllSessionSummaries = async () => [
			{
				sessionId: SESSION,
				rootSessionId: "00000000-0000-4000-8000-000000000002",
				parentSessionId: "00000000-0000-4000-8000-000000000002",
				agentName: "lead",
				source: undefined,
			},
		];
		const childClock = new FakeClock();
		let childCalls = 0;
		const child = coordinator({
			stores: childStores,
			clock: childClock,
			runObject: async () => {
				childCalls += 1;
				return { candidates: [] };
			},
		}).instance;
		await child.recoverWorkspace(WORKSPACE);
		childClock.advance(MEMORY_IDLE_DELAY_MS * 2);
		await settle();
		expect(childCalls).toBe(0);
		expect(childClock.timers.size).toBe(0);
		await child.shutdown();
	});

	test("resolves automatic learning with the fast Profile", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const profiles: string[] = [];
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"fast-profile-boot",
		);
		const instance = new MemoryIdleCoordinator({
			sessionStores: stores as unknown as SessionStoreManager,
			policyRuntime: policy,
			modelRuntime: { current: {} } as ModelRuntime,
			modelSelectionResolver: {
				resolve: (input: { profile: string }) => {
					profiles.push(input.profile);
					return binding();
				},
			} as any,
			resolveMemoryService: async () => memory(),
			runObject: (async () => ({ candidates: [] })) as any,
			now: () => clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(profiles).toEqual(["fast"]);
		await instance.shutdown();
	});

	test("blocks extraction over budget without calling the LLM or advancing the cursor", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let llmCalls = 0;
		const tinyBinding = binding();
		tinyBinding.modelInfo.limit.context = 1;
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"extraction-budget-boot",
		);
		const instance = new MemoryIdleCoordinator({
			sessionStores: stores as unknown as SessionStoreManager,
			policyRuntime: policy,
			modelRuntime: { current: {} } as ModelRuntime,
			modelSelectionResolver: { resolve: () => tinyBinding } as any,
			resolveMemoryService: async () => memory(),
			runObject: (async () => {
				llmCalls += 1;
				return { candidates: [] };
			}) as any,
			now: () => clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(llmCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual(
			expect.objectContaining({
				processedThroughMessageId: null,
				blocked: expect.objectContaining({ code: "input_budget" }),
			}),
		);
		await instance.shutdown();
	});

	test("blocks reconciliation over budget after extraction without a second LLM or cursor advance", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const schemas: string[] = [];
		let applyCalls = 0;
		const constrainedBinding = binding();
		constrainedBinding.modelInfo.limit.context = 7_000;
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"reconciliation-budget-boot",
		);
		const constrained = new MemoryIdleCoordinator({
			sessionStores: stores as unknown as SessionStoreManager,
			policyRuntime: policy,
			modelRuntime: { current: {} } as ModelRuntime,
			modelSelectionResolver: { resolve: () => constrainedBinding } as any,
			resolveMemoryService: async () =>
				memory({
					readDocuments: async (targets: readonly MemoryDocumentTarget[]) =>
						targets.map((target) => ({
							...target,
							document: "x".repeat(6_000),
							revision: memoryRevision("x".repeat(6_000)),
						})),
					applyFinalDocuments: async () => {
						applyCalls += 1;
						return {
							applied: 1,
							alreadyApplied: 0,
							indexRevision: null,
						};
					},
				}),
			runObject: (async (input: any) => {
				schemas.push(input.schemaName);
				if (input.schemaName !== "memory_candidates")
					throw new Error("reconciliation LLM must not run");
				return {
					candidates: [
						{
							scope: "user",
							target: "preferences",
							content: "Prefer concise answers.",
							basis: "explicit",
							intent: "add",
						},
					],
				};
			}) as any,
			now: () => clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		await constrained.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(schemas).toEqual(["memory_candidates"]);
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual(
			expect.objectContaining({
				processedThroughMessageId: null,
				blocked: expect.objectContaining({ code: "reconciliation_budget" }),
			}),
		);
		await constrained.shutdown();
	});

	test("opt-out cancels timers and permanently skips disabled-period windows", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let calls = 0;
		const { instance, policy } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		stores.file.memoryLearning.blocked = {
			code: "capacity",
			blockedAt: clock.now,
			target: { scope: "user", name: "preferences" },
		};
		await policy.publish({ useMemory: true, autoLearning: false });
		expect(stores.file.memoryLearning.processedThroughMessageId).toBe(
			"assistant-1",
		);

		stores.file.memoryLearning = {
			processedThroughMessageId: "assistant-1",
			eligibleThroughMessageId: "assistant-off",
			idleSince: clock.now,
		};
		stores.file.messages.push(
			{
				id: "user-off",
				role: "user",
				parts: [],
				createdAt: clock.now,
				completedAt: clock.now,
			},
			{
				id: "assistant-off",
				role: "assistant",
				parts: [],
				createdAt: clock.now,
				completedAt: clock.now,
			},
		);
		stores.emit("execution-end");
		await settle();
		let committed = false;
		await policy.commitPolicy(
			{ useMemory: true, autoLearning: true },
			async () => {
				committed = true;
				expect(stores.file.memoryLearning).toEqual({
					processedThroughMessageId: "assistant-off",
				});
			},
		);
		expect(committed).toBe(true);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-off",
		});
		clock.advance(MEMORY_IDLE_DELAY_MS * 2);
		await settle();
		expect(calls).toBe(0);
		await instance.shutdown();
	});

	test("learns the first same-timestamp root conversation accepted during a deferred enable commit", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: false },
			"boot-test",
		);
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			policy,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});

		const commitStarted = deferred();
		const releaseCommit = deferred();
		const enabling = policy.commitPolicy(
			{ useMemory: true, autoLearning: true },
			async () => {
				commitStarted.resolve(undefined);
				await releaseCommit.promise;
			},
		);
		await commitStarted.promise;
		expect(policy.autoLearningAdmission).toBe("enable_pending");

		stores.emit("session.message_accepted");
		appendCompletedConversation(stores, "enable", 0);
		stores.emit("execution-end");
		await settle();
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
			eligibleThroughMessageId: "assistant-enable",
			idleSince: 0,
		});

		releaseCommit.resolve(undefined);
		await enabling;
		expect(clock.timers.size).toBe(1);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-enable",
		});
		await instance.shutdown();
	});

	test("a failed deferred enable commit closes admission and skips its same-timestamp conversation", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: false },
			"boot-test",
		);
		const { instance } = coordinator({ stores, clock, policy });
		await instance.recoverWorkspace(WORKSPACE);

		const commitStarted = deferred();
		const releaseCommit = deferred();
		const enabling = policy.commitPolicy(
			{ useMemory: true, autoLearning: true },
			async () => {
				commitStarted.resolve(undefined);
				await releaseCommit.promise;
				throw new Error("disk failed");
			},
		);
		await commitStarted.promise;
		stores.emit("session.message_accepted");
		appendCompletedConversation(stores, "failed-enable", 0);
		stores.emit("execution-end");
		await settle();

		releaseCommit.resolve(undefined);
		await expect(enabling).rejects.toThrow("disk failed");
		expect(policy.current.policy.autoLearning).toBe(false);
		expect(policy.autoLearningAdmission).toBe("disabled");
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-failed-enable",
		});
		await instance.shutdown();
	});

	test("preserves a baselined Session while a second same-timestamp baseline is deferred", async () => {
		const stores = new TwoSessionStores();
		const clock = new FakeClock();
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: false },
			"boot-test",
		);
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			policy,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);

		const secondBaseline = stores.deferNextCommit(SECOND_SESSION);
		const enabling = policy.commitPolicy(
			{ useMemory: true, autoLearning: true },
			async () => undefined,
		);
		await secondBaseline.started;
		expect(policy.autoLearningAdmission).toBe("enable_preparing");

		appendCompletedConversation(stores, "prepared-a", 0);
		stores.emitFor(SESSION, "session.message_accepted");
		stores.emitFor(SESSION, "execution-end");
		const secondFile = stores.files.get(SECOND_SESSION)!;
		appendCompletedConversation({ file: secondFile }, "before-baseline-b", 0);
		await settle();
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
			eligibleThroughMessageId: "assistant-prepared-a",
			idleSince: 0,
		});

		secondBaseline.release();
		await enabling;
		expect(secondFile.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-before-baseline-b",
		});
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-prepared-a",
		});
		await instance.shutdown();
	});

	test("a failed enable skips a prepared Session while the second same-timestamp baseline was deferred", async () => {
		const stores = new TwoSessionStores();
		const clock = new FakeClock();
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: false },
			"boot-test",
		);
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			policy,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);

		const secondBaseline = stores.deferNextCommit(SECOND_SESSION);
		const enabling = policy.commitPolicy(
			{ useMemory: true, autoLearning: true },
			async () => {
				throw new Error("disk failed");
			},
		);
		await secondBaseline.started;
		appendCompletedConversation(stores, "failed-prepared-a", 0);
		stores.emitFor(SESSION, "session.message_accepted");
		stores.emitFor(SESSION, "execution-end");
		const secondFile = stores.files.get(SECOND_SESSION)!;
		appendCompletedConversation(
			{ file: secondFile },
			"failed-before-baseline-b",
			0,
		);
		await settle();
		expect(stores.file.memoryLearning.eligibleThroughMessageId).toBe(
			"assistant-failed-prepared-a",
		);

		secondBaseline.release();
		await expect(enabling).rejects.toThrow("disk failed");
		expect(policy.autoLearningAdmission).toBe("disabled");
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-failed-prepared-a",
		});
		expect(secondFile.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-failed-before-baseline-b",
		});
		clock.advance(MEMORY_IDLE_DELAY_MS * 2);
		await settle();
		expect(calls).toBe(0);
		await instance.shutdown();
	});

	test("changing only Use Memory neither skips nor resets an auto-learning window", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let calls = 0;
		const { instance, policy } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		await policy.publish({ useMemory: false, autoLearning: true });
		expect(stores.file.memoryLearning.processedThroughMessageId).toBeNull();
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("an off-on ABA transition cannot revive an in-flight pre-receipt batch", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const reconciliationStarted = deferred();
		const releaseReconciliation = deferred();
		let applyCalls = 0;
		const { instance, policy } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async () => {
					applyCalls += 1;
					return { applied: 1, alreadyApplied: 0, indexRevision: null };
				},
			}),
			runObject: async (input) => {
				if (input.schemaName === "memory_candidates") {
					return {
						candidates: [
							{
								scope: "user",
								target: "preferences",
								content: "Keep answers concise.",
								basis: "explicit",
								intent: "add",
							},
						],
					};
				}
				reconciliationStarted.resolve(undefined);
				await releaseReconciliation.promise;
				return {
					operations: [
						{
							scope: "user",
							target: "preferences",
							action: "ADD",
							content: "Keep answers concise.",
						},
					],
				};
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await reconciliationStarted.promise;
		await policy.publish({ useMemory: true, autoLearning: false });
		await policy.publish({ useMemory: true, autoLearning: true });
		releaseReconciliation.resolve(undefined);
		await settle();
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("receipt persistence and disabling policy are linearized before the disable response", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const receiptPersistenceStarted = deferred();
		const releaseReceiptPersistence = deferred();
		let heldReceiptCommit = false;
		stores.beforePatchCommit = async (patch) => {
			if (
				heldReceiptCommit ||
				patch?.memoryLearning?.pendingApply === undefined
			)
				return;
			heldReceiptCommit = true;
			receiptPersistenceStarted.resolve(undefined);
			await releaseReceiptPersistence.promise;
		};
		let applyCalls = 0;
		const { instance, policy } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async () => {
					applyCalls += 1;
					return { applied: 1, alreadyApplied: 0, indexRevision: null };
				},
			}),
			runObject: async (input) =>
				input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "user",
									target: "preferences",
									content: "Keep answers concise.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "user",
									target: "preferences",
									action: "ADD",
									content: "Keep answers concise.",
								},
							],
						},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await receiptPersistenceStarted.promise;
		const disabling = policy.publish({ useMemory: true, autoLearning: false });
		await settle();
		releaseReceiptPersistence.resolve(undefined);
		await disabling;
		await settle();

		expect(heldReceiptCommit).toBe(true);
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("a pre-receipt LLM failure ignores Memory changes and retries on a later root window", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let calls = 0;
		let fail = true;
		const { instance } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				if (fail) throw new Error("provider unavailable");
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning.blocked?.code).toBe("llm_failed");

		fail = false;
		instance.notifyTargetChanged(WORKSPACE, {
			scope: "project",
			name: "unrelated_topic",
		});
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning.blocked?.code).toBe("llm_failed");

		const nextAt = clock.now;
		stores.file.messages.push(
			{
				id: "user-2",
				role: "user",
				executionId: "execution-2",
				parts: [
					{
						type: "text",
						id: "user-text-2",
						text: "Also prefer examples.",
						createdAt: nextAt,
						completedAt: nextAt,
					},
				],
				createdAt: nextAt,
				completedAt: nextAt,
			},
			{
				id: "assistant-2",
				role: "assistant",
				executionId: "execution-2",
				runOrdinal: 0,
				stepId: "final-step",
				outputPhase: "final_answer",
				parts: [
					{
						type: "assistant-output",
						id: "assistant-output-2",
						blockId: "output-2",
						text: "I will include examples.",
						createdAt: nextAt,
						completedAt: nextAt,
					},
				],
				createdAt: nextAt,
				completedAt: nextAt,
			},
		);
		stores.file.executions.push(execution("execution-2"));
		stores.file.memoryLearning = {
			...stores.file.memoryLearning,
			eligibleThroughMessageId: "assistant-2",
			idleSince: nextAt,
		};
		stores.emit("execution-end");
		await settle();
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(calls).toBe(2);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-2",
		});
		await instance.shutdown();
	});

	test.each(["schema", "read"] as const)(
		"a pre-receipt %s failure runs once in the idle period and once on the next boot",
		async (failure) => {
			const stores = new FakeSessionStores();
			const firstClock = new FakeClock();
			let attempts = 0;
			const service =
				failure === "read"
					? memory({
							readPromptManifest: async () => {
								attempts += 1;
								throw new Error("manifest unavailable");
							},
						})
					: memory();
			const runObject = async () => {
				if (failure === "schema") {
					attempts += 1;
					throw new LlmSchemaValidationError({
						message: "invalid structured output",
					});
				}
				throw new Error("LLM must not run after a read failure");
			};
			const first = coordinator({
				stores,
				clock: firstClock,
				service,
				runObject,
			}).instance;
			await first.recoverWorkspace(WORKSPACE);
			firstClock.advance(MEMORY_IDLE_DELAY_MS);
			await settle();
			expect(attempts).toBe(1);
			expect(stores.file.memoryLearning.blocked?.code).toBe(
				failure === "schema" ? "schema_failed" : "read_failed",
			);
			await first.recoverWorkspace(WORKSPACE);
			firstClock.advance(MEMORY_IDLE_DELAY_MS);
			await settle();
			expect(attempts).toBe(1);
			await first.shutdown();

			const nextClock = new FakeClock();
			const next = coordinator({
				stores,
				clock: nextClock,
				policy: new MemoryPolicyRuntime(
					{ useMemory: true, autoLearning: true },
					`${failure}-next-boot`,
				),
				service,
				runObject,
			}).instance;
			await next.recoverWorkspace(WORKSPACE);
			await settle();
			expect(attempts).toBe(2);
			expect(stores.file.memoryLearning.processedThroughMessageId).toBeNull();
			await next.shutdown();
		},
	);

	test("logs only stable failure classification without paths or secret-bearing error text", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const { logger, entries } = createInMemoryLogger();
		const secret = "sk_test_memory_secret";
		const absolutePath =
			"/Users/private/.archcode/runtime/memory/preferences.md";
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"boot-test",
		);
		const instance = new MemoryIdleCoordinator({
			sessionStores: stores as unknown as SessionStoreManager,
			policyRuntime: policy,
			modelRuntime: { current: {} } as ModelRuntime,
			modelSelectionResolver: { resolve: () => binding() } as any,
			resolveMemoryService: async () => {
				throw new Error(`cannot read ${absolutePath}: ${secret}`);
			},
			runObject: (async () => ({ candidates: [] })) as any,
			logger,
			now: () => clock.now,
			createId: () => "receipt-1",
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(absolutePath);
		expect(serialized).not.toContain(WORKSPACE);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "memory.idle.service_resolve_failed",
				context: { sessionId: SESSION, errorKind: "Error" },
			}),
		);
		await instance.shutdown();
	});

	test("suppresses a candidate already persisted by a successful memory_write marker", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const savedContent = "Keep answers concise.";
		stores.file.messages[1].parts.push({
			type: "tool",
			state: "completed",
			id: "saved-memory",
			toolCallId: "saved-memory:call",
			toolName: "memory_write",
			input: { scope: "user", name: "preferences", content: savedContent },
			result: { isError: false, output: { preview: "Saved" } },
			createdAt: 0,
			startedAt: 0,
			endedAt: 0,
		});
		const schemas: string[] = [];
		let applyCalls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async () => {
					applyCalls += 1;
					return { applied: 1, alreadyApplied: 0, indexRevision: null };
				},
			}),
			runObject: async (input) => {
				schemas.push(input.schemaName);
				return {
					candidates: [
						{
							scope: "user",
							target: "preferences",
							content: savedContent,
							basis: "explicit",
							intent: "add",
						},
					],
				};
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(schemas).toEqual(["memory_candidates"]);
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("a real memory_write result survives Session restart and forces the duplicate candidate to NOOP", async () => {
		const root = await mkdtemp(join(tmpdir(), "archcode-memory-marker-"));
		const artifactStore = new ToolOutputArtifactStore({
			rootDir: join(root, "tool-output"),
		});
		try {
			const workspaceRoot = join(root, "workspace");
			await mkdir(workspaceRoot, { recursive: true });
			const manager = new SessionStoreManager({ logger: silentLogger });
			await manager.createSessionFile(
				workspaceRoot,
				{ agentName: "lead", source: { kind: "direct" } },
				SESSION,
			);
			const store = await manager.getOrLoad(SESSION, workspaceRoot);
			store.getState().append({
				type: "session.message_accepted",
				message: {
					id: "marker-user",
					clientRequestId: "marker-request",
					content: "Keep answers concise.",
					attachments: [],
					executionSkillNames: [],
					source: "user",
					state: "queued",
					revision: 0,
					acceptedAt: 0,
					updatedAt: 0,
					requestedModelSelection: {
						mode: "profile_default",
						selection: { model: "test:model" },
					},
				},
			});
			const executionBinding = execution("tool-execution").runs[0]!.binding;
			store.getState().append({
				type: "execution-start",
				executionId: "tool-execution",
				binding: executionBinding,
				executionSkills: [],
				memoryPolicy: {
					policy: { useMemory: true, autoLearning: true },
					epoch: { bootId: "tool-boot", generation: 0 },
				},
				origin: "user_message",
				maxSteps: 50,
			});
			store.getState().append({
				type: "session.messages_committed",
				executionId: "tool-execution",
				messages: [
					{
						id: "marker-user",
						role: "user",
						executionId: "tool-execution",
						runOrdinal: 0,
						clientRequestId: "marker-request",
						modelAudit: {
							requested: {
								mode: "profile_default",
								selection: { model: "test:model" },
							},
							actual: { model: "test:model" },
						},
						parts: [
							{
								type: "text",
								id: "marker-user:text",
								text: "Keep answers concise.",
								createdAt: 0,
								completedAt: 0,
							},
						],
						createdAt: 0,
						completedAt: 0,
					},
				],
			});
			store.getState().append({
				type: "step-start",
				stepId: "tool-step",
				step: 0,
			});
			const input = {
				name: "preferences",
				content: "Keep answers concise.",
				scope: "user" as const,
			};
			store.getState().append({
				type: "tool-call",
				toolCallId: "memory-call",
				toolName: "memory_write",
				input,
			});
			const observedService = new ApplyObservedMemoryService(
				new MemoryFileManager({
					project: join(root, "project-memory"),
					user: join(root, "user-memory"),
				}),
			);
			const projectContext = {
				...createTestProjectContext(workspaceRoot, manager),
				memory: observedService,
			};
			const descriptor = createMemoryWriteTool();
			const context = createToolExecutionContext({
				store,
				storeManager: manager,
				toolName: "memory_write",
				toolCallId: "memory-call",
				input,
				step: 0,
				executionId: "tool-execution",
				runOrdinal: 0,
				toolBatchId: "memory-batch",
				abort: new AbortController().signal,
				startedAt: Date.now(),
				allowedTools: new Set(["memory_write"]),
				agentSkills: [],
				skillService: new SkillService({ builtinSkills: {} }),
				projectContext,
				cwd: workspaceRoot,
			});
			const raw = await descriptor.execute(input, context);
			expect(raw.isError).toBe(false);
			const finalized = await new ToolOutputFinalizer({
				artifactStore,
			}).finalize({
				descriptor,
				raw,
				context,
				attempted: true,
			});
			store.getState().append({
				type: "tool-result",
				toolCallId: "memory-call",
				toolName: "memory_write",
				result: finalized,
				settledAt: Date.now(),
			});
			store.getState().append({
				type: "step-end",
				stepId: "tool-step",
				step: 0,
				finishReason: "tool-calls",
			});
			store.getState().append({
				type: "step-start",
				stepId: "final-step",
				step: 1,
			});
			store.getState().append({
				type: "text-start",
				stepId: "final-step",
				blockId: "final-output",
			});
			store.getState().append({
				type: "text-delta",
				stepId: "final-step",
				blockId: "final-output",
				text: "I saved that preference.",
			});
			store.getState().append({
				type: "text-end",
				stepId: "final-step",
				blockId: "final-output",
			});
			store.getState().append({
				type: "step-end",
				stepId: "final-step",
				step: 1,
				finishReason: "stop",
			});
			const running = store
				.getState()
				.executions.find((candidate) => candidate.id === "tool-execution");
			if (running === undefined || running.status !== "running")
				throw new Error("Expected running marker Execution");
			const run = running.runs.at(-1)!;
			const endedAt = Math.max(Date.now(), run.startedAt);
			store.getState().append({
				type: "execution-end",
				executionId: running.id,
				terminalStatus: "completed",
				finalOutputStepId: "final-step",
				endedAt,
				runEndedAt: endedAt,
				runUsageDelta: createEmptySessionStats().usage,
				runSettlement: {
					key: `run:${SESSION}:tool-execution:0`,
					goalInstanceId: null,
				},
				terminalSettlement: {
					key: `terminal:${SESSION}:tool-execution`,
					goalInstanceId: null,
				},
			});
			const learningAfterTool = store.getState().memoryLearning;
			if (
				learningAfterTool?.processedThroughMessageId === undefined ||
				learningAfterTool.eligibleThroughMessageId === undefined
			) {
				throw new Error("Expected eligible marker learning window");
			}
			await manager.commitDurableSessionMutation(
				SESSION,
				workspaceRoot,
				(state) => ({
					result: undefined,
					patch: {
						memoryLearning: { ...state.memoryLearning!, idleSince: 0 },
					},
				}),
			);
			await manager.flushSession(SESSION, workspaceRoot);

			const restartedManager = new SessionStoreManager({ logger: silentLogger });
			const durable = await restartedManager.getSessionFile(
				workspaceRoot,
				SESSION,
			);
			let durableMarker: ToolPart | undefined;
			for (const message of durable.messages) {
				for (const part of message.parts) {
					if (
						part.type === "tool" &&
						part.toolName === "memory_write" &&
						part.state === "completed"
					) {
						durableMarker = part;
					}
				}
			}
			expect(durableMarker).toBeDefined();
			const schemas: string[] = [];
			const clock = new FakeClock();
			clock.now = MEMORY_IDLE_DELAY_MS;
			const coordinatorInstance = createPersistentCoordinator({
				stores: new InstrumentedSessionStores(
					restartedManager,
					undefined,
					{ cursorAdvances: 0 },
				),
				clock,
				policy: new MemoryPolicyRuntime(
					{ useMemory: true, autoLearning: true },
					"marker-restart",
				),
				resolveMemoryService: async () => observedService,
				runObject: async (request) => {
					schemas.push(request.schemaName);
					return {
						candidates: [
							{
								scope: "user",
								target: "preferences",
								content: "Keep answers concise.",
								basis: "explicit",
								intent: "add",
							},
						],
					};
				},
			});
			await coordinatorInstance.recoverWorkspace(workspaceRoot);
			clock.advance(0);
			await waitUntil(async () => {
				const file = await restartedManager.getSessionFile(
					workspaceRoot,
					SESSION,
				);
				return (
					file.memoryLearning?.processedThroughMessageId ===
					file.memoryLearning?.eligibleThroughMessageId ||
					file.memoryLearning?.eligibleThroughMessageId === undefined
				);
			}, "saved marker batch cursor");
			await coordinatorInstance.shutdown();
			expect(schemas).toEqual(["memory_candidates"]);
			expect(observedService.applyCalls).toBe(0);
			expect(
				countOccurrences(
					(await projectContext.memory.readPreferences())?.content ?? "",
					"Keep answers concise.",
				),
			).toBe(1);
		} finally {
			await artifactStore.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses one extraction and one reconciliation call for a non-empty batch", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const schemas: string[] = [];
		let appliedDocument = "";
		let readTargets: readonly MemoryDocumentTarget[] = [];
		const service = memory({
			readDocuments: async (targets: readonly MemoryDocumentTarget[]) => {
				readTargets = structuredClone(targets);
				return targets.map((target) => ({
					...target,
					document: null,
					revision: null,
				}));
			},
			applyFinalDocuments: async (targets: any[]) => {
				appliedDocument = targets[0].finalDocument;
				return { applied: 1, alreadyApplied: 0, indexRevision: null };
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async (input) => {
				schemas.push(input.schemaName);
				if (input.schemaName === "memory_candidates") {
					return {
						candidates: [
							{
								scope: "user",
								target: "preferences",
								content: "Keep answers concise.",
								basis: "explicit",
								intent: "add",
							},
						],
					};
				}
				return {
					operations: [
						{
							scope: "user",
							target: "preferences",
							action: "ADD",
							content: "Keep answers concise.",
						},
					],
				};
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(schemas).toEqual(["memory_candidates", "memory_reconciliation"]);
		expect(readTargets).toEqual([
			{ scope: "user", name: "preferences" },
		]);
		expect(appliedDocument).toBe("Keep answers concise.");
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("advances an all-NOOP batch without creating missing Memory documents or an index", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const schemas: string[] = [];
		let receiptCommits = 0;
		let indexReads = 0;
		let applyCalls = 0;
		stores.beforePatchCommit = async (patch) => {
			if (patch?.memoryLearning?.pendingApply !== undefined) receiptCommits += 1;
		};
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				readIndexProjection: async () => {
					indexReads += 1;
					throw new Error("all-NOOP batches must not read or create an index");
				},
				applyFinalDocuments: async () => {
					applyCalls += 1;
					throw new Error("all-NOOP batches must not apply a receipt");
				},
			}),
			runObject: async (input) => {
				schemas.push(input.schemaName);
				return input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "user",
									target: "preferences",
									content: "Keep answers concise.",
									basis: "explicit",
									intent: "add",
								},
								{
									scope: "project",
									target: "build_tools",
									title: "Build Tools",
									description: "Stable build conventions",
									type: "project",
									content: "Use Bun for workspace commands.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "user",
									target: "preferences",
									action: "NOOP",
								},
								{
									scope: "project",
									target: "build_tools",
									action: "NOOP",
								},
							],
						};
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();

		expect(schemas).toEqual(["memory_candidates", "memory_reconciliation"]);
		expect(receiptCommits).toBe(0);
		expect(indexReads).toBe(0);
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("keeps only targets with persistent changes in a mixed reconciliation receipt", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let receiptTargets: readonly any[] = [];
		let appliedTargets: readonly any[] = [];
		let appliedIndex: any;
		stores.beforePatchCommit = async (patch) => {
			if (patch?.memoryLearning?.pendingApply !== undefined) {
				receiptTargets = structuredClone(
					patch.memoryLearning.pendingApply.targets,
				);
			}
		};
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async (targets: any[], index: any) => {
					appliedTargets = structuredClone(targets);
					appliedIndex = structuredClone(index);
					return {
						applied: targets.length,
						alreadyApplied: 0,
						indexRevision: index.finalRevision,
					};
				},
			}),
			runObject: async (input) =>
				input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "user",
									target: "preferences",
									content: "Keep answers concise.",
									basis: "explicit",
									intent: "add",
								},
								{
									scope: "project",
									target: "build_tools",
									title: "Build Tools",
									description: "Stable build conventions",
									type: "project",
									content: "Use Bun for workspace commands.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "user",
									target: "preferences",
									action: "NOOP",
								},
								{
									scope: "project",
									target: "build_tools",
									action: "ADD",
									content: "Use Bun for workspace commands.",
								},
							],
						},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();

		expect(receiptTargets.map((target) => `${target.scope}:${target.name}`)).toEqual([
			"project:build_tools",
		]);
		expect(appliedTargets).toEqual(receiptTargets);
		expect(appliedIndex.finalDocument).toBe(
			"- [Build Tools](build_tools) — Stable build conventions\n",
		);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("commits a captured receipt while preserving and rescheduling a newer eligible window", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const reconciliationStarted = deferred();
		const releaseReconciliation = deferred();
		const schemas: string[] = [];
		let appliedDocument = "";
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async (targets: any[]) => {
					appliedDocument = targets[0].finalDocument;
					return { applied: 1, alreadyApplied: 0, indexRevision: null };
				},
			}),
			runObject: async (input) => {
				schemas.push(input.schemaName);
				if (input.schemaName === "memory_candidates") {
					return schemas.length === 1
						? {
								candidates: [
									{
										scope: "user",
										target: "preferences",
										content: "Keep answers concise.",
										basis: "explicit",
										intent: "add",
									},
								],
							}
						: { candidates: [] };
				}
				reconciliationStarted.resolve(undefined);
				await releaseReconciliation.promise;
				return {
					operations: [
						{
							scope: "user",
							target: "preferences",
							action: "ADD",
							content: "Keep answers concise.",
						},
					],
				};
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await reconciliationStarted.promise;

		const nextIdleSince = clock.now;
		stores.file.messages.push(
			{
				id: "user-2",
				role: "user",
				executionId: "execution-2",
				parts: [
					{
						type: "text",
						id: "user-text-2",
						text: "Use examples too.",
						createdAt: nextIdleSince,
						completedAt: nextIdleSince,
					},
				],
				createdAt: nextIdleSince,
				completedAt: nextIdleSince,
			},
			{
				id: "assistant-2",
				role: "assistant",
				executionId: "execution-2",
				runOrdinal: 0,
				stepId: "final-step",
				outputPhase: "final_answer",
				parts: [
					{
						type: "assistant-output",
						id: "assistant-output-2",
						blockId: "output-2",
						text: "I will use examples.",
						createdAt: nextIdleSince,
						completedAt: nextIdleSince,
					},
				],
				createdAt: nextIdleSince,
				completedAt: nextIdleSince,
			},
		);
		stores.file.executions.push(execution("execution-2"));
		stores.file.memoryLearning = {
			...stores.file.memoryLearning,
			eligibleThroughMessageId: "assistant-2",
			idleSince: nextIdleSince,
		};
		stores.emit("execution-end");
		await settle();

		releaseReconciliation.resolve(undefined);
		await settle();
		expect(appliedDocument).toBe("Keep answers concise.");
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
			eligibleThroughMessageId: "assistant-2",
			idleSince: nextIdleSince,
		});
		expect(clock.timers.size).toBe(1);

		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(schemas).toEqual([
			"memory_candidates",
			"memory_reconciliation",
			"memory_candidates",
		]);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-2",
		});
		await instance.shutdown();
	});

	test("serializes automatic preference reconciliation across coordinator instances sharing a user root", async () => {
		const storesA = new FakeSessionStores();
		const storesB = new FakeSessionStores();
		const clockA = new FakeClock();
		const clockB = new FakeClock();
		const firstReconciliationStarted = deferred();
		const releaseFirstReconciliation = deferred();
		let document: string | null = null;
		const readRevisions: Array<string | null> = [];
		const sharedService = memory({
			projectRoot: "/memory/project-a",
			userRoot: "/memory/shared-user",
			readDocuments: async (targets: any[]) => {
				const revision = document === null ? null : memoryRevision(document);
				readRevisions.push(revision);
				return targets.map((target) => ({ ...target, document, revision }));
			},
			applyFinalDocuments: async (targets: any[]) => {
				const target = targets[0];
				const currentRevision =
					document === null ? null : memoryRevision(document);
				if (target.expectedRevision !== currentRevision)
					throw new Error("stale preference receipt");
				document = target.finalDocument;
				return { applied: 1, alreadyApplied: 0, indexRevision: null };
			},
		});
		const preferenceRunner =
			(content: string, pause: boolean) => async (input: any) => {
				if (input.schemaName === "memory_candidates") {
					return {
						candidates: [
							{
								scope: "user",
								target: "preferences",
								content,
								basis: "explicit",
								intent: "add",
							},
						],
					};
				}
				if (pause) {
					firstReconciliationStarted.resolve(undefined);
					await releaseFirstReconciliation.promise;
				}
				return {
					operations: [
						{
							scope: "user",
							target: "preferences",
							action: "ADD",
							content,
						},
					],
				};
			};
		const first = coordinator({
			stores: storesA,
			clock: clockA,
			service: sharedService,
			runObject: preferenceRunner("First preference", true),
		}).instance;
		const second = coordinator({
			stores: storesB,
			clock: clockB,
			service: sharedService,
			runObject: preferenceRunner("Second preference", false),
		}).instance;

		await first.recoverWorkspace(WORKSPACE);
		clockA.advance(MEMORY_IDLE_DELAY_MS);
		await firstReconciliationStarted.promise;
		await second.recoverWorkspace(WORKSPACE);
		clockB.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(readRevisions).toEqual([null]);

		releaseFirstReconciliation.resolve(undefined);
		await settle();
		expect(readRevisions).toEqual([null, memoryRevision("First preference")]);
		expect(typeof document === "string" ? document : "").toBe(
			"First preference\n\n---\n\nSecond preference",
		);
		expect(storesA.file.memoryLearning.blocked).toBeUndefined();
		expect(storesB.file.memoryLearning.blocked).toBeUndefined();
		expect(storesA.file.memoryLearning.processedThroughMessageId).toBe(
			"assistant-1",
		);
		expect(storesB.file.memoryLearning.processedThroughMessageId).toBe(
			"assistant-1",
		);
		await Promise.all([first.shutdown(), second.shutdown()]);
	});

	test("two project MemoryService instances reread shared personal Memory inside the automatic lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "archcode-memory-personal-race-"));
		try {
			const userRoot = join(root, "shared-user");
			const storesA = new FakeSessionStores();
			const storesB = new FakeSessionStores();
			const clockA = new FakeClock();
			const clockB = new FakeClock();
			const firstReconciliationStarted = deferred();
			const releaseFirstReconciliation = deferred();
			const readRevisions: Array<string | null> = [];
			const serviceA = new ObservedMemoryService(
				new MemoryFileManager({
					project: join(root, "project-a"),
					user: userRoot,
				}),
				(_targets, revisions) => readRevisions.push(...revisions),
			);
			const serviceB = new ObservedMemoryService(
				new MemoryFileManager({
					project: join(root, "project-b"),
					user: userRoot,
				}),
				(_targets, revisions) => readRevisions.push(...revisions),
			);
			const runner =
				(content: string, pause: boolean) => async (input: any) => {
					if (input.schemaName === "memory_candidates") {
						return {
							candidates: [
								{
									scope: "user",
									target: "preferences",
									content,
									basis: "explicit",
									intent: "add",
								},
							],
						};
					}
					if (pause) {
						firstReconciliationStarted.resolve(undefined);
						await releaseFirstReconciliation.promise;
					}
					return {
						operations: [
							{
								scope: "user",
								target: "preferences",
								action: "ADD",
								content,
							},
						],
					};
				};
			const first = coordinator({
				stores: storesA,
				clock: clockA,
				service: serviceA,
				runObject: runner("First preference", true),
			}).instance;
			const second = coordinator({
				stores: storesB,
				clock: clockB,
				service: serviceB,
				runObject: runner("Second preference", false),
			}).instance;

			await first.recoverWorkspace("/workspace-project-a");
			clockA.advance(MEMORY_IDLE_DELAY_MS);
			await firstReconciliationStarted.promise;
			await second.recoverWorkspace("/workspace-project-b");
			clockB.advance(MEMORY_IDLE_DELAY_MS);
			await settle();
			expect(readRevisions).toEqual([null]);

			releaseFirstReconciliation.resolve(undefined);
			await waitUntil(
				() =>
					storesA.file.memoryLearning.processedThroughMessageId ===
						"assistant-1" &&
					storesB.file.memoryLearning.processedThroughMessageId ===
						"assistant-1",
				"both personal batches to commit",
			);
			const firstRevision = memoryRevision("First preference");
			expect(readRevisions).toEqual([null, firstRevision]);
			const finalPreferences = await serviceA.readPreferences();
			expect(finalPreferences?.content).toBe(
				"First preference\n\n---\n\nSecond preference",
			);
			expect(countOccurrences(finalPreferences?.content ?? "", "First preference")).toBe(1);
			expect(countOccurrences(finalPreferences?.content ?? "", "Second preference")).toBe(1);
			expect(storesA.file.memoryLearning.blocked).toBeUndefined();
			expect(storesB.file.memoryLearning.blocked).toBeUndefined();
			await Promise.all([first.shutdown(), second.shutdown()]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("creates a new topic receipt with complete frontmatter and deterministic index", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let seenTargets: any[] = [];
		let seenIndex: any;
		const service = memory({
			applyFinalDocuments: async (targets: any[], index: any) => {
				seenTargets = targets;
				seenIndex = index;
				return {
					applied: 1,
					alreadyApplied: 0,
					indexRevision: index.finalRevision,
				};
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async (input) =>
				input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "project",
									target: "build_tools",
									title: "Build Tools",
									description: "Stable build conventions",
									type: "project",
									content: "Use Bun for workspace commands.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "project",
									target: "build_tools",
									action: "ADD",
									content: "Use Bun for workspace commands.",
								},
							],
						},
		});
		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(seenTargets[0].finalDocument).toContain("name: Build Tools");
		expect(seenTargets[0].finalDocument).toContain(
			"Use Bun for workspace commands.",
		);
		expect(seenIndex.finalDocument).toBe(
			"- [Build Tools](build_tools) — Stable build conventions\n",
		);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("preserves type=user frontmatter when reconciling an existing explicit project topic", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const existingDocument = [
			"---",
			"name: Personal Project Notes",
			"description: Explicitly written project topic",
			"type: user",
			"---",
			"Existing note.",
		].join("\n");
		const existingIndex =
			"- [Personal Project Notes](personal_project_notes) — Explicitly written project topic\n";
		let appliedDocument = "";
		const service = memory({
			readDocuments: async (targets: readonly MemoryDocumentTarget[]) =>
				targets.map((target) => ({
					...target,
					document: existingDocument,
					revision: memoryRevision(existingDocument),
				})),
			readIndexProjection: async () => ({
				content: existingIndex,
				revision: memoryRevision(existingIndex),
				topicCount: {
					count: 1,
					max: 200,
					state: "within-limit",
					canCreate: true,
				},
				availableForPrompt: true,
			}),
			applyFinalDocuments: async (targets: any[], index: any) => {
				appliedDocument = targets[0].finalDocument;
				return {
					applied: 1,
					alreadyApplied: 0,
					indexRevision: index.finalRevision,
				};
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async (input) =>
				input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "project",
									target: "personal_project_notes",
									title: "Candidate Title",
									description: "Candidate description",
									type: "project",
									content: "New note.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "project",
									target: "personal_project_notes",
									action: "ADD",
									content: "New note.",
								},
							],
						},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();

		expect(appliedDocument).toBe(`${existingDocument}\n\n---\n\nNew note.`);
		expect(appliedDocument).toContain("type: user");
		expect(appliedDocument).not.toContain("Candidate Title");
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("serializes same-topic automatic batches and preserves both updates plus the generated index", async () => {
		const storesA = new FakeSessionStores();
		const storesB = new FakeSessionStores();
		const clockA = new FakeClock();
		const clockB = new FakeClock();
		const firstReconciliationStarted = deferred();
		const releaseFirstReconciliation = deferred();
		let topicDocument: string | null = null;
		let indexDocument: string | null = null;
		let firstAppliedTopicDocument: string | null = null;
		const readRevisions: Array<string | null> = [];
		const sharedService = memory({
			projectRoot: "/memory/shared-project",
			userRoot: "/memory/user-a",
			readDocuments: async (targets: any[]) => {
				const revision =
					topicDocument === null ? null : memoryRevision(topicDocument);
				readRevisions.push(revision);
				return targets.map((target) => ({
					...target,
					document: topicDocument,
					revision,
				}));
			},
			readIndexProjection: async () => ({
				content: indexDocument,
				revision: indexDocument === null ? null : memoryRevision(indexDocument),
				topicCount: {
					count: topicDocument === null ? 0 : 1,
					max: 200,
					state: "within-limit",
					canCreate: true,
				},
				availableForPrompt: true,
			}),
			applyFinalDocuments: async (targets: any[], index: any) => {
				const target = targets[0];
				const currentTopicRevision =
					topicDocument === null ? null : memoryRevision(topicDocument);
				const currentIndexRevision =
					indexDocument === null ? null : memoryRevision(indexDocument);
				if (target.expectedRevision !== currentTopicRevision)
					throw new Error("stale topic receipt");
				if (index.expectedRevision !== currentIndexRevision)
					throw new Error("stale index receipt");
				if (topicDocument === null)
					firstAppliedTopicDocument = target.finalDocument;
				topicDocument = target.finalDocument;
				indexDocument = index.finalDocument;
				return {
					applied: 1,
					alreadyApplied: 0,
					indexRevision: memoryRevision(indexDocument!),
				};
			},
		});
		const topicRunner =
			(content: string, pause: boolean) => async (input: any) => {
				if (input.schemaName === "memory_candidates") {
					return {
						candidates: [
							{
								scope: "project",
								target: "build_tools",
								title: "Build Tools",
								description: "Stable build conventions",
								type: "project",
								content,
								basis: "explicit",
								intent: "add",
							},
						],
					};
				}
				if (pause) {
					firstReconciliationStarted.resolve(undefined);
					await releaseFirstReconciliation.promise;
				}
				return {
					operations: [
						{
							scope: "project",
							target: "build_tools",
							action: "ADD",
							content,
						},
					],
				};
			};
		const first = coordinator({
			stores: storesA,
			clock: clockA,
			service: sharedService,
			runObject: topicRunner("Use Bun.", true),
		}).instance;
		const second = coordinator({
			stores: storesB,
			clock: clockB,
			service: sharedService,
			runObject: topicRunner("Run typecheck first.", false),
		}).instance;

		await first.recoverWorkspace(WORKSPACE);
		clockA.advance(MEMORY_IDLE_DELAY_MS);
		await firstReconciliationStarted.promise;
		await second.recoverWorkspace(WORKSPACE);
		clockB.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(readRevisions).toEqual([null]);

		releaseFirstReconciliation.resolve(undefined);
		await settle();
		expect(readRevisions).toHaveLength(2);
		expect(firstAppliedTopicDocument).not.toBeNull();
		expect(readRevisions[1]).toBe(memoryRevision(firstAppliedTopicDocument!));
		expect(typeof topicDocument === "string" ? topicDocument : "").toContain(
			"Use Bun.\n\n---\n\nRun typecheck first.",
		);
		expect(typeof indexDocument === "string" ? indexDocument : "").toBe(
			"- [Build Tools](build_tools) — Stable build conventions\n",
		);
		expect(storesA.file.memoryLearning.blocked).toBeUndefined();
		expect(storesB.file.memoryLearning.blocked).toBeUndefined();
		await Promise.all([first.shutdown(), second.shutdown()]);
	});

	test("uses a project-wide capacity warning and retries after any project topic frees capacity", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		let topicCount = MAX_MEMORY_TOPICS;
		let applyCalls = 0;
		const service = memory({
			snapshot: async () => {
				throw new Error("automatic learning must not read all topic bodies");
			},
			readIndexProjection: async () => ({
				content: null,
				revision: null,
				topicCount: {
					count: topicCount,
					max: MAX_MEMORY_TOPICS,
					state: topicCount === MAX_MEMORY_TOPICS ? "at-limit" : "within-limit",
					canCreate: topicCount < MAX_MEMORY_TOPICS,
				},
				availableForPrompt: true,
			}),
			applyFinalDocuments: async (_targets: any[], index: any) => {
				applyCalls += 1;
				return {
					applied: 1,
					alreadyApplied: 0,
					indexRevision: index.finalRevision,
				};
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async (input) =>
				input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "project",
									target: "new_topic",
									title: "New Topic",
									description: "New durable knowledge",
									type: "project",
									content: "Remember this project fact.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "project",
									target: "new_topic",
									action: "ADD",
									content: "Remember this project fact.",
								},
							],
						},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(stores.file.memoryLearning.blocked).toEqual(
			expect.objectContaining({
				code: "capacity",
			}),
		);
		expect(stores.file.memoryLearning.blocked.target).toBeUndefined();
		expect(applyCalls).toBe(0);

		topicCount -= 1;
		instance.notifyTargetChanged(WORKSPACE, {
			scope: "project",
			name: "deleted_old_topic",
		});
		await settle();
		expect(applyCalls).toBe(1);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("disabled startup discards a pending receipt without apply or LLM work", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const finalDocument = "Disabled preference";
		stores.file.memoryLearning.pendingApply = {
			id: "receipt-disabled",
			captured: {
				processedThroughMessageId: null,
				eligibleThroughMessageId: "assistant-1",
				policyEpoch: { bootId: "old", generation: 1 },
			},
			targets: [
				{
					scope: "user",
					name: "preferences",
					expectedRevision: null,
					finalDocument,
					finalRevision: memoryRevision(finalDocument),
				},
			],
			createdAt: 1,
		};
		let llmCalls = 0;
		let applyCalls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			policy: new MemoryPolicyRuntime(
				{ useMemory: true, autoLearning: false },
				"disabled-boot",
			),
			service: memory({
				applyFinalDocuments: async () => {
					applyCalls += 1;
					return { applied: 1, alreadyApplied: 0, indexRevision: null };
				},
			}),
			runObject: async () => {
				llmCalls += 1;
				return { candidates: [] };
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(llmCalls).toBe(0);
		expect(applyCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("replays an already-applied receipt without an LLM and commits its cursor", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const finalDocument = "Already durable";
		stores.file.memoryLearning.pendingApply = {
			id: "receipt-already-applied",
			captured: {
				processedThroughMessageId: null,
				eligibleThroughMessageId: "assistant-1",
				policyEpoch: { bootId: "old", generation: 1 },
			},
			targets: [
				{
					scope: "user",
					name: "preferences",
					expectedRevision: null,
					finalDocument,
					finalRevision: memoryRevision(finalDocument),
				},
			],
			createdAt: 1,
		};
		let llmCalls = 0;
		let applyCalls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async (targets: any[]) => {
					applyCalls += 1;
					expect(targets[0].finalRevision).toBe(memoryRevision(finalDocument));
					return { applied: 0, alreadyApplied: 1, indexRevision: null };
				},
			}),
			runObject: async () => {
				llmCalls += 1;
				return { candidates: [] };
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(applyCalls).toBe(1);
		expect(llmCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("replays a durable receipt without an LLM and retries deterministic I/O at most three times", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const finalDocument = "Durable preference";
		const receipt: MemoryPendingApplyReceipt = {
			id: "receipt-recovery",
			captured: {
				processedThroughMessageId: null,
				eligibleThroughMessageId: "assistant-1",
				policyEpoch: { bootId: "old-boot", generation: 7 },
			},
			targets: [
				{
					scope: "user",
					name: "preferences",
					expectedRevision: null,
					finalDocument,
					finalRevision: memoryRevision(finalDocument),
				},
			],
			createdAt: 1,
		};
		stores.file.memoryLearning = {
			processedThroughMessageId: null,
			eligibleThroughMessageId: "assistant-1",
			idleSince: 0,
			pendingApply: receipt,
		};
		let applyAttempts = 0;
		let llmCalls = 0;
		const service = memory({
			applyFinalDocuments: async () => {
				applyAttempts += 1;
				if (applyAttempts < 3) throw new Error("transient disk failure");
				return { applied: 1, alreadyApplied: 0, indexRevision: null };
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async () => {
				llmCalls += 1;
				return { candidates: [] };
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(applyAttempts).toBe(3);
		expect(llmCalls).toBe(0);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("keeps a failed receipt and exposes one safe warning after three attempts", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const finalDocument = "Durable preference";
		stores.file.memoryLearning = {
			processedThroughMessageId: null,
			eligibleThroughMessageId: "assistant-1",
			idleSince: 0,
			pendingApply: {
				id: "receipt-failed",
				captured: {
					processedThroughMessageId: null,
					eligibleThroughMessageId: "assistant-1",
					policyEpoch: { bootId: "old", generation: 0 },
				},
				targets: [
					{
						scope: "user",
						name: "preferences",
						expectedRevision: null,
						finalDocument,
						finalRevision: memoryRevision(finalDocument),
					},
				],
				createdAt: 1,
			},
		};
		let attempts = 0;
		const { instance } = coordinator({
			stores,
			clock,
			service: memory({
				applyFinalDocuments: async () => {
					attempts += 1;
					throw new Error("disk unavailable");
				},
			}),
		});
		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(attempts).toBe(3);
		expect(stores.file.memoryLearning.pendingApply?.id).toBe("receipt-failed");
		expect(stores.file.memoryLearning.blocked?.code).toBe("apply_failed");
		const warnings = await instance.listWarnings(WORKSPACE);
		expect(warnings).toEqual([
			expect.objectContaining({
				code: "apply_failed",
				sessionId: SESSION,
				message: expect.not.stringContaining("disk unavailable"),
			}),
		]);
		await settle();
		expect(attempts).toBe(3);
		await instance.shutdown();
	});

	test("rechecks a target notification that races receipt persistence and rebuilds without restart", async () => {
		const stores = new FakeSessionStores();
		const clock = new FakeClock();
		const receiptPersistenceStarted = deferred();
		const releaseReceiptPersistence = deferred();
		let heldFirstReceipt = false;
		let document: string | null = null;
		let llmCalls = 0;
		let applyCalls = 0;
		stores.beforePatchCommit = async (patch) => {
			if (
				!heldFirstReceipt &&
				patch?.memoryLearning?.pendingApply !== undefined
			) {
				heldFirstReceipt = true;
				receiptPersistenceStarted.resolve(undefined);
				await releaseReceiptPersistence.promise;
			}
		};
		const service = memory({
			readDocuments: async (targets: readonly MemoryDocumentTarget[]) =>
				targets.map((target) => ({
					...target,
					document,
					revision: document === null ? null : memoryRevision(document),
				})),
			applyFinalDocuments: async (targets: any[]) => {
				applyCalls += 1;
				const target = targets[0];
				const currentRevision =
					document === null ? null : memoryRevision(document);
				if (
					currentRevision !== target.expectedRevision &&
					currentRevision !== target.finalRevision
				) {
					throw new MemoryRevisionConflictError(
						"user:preferences",
						target.expectedRevision,
						currentRevision,
					);
				}
				document = target.finalDocument;
				return { applied: 1, alreadyApplied: 0, indexRevision: null };
			},
		});
		const { instance } = coordinator({
			stores,
			clock,
			service,
			runObject: async (input) => {
				llmCalls += 1;
				return input.schemaName === "memory_candidates"
					? {
							candidates: [
								{
									scope: "user",
									target: "preferences",
									content: "Prefer concise answers.",
									basis: "explicit",
									intent: "add",
								},
							],
						}
					: {
							operations: [
								{
									scope: "user",
									target: "preferences",
									action: "ADD",
									content: "Prefer concise answers.",
								},
							],
						};
			},
		});

		await instance.recoverWorkspace(WORKSPACE);
		clock.advance(MEMORY_IDLE_DELAY_MS);
		await receiptPersistenceStarted.promise;

		// This is the exact lost-wakeup window: reconciliation has finished, but
		// pendingApply is not durable yet, so the first retry inspection is empty.
		document = "Manual preference";
		instance.notifyTargetChanged(WORKSPACE, {
			scope: "user",
			name: "preferences",
		});
		await settle();
		releaseReceiptPersistence.resolve(undefined);
		await settle();

		expect(heldFirstReceipt).toBe(true);
		expect(llmCalls).toBe(4);
		expect(applyCalls).toBe(2);
		expect(document).toBe(
			"Manual preference\n\n---\n\nPrefer concise answers.",
		);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await instance.shutdown();
	});

	test("discards an obsolete receipt on revision conflict and rebuilds it once on the next boot", async () => {
		const stores = new FakeSessionStores();
		const firstClock = new FakeClock();
		let llmCalls = 0;
		let conflict = true;
		let applyCalls = 0;
		const service = memory({
			applyFinalDocuments: async () => {
				applyCalls += 1;
				if (conflict) {
					throw new MemoryRevisionConflictError(
						"user:preferences",
						null,
						"manual-revision",
					);
				}
				return { applied: 1, alreadyApplied: 0, indexRevision: null };
			},
		});
		const runObject = async (input: any) => {
			llmCalls += 1;
			return input.schemaName === "memory_candidates"
				? {
						candidates: [
							{
								scope: "user",
								target: "preferences",
								content: "Prefer concise answers.",
								basis: "explicit",
								intent: "add",
							},
						],
					}
				: {
						operations: [
							{
								scope: "user",
								target: "preferences",
								action: "ADD",
								content: "Prefer concise answers.",
							},
						],
					};
		};
		const first = coordinator({
			stores,
			clock: firstClock,
			service,
			runObject,
		}).instance;
		await first.recoverWorkspace(WORKSPACE);
		firstClock.advance(MEMORY_IDLE_DELAY_MS);
		await settle();
		expect(applyCalls).toBe(1);
		expect(llmCalls).toBe(2);
		expect(stores.file.memoryLearning).toEqual(
			expect.objectContaining({
				processedThroughMessageId: null,
				pendingApply: undefined,
				blocked: expect.objectContaining({
					code: "revision_conflict",
					target: { scope: "user", name: "preferences" },
				}),
			}),
		);
		await first.shutdown();

		conflict = false;
		const secondClock = new FakeClock();
		const second = coordinator({
			stores,
			clock: secondClock,
			policy: new MemoryPolicyRuntime(
				{ useMemory: true, autoLearning: true },
				"next-boot",
			),
			service,
			runObject,
		}).instance;
		await second.recoverWorkspace(WORKSPACE);
		await settle();
		expect(llmCalls).toBe(4);
		expect(applyCalls).toBe(2);
		expect(stores.file.memoryLearning).toEqual({
			processedThroughMessageId: "assistant-1",
		});
		await second.shutdown();
	});

	test("restart recovers a receipt persisted before any Memory write without LLM replay", async () => {
		await runCrashRestartFixture("after_receipt_persisted");
	});

	test("restart recovers after the first target file write without duplicates or LLM replay", async () => {
		await runCrashRestartFixture("after_first_target_written");
	});

	test("restart recovers after all Memory files and index but before the cursor commit", async () => {
		await runCrashRestartFixture("after_all_memory_written");
	});

	test("aggregates warnings stably and clears shared personal capacity blocks across projects", async () => {
		const workspaceA = "/workspace-a";
		const workspaceB = "/workspace-b";
		const files = new Map<string, any>();
		const addFile = (workspace: string, sessionId: string) => {
			const file = rootFile();
			file.sessionId = sessionId;
			file.rootSessionId = sessionId;
			files.set(`${workspace}\0${sessionId}`, file);
		};
		addFile(workspaceA, "session-a2");
		addFile(workspaceA, "session-a1");
		addFile(workspaceB, "session-b1");
		const stores = {
			subscribeToSessionEvents: () => () => undefined,
			listAllSessionSummaries: async (workspace: string) =>
				[...files.entries()]
					.filter(([key]) => key.startsWith(`${workspace}\0`))
					.map(([, file]) => ({
						sessionId: file.sessionId,
						rootSessionId: file.rootSessionId,
						agentName: file.agentName,
						source: file.source,
					})),
			getSessionFile: async (workspace: string, sessionId: string) =>
				structuredClone(files.get(`${workspace}\0${sessionId}`)),
			commitDurableSessionMutation: async <T>(
				sessionId: string,
				workspace: string,
				mutate: (state: Readonly<SessionStoreState>) => {
					result: T;
					patch?: Partial<SessionStoreState>;
				},
			) => {
				const file = files.get(`${workspace}\0${sessionId}`);
				const outcome = mutate(file as SessionStoreState);
				if (outcome.patch !== undefined)
					Object.assign(file, structuredClone(outcome.patch));
				return outcome.result;
			},
		};
		const clock = new FakeClock();
		const policy = new MemoryPolicyRuntime(
			{ useMemory: true, autoLearning: true },
			"warnings-boot",
		);
		const instance = new MemoryIdleCoordinator({
			sessionStores: stores as unknown as SessionStoreManager,
			policyRuntime: policy,
			modelRuntime: { current: {} } as ModelRuntime,
			modelSelectionResolver: { resolve: () => binding() } as any,
			resolveMemoryService: async (workspace) =>
				memory({
					projectRoot: `/memory${workspace}/project`,
					userRoot: "/memory/shared-user",
				}),
			runObject: (async () => ({ candidates: [] })) as any,
			now: () => clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		await instance.recoverWorkspace(workspaceA);
		await instance.recoverWorkspace(workspaceB);

		files.get(`${workspaceA}\0session-a2`).memoryLearning.blocked = {
			code: "capacity",
			blockedAt: 10,
			target: { scope: "user", name: "preferences" },
		};
		files.get(`${workspaceA}\0session-a1`).memoryLearning.blocked = {
			code: "capacity",
			blockedAt: 10,
			target: { scope: "user", name: "preferences" },
		};
		files.get(`${workspaceB}\0session-b1`).memoryLearning.blocked = {
			code: "capacity",
			blockedAt: 15,
			target: { scope: "user", name: "preferences" },
		};
		expect(
			(await instance.listWarnings(workspaceA)).map(
				(warning) => warning.sessionId,
			),
		).toEqual(["session-a1", "session-a2"]);
		expect(
			(await instance.listWarnings(workspaceB)).map(
				(warning) => warning.sessionId,
			),
		).toEqual(["session-b1"]);

		instance.notifyTargetChanged(workspaceA, {
			scope: "user",
			name: "preferences",
		});
		await settle();
		expect(await instance.listWarnings(workspaceA)).toEqual([]);
		expect(await instance.listWarnings(workspaceB)).toEqual([]);
		for (const file of files.values()) {
			expect(file.memoryLearning.processedThroughMessageId).toBe("assistant-1");
		}

		const pendingPersonal = "Pending personal preference";
		files.get(`${workspaceA}\0session-a1`).memoryLearning = {
			processedThroughMessageId: null,
			eligibleThroughMessageId: "assistant-1",
			idleSince: 0,
			pendingApply: {
				id: "pending-personal-a1",
				captured: {
					processedThroughMessageId: null,
					eligibleThroughMessageId: "assistant-1",
					policyEpoch: { bootId: "warnings-boot", generation: 0 },
				},
				targets: [
					{
						scope: "user",
						name: "preferences",
						expectedRevision: null,
						finalDocument: pendingPersonal,
						finalRevision: memoryRevision(pendingPersonal),
					},
				],
				createdAt: 30,
			},
			blocked: {
				code: "apply_failed",
				blockedAt: 30,
				target: { scope: "user", name: "preferences" },
			},
		};
		expect(
			(await instance.listWarnings(workspaceA)).map(
				(warning) => warning.sessionId,
			),
		).toEqual(["session-a1"]);
		expect(await instance.listWarnings(workspaceB)).toEqual([]);
		await instance.shutdown();
	});

	test("retries a pre-receipt warning only once per Session and boot", async () => {
		const stores = new FakeSessionStores();
		stores.file.memoryLearning.blocked = { code: "llm_failed", blockedAt: 1 };
		const clock = new FakeClock();
		let calls = 0;
		const { instance } = coordinator({
			stores,
			clock,
			runObject: async () => {
				calls += 1;
				throw new Error("still unavailable");
			},
		});
		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(calls).toBe(1);
		await instance.recoverWorkspace(WORKSPACE);
		await settle();
		expect(calls).toBe(1);
		expect(stores.file.memoryLearning.blocked?.code).toBe("llm_failed");
		await instance.shutdown();
	});
});
