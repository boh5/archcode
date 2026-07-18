import { createHash } from "node:crypto";
import type {
  HitlDisplayPayload,
  HitlResponse,
  HitlSource,
} from "@archcode/protocol";
import { sortJsonValue } from "@archcode/utils";
import { z } from "zod/v4";

import type {
  PermissionToolBlockedRequest,
  ToolBlockedRequest,
} from "../tool-output/types";
import type {
  CreateHitlInput,
  HitlDelivery,
  HitlRecord,
  ProjectHitlFile,
} from "./project-queue";

const KIB = 1024;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_DISPLAY_BYTES = 32 * KIB;
const MAX_BLOCKED_REQUEST_BYTES = 48 * KIB;
const MAX_QUESTION_RESPONSE_BYTES = 64 * KIB;
const MAX_DECISION_RESPONSE_BYTES = 8 * KIB;
const MAX_RECORD_BYTES = 128 * KIB;

export interface HitlRedactionPolicy {
  redactString(value: string): string;
  redactValue<T>(value: T): T;
}

export interface RedactedHitlFailure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export interface PersistedSessionToolCallBlocker {
  readonly requestKey: string;
  readonly hitlId?: string;
  readonly source: Extract<HitlSource, { type: "ask_user" | "tool_permission" }>;
  readonly displayPayload: HitlDisplayPayload;
  readonly permissionFingerprint?: string;
  readonly persistentApprovalEligible?: boolean;
  readonly permission?: {
    readonly description: string;
    readonly reason?: string;
    readonly decisionDisplay?: string;
    readonly ruleId?: string;
  };
  readonly responseAppliedAt?: string;
  readonly response?: HitlResponse;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(maxBytes: number, options: { nonempty?: boolean } = {}) {
  let schema = z.string();
  if (options.nonempty === true) schema = schema.min(1);
  return schema.refine(
    (value) => utf8Bytes(value) <= maxBytes,
    `String exceeds ${maxBytes} UTF-8 bytes`,
  );
}

function serializedWithin(value: unknown, maxBytes: number): boolean {
  try {
    return utf8Bytes(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

const IdentifierSchema = boundedString(MAX_IDENTIFIER_BYTES, { nonempty: true });
const ActorSchema = boundedString(256);
const CommentSchema = boundedString(4 * KIB);
const TimestampSchema = boundedString(MAX_IDENTIFIER_BYTES, { nonempty: true });

const HitlOwnerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session"), id: IdentifierSchema }),
  z.strictObject({ type: z.literal("goal"), id: IdentifierSchema }),
]);

const AskUserSourceSchema = z.strictObject({ type: z.literal("ask_user"), toolCallId: IdentifierSchema });
const PermissionSourceSchema = z.strictObject({
  type: z.literal("tool_permission"),
  toolCallId: IdentifierSchema,
  toolName: IdentifierSchema,
});
const GoalBudgetSourceSchema = z.strictObject({ type: z.literal("goal_budget"), approvalPoint: IdentifierSchema });

const HitlSourceSchema: z.ZodType<HitlSource> = z.discriminatedUnion("type", [
  AskUserSourceSchema,
  PermissionSourceSchema,
  GoalBudgetSourceSchema,
]);

const HitlQuestionDisplayOptionSchema = z.strictObject({
  label: boundedString(256),
  description: boundedString(2 * KIB),
});

const HitlQuestionDisplayItemSchema = z.strictObject({
  question: boundedString(2 * KIB, { nonempty: true }),
  header: boundedString(256, { nonempty: true }),
  options: z.array(HitlQuestionDisplayOptionSchema).max(3).optional(),
  multiple: z.boolean().optional(),
  custom: z.boolean(),
});

const HitlDisplayPayloadSchema: z.ZodType<HitlDisplayPayload> = z.strictObject({
  title: boundedString(256, { nonempty: true }),
  summary: boundedString(2 * KIB).optional(),
  fields: z.array(z.strictObject({
    label: boundedString(256),
    value: boundedString(4 * KIB),
  })).max(16).optional(),
  questions: z.array(HitlQuestionDisplayItemSchema).max(3).optional(),
  redacted: z.literal(true),
}).refine(
  (value) => serializedWithin(value, MAX_DISPLAY_BYTES),
  `HITL display payload exceeds ${MAX_DISPLAY_BYTES} UTF-8 bytes`,
);

const PermissionDetailsSchema = z.strictObject({
  description: boundedString(4 * KIB, { nonempty: true }),
  reason: boundedString(4 * KIB).optional(),
  decisionDisplay: boundedString(4 * KIB).optional(),
  ruleId: boundedString(256).optional(),
});

const AskUserBlockedRequestSchema = z.strictObject({
  source: AskUserSourceSchema,
  displayPayload: HitlDisplayPayloadSchema,
});

const PermissionBlockedRequestSchema: z.ZodType<PermissionToolBlockedRequest> = z.strictObject({
  source: PermissionSourceSchema,
  displayPayload: HitlDisplayPayloadSchema,
  permissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  persistentApprovalEligible: z.boolean(),
  permission: PermissionDetailsSchema,
});

const ToolBlockedRequestSchema: z.ZodType<ToolBlockedRequest> = z
  .union([AskUserBlockedRequestSchema, PermissionBlockedRequestSchema])
  .refine(
    (value) => serializedWithin(value, MAX_BLOCKED_REQUEST_BYTES),
    `Tool blocked request exceeds ${MAX_BLOCKED_REQUEST_BYTES} UTF-8 bytes`,
  );

const QuestionAnswerResponseSchema = z.strictObject({
  type: z.literal("question_answer"),
  answers: z.array(boundedString(16 * KIB)).max(3),
  comment: CommentSchema.optional(),
  answeredBy: ActorSchema.optional(),
}).refine(
  (value) => serializedWithin(value, MAX_QUESTION_RESPONSE_BYTES),
  `Question response exceeds ${MAX_QUESTION_RESPONSE_BYTES} UTF-8 bytes`,
);

const PermissionDecisionResponseSchema = z.strictObject({
  type: z.literal("permission_decision"),
  decision: z.enum(["approve_once", "approve_always", "deny"]),
  comment: CommentSchema.optional(),
  decidedBy: ActorSchema.optional(),
}).refine(
  (value) => serializedWithin(value, MAX_DECISION_RESPONSE_BYTES),
  `Permission response exceeds ${MAX_DECISION_RESPONSE_BYTES} UTF-8 bytes`,
);

const BudgetDecisionResponseSchema = z.strictObject({
  type: z.literal("budget_decision"),
  decision: z.enum(["approved", "denied"]),
  comment: CommentSchema.optional(),
  decidedBy: ActorSchema.optional(),
}).refine(
  (value) => serializedWithin(value, MAX_DECISION_RESPONSE_BYTES),
  `Budget response exceeds ${MAX_DECISION_RESPONSE_BYTES} UTF-8 bytes`,
);

const CancelResponseSchema = z.strictObject({
  type: z.literal("cancel"),
  reason: boundedString(4 * KIB, { nonempty: true }),
  cancelledBy: ActorSchema.optional(),
}).refine(
  (value) => serializedWithin(value, MAX_DECISION_RESPONSE_BYTES),
  `Cancel response exceeds ${MAX_DECISION_RESPONSE_BYTES} UTF-8 bytes`,
);

const HitlResponseSchema: z.ZodType<HitlResponse> = z.union([
  QuestionAnswerResponseSchema,
  PermissionDecisionResponseSchema,
  BudgetDecisionResponseSchema,
  CancelResponseSchema,
]);

const SessionToolCallBlockerSchema: z.ZodType<PersistedSessionToolCallBlocker> = z.union([
  z.strictObject({
    requestKey: IdentifierSchema,
    hitlId: IdentifierSchema.optional(),
    source: AskUserSourceSchema,
    displayPayload: HitlDisplayPayloadSchema,
    responseAppliedAt: TimestampSchema.optional(),
    response: HitlResponseSchema.optional(),
  }),
  z.strictObject({
    requestKey: IdentifierSchema,
    hitlId: IdentifierSchema.optional(),
    source: PermissionSourceSchema,
    displayPayload: HitlDisplayPayloadSchema,
    permissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    persistentApprovalEligible: z.boolean(),
    permission: PermissionDetailsSchema,
    responseAppliedAt: TimestampSchema.optional(),
    response: HitlResponseSchema.optional(),
  }),
]).superRefine((blocker, ctx) => {
  if ((blocker.responseAppliedAt !== undefined) !== (blocker.response !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["response"], message: "Accepted blocker response and timestamp must be present together" });
  }
  if (blocker.response !== undefined && !responseMatchesSource(blocker.source, blocker.response)) {
    ctx.addIssue({ code: "custom", path: ["response", "type"], message: `${blocker.response.type} does not answer ${blocker.source.type}` });
  }
}).refine(
  (blocker) => serializedWithin(toolBlockedRequestFromSessionBlocker(blocker), MAX_BLOCKED_REQUEST_BYTES),
  `Tool blocked request exceeds ${MAX_BLOCKED_REQUEST_BYTES} UTF-8 bytes`,
).refine(
  (blocker) => serializedWithin(blocker, MAX_RECORD_BYTES),
  `Session HITL blocker exceeds ${MAX_RECORD_BYTES} UTF-8 bytes`,
);

const HitlDeliverySchema = z.strictObject({
  attempts: z.number().int().min(0).max(3),
  retryAt: TimestampSchema.optional(),
  error: boundedString(2 * KIB, { nonempty: true }).optional(),
}).superRefine((delivery, ctx) => {
  if (delivery.retryAt !== undefined && delivery.error === undefined) {
    ctx.addIssue({ code: "custom", path: ["retryAt"], message: "retryAt requires a delivery error" });
  }
});

const CreateHitlInputSchema = z.strictObject({
  requestKey: IdentifierSchema,
  owner: HitlOwnerSchema,
  source: HitlSourceSchema,
  displayPayload: HitlDisplayPayloadSchema,
  persistentApprovalEligible: z.boolean().optional(),
  hitlId: IdentifierSchema.optional(),
  createdAt: TimestampSchema.optional(),
}).superRefine((value, ctx) => {
  validateOwnerSource(value.owner, value.source, ctx);
  if (value.persistentApprovalEligible !== undefined && value.source.type !== "tool_permission") {
    ctx.addIssue({ code: "custom", path: ["persistentApprovalEligible"], message: "Persistent approval eligibility belongs only to tool_permission HITL" });
  }
});

const HitlRecordSchema = z.strictObject({
  hitlId: IdentifierSchema,
  requestKey: IdentifierSchema,
  owner: HitlOwnerSchema,
  source: HitlSourceSchema,
  status: z.enum(["pending", "answered", "resolved", "cancelled"]),
  displayPayload: HitlDisplayPayloadSchema,
  persistentApprovalEligible: z.boolean().optional(),
  response: HitlResponseSchema.optional(),
  delivery: HitlDeliverySchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
}).superRefine((record, ctx) => {
  validateOwnerSource(record.owner, record.source, ctx);
  if (record.persistentApprovalEligible !== undefined && record.source.type !== "tool_permission") {
    ctx.addIssue({ code: "custom", path: ["persistentApprovalEligible"], message: "Persistent approval eligibility belongs only to tool_permission HITL" });
  }
  const hasAcceptedResponse = record.status !== "pending";
  if (hasAcceptedResponse !== (record.response !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["response"], message: `${record.status} has invalid response presence` });
  }
  if (record.response !== undefined && !responseMatchesSource(record.source, record.response)) {
    ctx.addIssue({ code: "custom", path: ["response"], message: `${record.response.type} does not answer ${record.source.type}` });
  }
  const terminal = record.status === "resolved" || record.status === "cancelled";
  if (terminal !== (record.resolvedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["resolvedAt"], message: `${record.status} has invalid resolvedAt presence` });
  }
  if (record.delivery !== undefined && record.status !== "answered") {
    ctx.addIssue({ code: "custom", path: ["delivery"], message: "Only answered HITL may carry delivery metadata" });
  }
}).refine(
  (record) => serializedWithin(record, MAX_RECORD_BYTES),
  `HITL record exceeds ${MAX_RECORD_BYTES} UTF-8 bytes`,
);

