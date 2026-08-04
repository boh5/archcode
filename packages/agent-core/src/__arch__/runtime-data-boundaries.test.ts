import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), "utf8");
}

describe("Runtime data ownership boundaries", () => {
  test("inspection is an adapter over the five current domain schema owners", () => {
    const service = source("runtime-data/service.ts");
    const ownerImports = [
      ["SessionFileSchema", "../store/helpers"],
      ["ProjectTodoStateFileSchema", "../todos/schema"],
      ["AutomationStateFileSchema", "../automations/schema"],
      ["HitlBoundaryCodec", "../hitl/boundary-codec"],
      ["PermissionApprovalFileSchema", "../tools/permission/project-approvals"],
    ] as const;

    for (const [owner, importPath] of ownerImports) {
      expect(service).toContain(owner);
      expect(service).toContain(`from "${importPath}"`);
    }
    expect(service).not.toMatch(/from\s+["']zod(?:\/v\d+)?["']/);
    expect(service).not.toMatch(/\b(?:version|migration)\b/i);
    expect(service).not.toMatch(/\b(?:Schema|Validator|Repair|Migration)Registry\b/);
  });

  test("AgentRuntime consumes the process-owned ProjectRegistry", () => {
    const runtime = source("runtime.ts");

    expect(runtime).toMatch(/projectRegistry:\s*ProjectRegistry;/);
    expect(runtime).toContain("const projectRegistry = options.projectRegistry;");
  });
});
