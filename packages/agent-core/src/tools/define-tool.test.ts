import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "./define-tool";
import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createTestProjectContext } from "./test-project-context";
import type {
  ToolDescriptor,
  ToolExecutionContext,
  ToolPermission,
  PermissionDecision,
} from "./types";

// Minimal mock for ToolExecutionContext
function mockCtx(): ToolExecutionContext {
  return {
    store: {} as any,
    storeManager,
    toolName: "test",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(),
    agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }),
    workspaceRoot: "/tmp",
    projectContext: createTestProjectContext("/tmp"),
  };
}

describe("defineTool", () => {
  test("returns a ToolDescriptor with all fields preserved", () => {
    const schema = z.object({ path: z.string() }).strict();

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file contents",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `contents of ${input.path}`;
      },
    });

    expect(descriptor.name).toBe("file_read");
    expect(descriptor.description).toBe("Read file contents");
    expect(descriptor.inputSchema).toBe(schema);
    expect(descriptor.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(descriptor.hooks).toBeUndefined();
    expect(typeof descriptor.execute).toBe("function");
  });

  test("executor receives inferred input and returns string", async () => {
    const schema = z
      .object({ path: z.string(), encoding: z.string().optional() })
      .strict();

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        // input.path is inferred as string
        return `read: ${input.path}`;
      },
    });

    const result = await descriptor.execute(
      { path: "/tmp/test.txt" },
      mockCtx(),
    );
    expect(result).toBe("read: /tmp/test.txt");
  });

  test("preserves per-tool hooks", () => {
    const schema = z.object({ x: z.number() }).strict();
    const beforeFn = async (_input: unknown, _ctx: ToolExecutionContext) => {
      return { x: 42 };
    };
    const afterFn = async (
      result: { output: string; isError: boolean },
      _ctx: ToolExecutionContext,
    ) => {
      return { ...result, output: result.output.toUpperCase() };
    };

    const descriptor = defineTool({
      name: "compute",
      description: "Compute something",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: false,
      },
      hooks: {
        before: [beforeFn],
        after: [afterFn],
      },
      async execute(input, _ctx) {
        return `result: ${input.x}`;
      },
    });

    expect(descriptor.hooks?.before).toHaveLength(1);
    expect(descriptor.hooks?.after).toHaveLength(1);
    expect(descriptor.hooks?.before![0]).toBe(beforeFn);
    expect(descriptor.hooks?.after![0]).toBe(afterFn);
  });

  test("works with sync executor", async () => {
    const schema = z.object({ msg: z.string() }).strict();

    const descriptor = defineTool({
      name: "echo",
      description: "Echo input",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      execute(input, _ctx) {
        return input.msg;
      },
    });

    const result = await descriptor.execute({ msg: "hello" }, mockCtx());
    expect(result).toBe("hello");
  });

  test("executor can throw and error propagates", async () => {
    const schema = z.object({ path: z.string() }).strict();

    const descriptor = defineTool({
      name: "fail_tool",
      description: "Always fails",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(_input, _ctx) {
        throw new Error("tool failed");
      },
    });

    expect(
      descriptor.execute({ path: "/bad" }, mockCtx()),
    ).rejects.toThrow("tool failed");
  });

  test("compile-time: accessing non-existent property on input is rejected", () => {
    const schema = z.object({ path: z.string() }).strict();

    const _descriptor = defineTool({
      name: "type_check",
      description: "Type safety check",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        // @ts-expect-error — 'nonexistent' does not exist on '{ path: string }'
        return input.nonexistent;
      },
    });
  });

  test("preserves prepareInput function", () => {
    const schema = z.object({ path: z.string() }).strict();

    const prepareInput = async (
      raw: unknown,
      _ctx: ToolExecutionContext,
    ) => {
      if (typeof raw === "object" && raw !== null && "path" in raw) {
        return { path: String((raw as any).path) };
      }
      return raw;
    };

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      prepareInput,
      async execute(input, _ctx) {
        return `read: ${input.path}`;
      },
    });

    expect(descriptor.prepareInput).toBe(prepareInput);
    expect(typeof descriptor.prepareInput!).toBe("function");

    const result = descriptor.prepareInput!({ path: "test.txt" }, mockCtx());
    expect(result).resolves.toEqual({ path: "test.txt" });
  });

  test("preserves permissions array", () => {
    const schema = z.object({ path: z.string() }).strict();

    const permissionFn: ToolPermission = async (
      _input: unknown,
      _ctx: ToolExecutionContext,
    ): Promise<PermissionDecision> => {
      return { outcome: "allow" };
    };

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      permissions: [permissionFn],
      async execute(input, _ctx) {
        return `read: ${input.path}`;
      },
    });

    expect(descriptor.permissions).toHaveLength(1);
    expect(descriptor.permissions![0]).toBe(permissionFn);
  });

  test("preserves both prepareInput and permissions with hooks", () => {
    const schema = z.object({ x: z.number() }).strict();

    const prepareInput = async (
      raw: unknown,
      _ctx: ToolExecutionContext,
    ) => {
      if (typeof raw === "object" && raw !== null && "x" in raw) {
        return { x: Number((raw as any).x) };
      }
      return raw;
    };

    const permissionFn: ToolPermission = async (
      _input: unknown,
      _ctx: ToolExecutionContext,
    ): Promise<PermissionDecision> => {
      return { outcome: "allow" };
    };

    const beforeFn = async (_input: unknown, _ctx: ToolExecutionContext) => {
      return { x: 42 };
    };

    const descriptor = defineTool({
      name: "compute",
      description: "Compute",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: false,
      },
      hooks: { before: [beforeFn] },
      prepareInput,
      permissions: [permissionFn],
      async execute(input, _ctx) {
        return `result: ${input.x}`;
      },
    });

    expect(descriptor.prepareInput).toBe(prepareInput);
    expect(descriptor.permissions).toHaveLength(1);
    expect(descriptor.permissions![0]).toBe(permissionFn);
    expect(descriptor.hooks?.before).toHaveLength(1);
    expect(typeof descriptor.execute).toBe("function");

    const minimal = defineTool({
      name: "minimal",
      description: "Minimal",
      inputSchema: schema,
      traits: {
        readOnly: false,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `ok ${input.x}`;
      },
    });

    expect(minimal.prepareInput).toBeUndefined();
    expect(minimal.permissions).toBeUndefined();
    expect(minimal.hooks).toBeUndefined();
  });

  test("returns a value assignable to ToolDescriptor", () => {
    const schema = z.object({ url: z.string() }).strict();

    const descriptor: ToolDescriptor<{ url: string }> = defineTool({
      name: "fetch",
      description: "Fetch URL",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `fetched ${input.url}`;
      },
    });

    expect(descriptor.name).toBe("fetch");
  });
});