const ProjectHitlFileSchema = z.strictObject({
  records: z.array(HitlRecordSchema),
  updatedAt: TimestampSchema,
}).superRefine((file, ctx) => {
  const hitlIds = new Set<string>();
  const requestKeys = new Set<string>();
  file.records.forEach((record, index) => {
    if (hitlIds.has(record.hitlId)) ctx.addIssue({ code: "custom", path: ["records", index, "hitlId"], message: "Duplicate hitlId" });
    if (requestKeys.has(record.requestKey)) ctx.addIssue({ code: "custom", path: ["records", index, "requestKey"], message: "Duplicate requestKey" });
    hitlIds.add(record.hitlId);
    requestKeys.add(record.requestKey);
  });
});

/** The single strict and secret-safe boundary for all durable HITL data. */
export class HitlBoundaryCodec {
  /** Strict durable Session blocker schema; Store persistence must reuse this owner. */
  static readonly sessionToolCallBlockerSchema: z.ZodType<PersistedSessionToolCallBlocker> = SessionToolCallBlockerSchema;

  constructor(readonly redactionPolicy: HitlRedactionPolicy) {}

  parseBlockedRequest(value: unknown): ToolBlockedRequest {
    return ToolBlockedRequestSchema.parse(this.redactBlockedRequest(value));
  }

  createAskUserRequest(input: {
    readonly toolCallId: string;
    readonly displayPayload: HitlDisplayPayload;
  }): Extract<ToolBlockedRequest, { source: { type: "ask_user" } }> {
    return this.parseBlockedRequest({
      source: { type: "ask_user", toolCallId: input.toolCallId },
      displayPayload: input.displayPayload,
    }) as Extract<ToolBlockedRequest, { source: { type: "ask_user" } }>;
  }

  createPermissionRequest(input: PermissionToolBlockedRequest): PermissionToolBlockedRequest {
    return this.parseBlockedRequest(input) as PermissionToolBlockedRequest;
  }

  createToolRequestKey(input: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly request: ToolBlockedRequest;
  }): string {
    const binding = this.#parseToolRequestBinding(input);
    return `tool:${createHash("sha256")
      .update(JSON.stringify(sortJsonValue(binding)))
      .digest("hex")}`;
  }

  assertToolRequestKey(input: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly requestKey: string;
    readonly request: ToolBlockedRequest;
  }): void {
    const requestKey = IdentifierSchema.parse(input.requestKey);
    const expected = this.createToolRequestKey(input);
    if (requestKey !== expected) throw new TypeError("Tool blocked request key mismatch");
  }

  sameBlockedRequest(left: ToolBlockedRequest, right: ToolBlockedRequest): boolean {
    const parsedLeft = this.parseBlockedRequest(left);
    const parsedRight = this.parseBlockedRequest(right);
    return JSON.stringify(sortJsonValue(parsedLeft)) === JSON.stringify(sortJsonValue(parsedRight));
  }

  redactFailure(error: unknown): RedactedHitlFailure {
    try {
      const record = isRecord(error) ? error : undefined;
      const rawName = error instanceof Error
        ? error.name
        : typeof record?.name === "string"
          ? record.name
          : "NonErrorThrow";
      const rawCode = typeof record?.code === "string" ? record.code : "HITL_DELIVERY_FAILED";
      const rawMessage = error instanceof Error
        ? error.message
        : typeof record?.message === "string"
          ? record.message
          : String(error);
      return {
        name: boundRedacted(this.redactionPolicy, rawName || "Error", MAX_IDENTIFIER_BYTES),
        code: boundRedacted(this.redactionPolicy, rawCode, MAX_IDENTIFIER_BYTES),
        message: boundRedacted(this.redactionPolicy, rawMessage, 2 * KIB),
      };
    } catch {
      return {
        name: "Error",
        code: "HITL_DELIVERY_FAILED",
        message: "HITL delivery failed",
      };
    }
  }

  parseResponse(value: unknown): HitlResponse {
    return HitlResponseSchema.parse(this.redactionPolicy.redactValue(value));
  }

  parseResponseForRequest(request: ToolBlockedRequest, value: unknown): HitlResponse {
    const parsedRequest = this.parseBlockedRequest(request);
    return this.parseResponseForSource(parsedRequest.source, value);
  }

  parseResponseForSource(source: HitlSource, value: unknown): HitlResponse {
    const parsedSource = HitlSourceSchema.parse(source);
    const response = this.parseResponse(value);
    if (!responseMatchesSource(parsedSource, response)) {
      throw new z.ZodError([{
        code: "custom",
        path: ["type"],
        message: `${response.type} does not answer ${parsedSource.type}`,
        input: response,
      }]);
    }
    return response;
  }

  parseCreateInput(value: unknown): CreateHitlInput {
    return CreateHitlInputSchema.parse(this.redactCreateInput(value)) as CreateHitlInput;
  }

  parseDelivery(value: unknown): HitlDelivery {
    return HitlDeliverySchema.parse(this.redactDelivery(value)) as HitlDelivery;
  }

  parseRecord(value: unknown): HitlRecord {
    return HitlRecordSchema.parse(this.redactRecord(value)) as HitlRecord;
  }

  parseProjectFile(value: unknown): ProjectHitlFile {
    if (!isRecord(value) || !Array.isArray(value.records)) return ProjectHitlFileSchema.parse(value) as ProjectHitlFile;
    return ProjectHitlFileSchema.parse({
      ...value,
      records: value.records.map((record) => this.redactRecord(record)),
    }) as ProjectHitlFile;
  }

  private redactBlockedRequest(value: unknown): unknown {
    if (!isRecord(value)) return value;
    return {
      ...value,
      displayPayload: this.redactionPolicy.redactValue(value.displayPayload),
      ...(isRecord(value.permission)
        ? { permission: this.redactionPolicy.redactValue(value.permission) }
        : {}),
    };
  }

  private redactCreateInput(value: unknown): unknown {
    if (!isRecord(value)) return value;
    return {
      ...value,
      displayPayload: this.redactionPolicy.redactValue(value.displayPayload),
    };
  }

  private redactDelivery(value: unknown): unknown {
    if (!isRecord(value)) return value;
    return {
      ...value,
      ...(typeof value.error === "string"
        ? { error: this.redactionPolicy.redactString(value.error) }
        : {}),
    };
  }

  private redactRecord(value: unknown): unknown {
    if (!isRecord(value)) return value;
    return {
      ...value,
      displayPayload: this.redactionPolicy.redactValue(value.displayPayload),
      ...(value.response === undefined ? {} : { response: this.redactionPolicy.redactValue(value.response) }),
      ...(value.delivery === undefined ? {} : { delivery: this.redactDelivery(value.delivery) }),
    };
  }

  #parseToolRequestBinding(input: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly request: ToolBlockedRequest;
  }) {
    const sessionId = IdentifierSchema.parse(input.sessionId);
    const toolCallId = IdentifierSchema.parse(input.toolCallId);
    const toolName = IdentifierSchema.parse(input.toolName);
    const request = this.parseBlockedRequest(input.request);
    if (request.source.toolCallId !== toolCallId) throw new TypeError("Blocked request tool call mismatch");
    if (request.source.type === "tool_permission" && request.source.toolName !== toolName) {
      throw new TypeError("Blocked request tool name mismatch");
    }
    if (request.source.type === "ask_user" && toolName !== "ask_user") {
      throw new TypeError("ask_user blocked request used by a different tool");
    }
    return { sessionId, toolCallId, toolName, request };
  }
}