// ─── Permission API contract (TDD red phase) ───

describe("Permission API contract — defineTool", () => {
  test("descriptor has 'permissions' field instead of 'guards'", () => {
    const schema = z.object({ path: z.string() }).strict();

    const permissionFn: ToolPermission = async (
      _input: unknown,
      _ctx: ToolExecutionContext,
    ): Promise<PermissionDecision> => {
      return { outcome: "allow" };
    };

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      permissions: [permissionFn],
      async execute(input, _ctx) {
        return `read: ${input.path}`;
      },
    });

    expect(Array.isArray(descriptor.permissions)).toBe(true);
    expect(descriptor.permissions).toHaveLength(1);
    expect(descriptor.permissions![0]).toBe(permissionFn);
  });



  test("permissions is optional and defaults to undefined", () => {
    const schema = z.object({ path: z.string() }).strict();

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `read: ${input.path}`;
      },
    });

    expect(descriptor.permissions).toBeUndefined();
  });

  test("permissions array can contain multiple ToolPermission functions", () => {
    const schema = z.object({ path: z.string() }).strict();

    const perm1: ToolPermission = async () => ({ outcome: "allow" });
    const perm2: ToolPermission = async () => ({ outcome: "ask", reason: "confirm" });

    const descriptor = defineTool({
      name: "file_write",
      description: "Write file",
      inputSchema: schema,
      traits: {
        readOnly: false,
        destructive: true,
        concurrencySafe: false,
      },
      permissions: [perm1, perm2],
      async execute(input, _ctx) {
        return `wrote: ${input.path}`;
      },
    });

    expect(descriptor.permissions).toHaveLength(2);
    expect(descriptor.permissions![0]).toBe(perm1);
    expect(descriptor.permissions![1]).toBe(perm2);
  });

  test("ToolPermission type is the new name for GuardHook", () => {
    const perm: ToolPermission = async (_input, _ctx) => {
      return { outcome: "deny", reason: "not allowed" };
    };
    expect(typeof perm).toBe("function");
  });

  test("PermissionDecision type is the new name for GuardDecision", () => {
    const allow: PermissionDecision = { outcome: "allow" };
    const deny: PermissionDecision = { outcome: "deny", reason: "blocked" };
    const ask: PermissionDecision = { outcome: "ask", reason: "confirm?" };
    const structured: PermissionDecision = {
      outcome: "deny",
      reason: "outside workspace",
      errorKind: "workspace",
      errorCode: "TOOL_FILE_OUTSIDE_WORKSPACE",
    };

    expect(allow.outcome).toBe("allow");
    expect(deny.outcome).toBe("deny");
    expect(ask.outcome).toBe("ask");
    expect(structured.errorKind).toBe("workspace");
    expect(structured.errorCode).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
  });

  test("defineTool config accepts 'permissions' instead of 'guards'", () => {
    const schema = z.object({ path: z.string() }).strict();

    const perm: ToolPermission = async () => ({ outcome: "allow" });

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      traits: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      permissions: [perm],
      async execute(input, _ctx) {
        return `read: ${input.path}`;
      },
    });

    expect(descriptor.permissions).toHaveLength(1);
  });



  test("destructive tool descriptor without permissions is structurally valid but rejected by registry", () => {
    const descriptor = defineTool({
      name: "nuke",
      description: "Nukes everything",
      inputSchema: z.object({}).strict(),
      traits: {
        readOnly: false,
        destructive: true,
        concurrencySafe: false,
      },
      async execute() {
        return "nuked";
      },
    });

    expect(descriptor.traits.destructive).toBe(true);
    expect(descriptor.permissions).toBeUndefined();
  });

  test("destructive tool descriptor with permissions is structurally valid", () => {
    const perm: ToolPermission = async () => ({ outcome: "allow" });

    const descriptor = defineTool({
      name: "bash",
      description: "Run bash",
      inputSchema: z.object({}).strict(),
      traits: {
        readOnly: false,
        destructive: true,
        concurrencySafe: false,
      },
      permissions: [perm],
      async execute() {
        return "ok";
      },
    });

    expect(descriptor.traits.destructive).toBe(true);
    expect(descriptor.permissions).toHaveLength(1);
  });
});