function toolBlockedRequestFromSessionBlocker(blocker: PersistedSessionToolCallBlocker): ToolBlockedRequest {
  if (blocker.source.type === "ask_user") {
    return { source: blocker.source, displayPayload: blocker.displayPayload };
  }
  if (blocker.permissionFingerprint === undefined || blocker.persistentApprovalEligible === undefined || blocker.permission === undefined) {
    throw new TypeError("Persisted permission blocker is incomplete");
  }
  return {
    source: blocker.source,
    displayPayload: blocker.displayPayload,
    permissionFingerprint: blocker.permissionFingerprint,
    persistentApprovalEligible: blocker.persistentApprovalEligible,
    permission: blocker.permission,
  };
}

function validateOwnerSource(
  owner: { type: "session" | "goal" },
  source: HitlSource,
  ctx: z.core.$RefinementCtx,
): void {
  const sessionSource = source.type === "ask_user" || source.type === "tool_permission";
  if ((owner.type === "session") !== sessionSource) {
    ctx.addIssue({ code: "custom", path: ["source"], message: `${source.type} does not belong to ${owner.type}` });
  }
}

function responseMatchesSource(source: HitlSource, response: HitlResponse): boolean {
  return response.type === "cancel"
    || (source.type === "ask_user" && response.type === "question_answer")
    || (source.type === "tool_permission" && response.type === "permission_decision")
    || (source.type === "goal_budget" && response.type === "budget_decision");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundRedacted(policy: HitlRedactionPolicy, value: string, maxBytes: number): string {
  const redacted = policy.redactString(value);
  if (utf8Bytes(redacted) <= maxBytes) return redacted;
  const bytes = new TextEncoder().encode(redacted);
  return new TextDecoder().decode(bytes.subarray(0, safeUtf8End(bytes, maxBytes)));
}

function safeUtf8End(bytes: Uint8Array, maxBytes: number): number {
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}
