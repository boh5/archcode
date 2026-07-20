import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { engineerAgentDefinition } from "../../agents/definitions";
import { registerBuiltinTools } from "../../core/register-tools";
import { silentLogger } from "../../logger";
import { createTestToolRegistryFixture } from "../test-registry";

type JsonObject = Record<string, unknown>;

interface SchemaContract {
  readonly path: readonly string[];
  readonly descriptionPatterns?: readonly RegExp[];
  readonly expectedEnum?: readonly string[];
}

interface ModelVisibleContract {
  readonly tool: string;
  readonly competitorEvidenceIds: readonly string[];
  readonly runtimeSourceIds: readonly string[];
  readonly descriptionPatterns: readonly RegExp[];
  readonly descriptionExcludes?: readonly RegExp[];
  readonly schema?: readonly SchemaContract[];
}

const CONTRACTS: readonly ModelVisibleContract[] = [
  {
    tool: "file_read",
    competitorEvidenceIds: ["CC-160-A:Read", "OC:read", "GB:read_file"],
    runtimeSourceIds: ["tools/builtins/file-read.ts:12-24,34-40,43-88,103-155"],
    descriptionPatterns: [
      /N: content/,
      /offset is 1-based/,
      /50KB source window/,
      /glob.*grep.*file_read/i,
      /several known files are independent/i,
      /Avoid tiny repeated slices/,
      /larger than 10MB.*rejected/i,
      /binary files.*not displayed/i,
      /relative paths resolve from the current Session cwd/i,
    ],
    schema: [
      { path: ["properties", "path"], descriptionPatterns: [/workspace-relative/, /packages\/agent-core\/src\/runtime\.ts/, /current Session cwd/i] },
      { path: ["properties", "offset"], descriptionPatterns: [/1-based/, /example 120/, /before the 50KB source window/] },
      { path: ["properties", "limit"], descriptionPatterns: [/Maximum number of lines/, /example 160/, /50KB source window/] },
    ],
  },
  {
    tool: "file_write",
    competitorEvidenceIds: ["CC-B:Write", "OC:write", "GEMINI3:write_file"],
    runtimeSourceIds: ["tools/builtins/file-write.ts:15-50", "utils/safe-file.ts:14-40"],
    descriptionPatterns: [/new text file/i, /missing parent directories/i, /complete final content/i, /file_write\(/, /fails rather than overwriting/i, /file_edit/],
    schema: [
      { path: ["properties", "path"], descriptionPatterns: [/current-Session-cwd-relative/i, /src\/new-module\.ts/, /parent directories.*automatically/i] },
      { path: ["properties", "content"], descriptionPatterns: [/Complete text content/i, /placeholders, ellipses/i] },
    ],
  },
  {
    tool: "file_edit",
    competitorEvidenceIds: ["CC-160-A:Edit", "OC:edit", "GB:search_replace"],
    runtimeSourceIds: ["tools/builtins/file-edit.ts:196-313,318-374"],
    descriptionPatterns: [/Read the file first/, /file_edit\(/, /line-number prefix/, /no match.*re-read/i, /multiple matches.*surrounding context/i, /lsp_diagnostics/, /test\/build command/, /same pre-edit file/, /atomic write/],
    schema: [
      { path: ["properties", "edits"], descriptionPatterns: [/same pre-edit file/, /atomic write/] },
      {
        path: ["properties", "edits", "items", "properties", "oldString"],
        descriptionPatterns: [
          /line-number prefixes/,
          /Preserve leading indentation/,
          /one location/,
          /re-read after no match/,
          /surrounding context after multiple matches/,
        ],
      },
    ],
  },
  {
    tool: "grep",
    competitorEvidenceIds: ["CC-160-A:Grep", "OC:grep", "GB:grep"],
    runtimeSourceIds: ["tools/builtins/grep.ts:14-21,34-118"],
    descriptionPatterns: [/ripgrep regular expressions/, /Prefer this tool to `rg` or `grep` through bash/, /Use glob.*file names/i, /grep\(/, /file_read/, /files_with_matches/, /per-file counts/, /100 entries/, /delegate.*Explore/i],
    schema: [
      { path: ["properties", "output_mode"], descriptionPatterns: [/content/, /files_with_matches/, /count/, /100 entries/], expectedEnum: ["content", "files_with_matches", "count"] },
      { path: ["properties", "context"], descriptionPatterns: [/before and after/, /content/] },
    ],
  },
  {
    tool: "glob",
    competitorEvidenceIds: ["CC-160-A:Glob", "OC:glob"],
    runtimeSourceIds: ["tools/builtins/glob.ts:13-18,30-76"],
    descriptionPatterns: [/file-name or path glob/, /not by file contents/, /glob\(/, /glob.*grep.*file_read/i, /delegate.*Explore/i],
    schema: [
      { path: ["properties", "pattern"], descriptionPatterns: [/Glob pattern/, /\*\*\/\*\.ts/] },
    ],
  },
  {
    tool: "git_status",
    competitorEvidenceIds: ["OC-CURRENT:shell Git workflow"],
    runtimeSourceIds: ["tools/builtins/git-status.ts:17-32,75-101"],
    descriptionPatterns: [/before editing, staging, committing, or reviewing/i, /porcelain status/, /untracked paths/, /git_status.*git_diff.*staged=false.*staged=true/i, /file_read/, /git-master Skill/],
  },
  {
    tool: "git_diff",
    competitorEvidenceIds: ["OC-CURRENT:shell Git workflow"],
    runtimeSourceIds: ["tools/builtins/git-diff.ts:10-28,62-86"],
    descriptionPatterns: [/tracked-file changes/, /three context lines/, /staged=false/, /staged=true/, /does not show.*untracked files/i, /git_status/, /file_read/],
    schema: [
      { path: ["properties", "staged"], descriptionPatterns: [/unstaged/, /staged\/cached/, /both views/] },
    ],
  },
  {
    tool: "bash",
    competitorEvidenceIds: ["CC-160-A:Bash", "OC:shell", "GB:bash"],
    runtimeSourceIds: ["tools/builtins/bash.ts:22-129", "process/runner.ts:79-94"],
    descriptionPatterns: [/builds, tests, package managers, Git, or project CLIs/i, /Do not use it to read, write, edit, search, or find files/i, /bash\(/, /bun run test:unit/, /fresh shell/, /do not persist/, /stdin is closed/, /git-master Skill/, /Do not commit, amend, push, force-push, or rewrite history/i, /nonzero exit.*failed result/i, /no wrapper timeout/, /STDOUT/, /timeout, abort, signal/i],
    schema: [
      { path: ["properties", "command"], descriptionPatterns: [/bun run test:unit/, /&&/, /;/] },
      { path: ["properties", "cwd"], descriptionPatterns: [/Per-call/, /packages\/agent-core/, /inside the workspace/] },
      { path: ["properties", "timeoutMs"], descriptionPatterns: [/milliseconds/, /600000/, /omitting it means no ArchCode wrapper timeout/] },
    ],
  },
  {
    tool: "todo_write",
    competitorEvidenceIds: ["CC-160-A:TaskCreate/TaskUpdate", "OC:todowrite"],
    runtimeSourceIds: ["tools/builtins/todo-write.ts:12-23,66-110"],
    descriptionPatterns: [/complete todo list/, /three distinct conceptual steps/, /multiple user-visible deliverables/, /Do not use it for a single localized edit/, /one command followed by a report/, /todo_write\(/, /\"id\":\"inspect-contract\"/, /generated ids are not returned/i, /same ids/i, /work state changes/, /blocked or only partially done/, /preserve existing ids/i, /exact user-provided commands or flags/, /exactly one.*in_progress/, /verification.*finished/],
    schema: [
      { path: ["properties", "todos"], descriptionPatterns: [/Full replacement list/, /Omitting an existing item removes it/] },
      { path: ["properties", "todos", "items", "properties", "id"], descriptionPatterns: [/Provide one on the first call/, /not returned to the model/] },
      { path: ["properties", "todos", "items", "properties", "content"], descriptionPatterns: [/commands, flags, arguments, and ordering verbatim/] },
      { path: ["properties", "todos", "items", "properties", "status"], descriptionPatterns: [/completed.*verified/, /cancelled/] },
    ],
  },
  {
    tool: "ask_user",
    competitorEvidenceIds: ["CC-160-A:AskUserQuestion", "OC:question"],
    runtimeSourceIds: ["tools/builtins/ask-user.ts:10-27,35-109,138-146"],
    descriptionPatterns: [/preferences, requirements, or implementation choices/, /Investigate first/, /facts available from the request, repository, tool output/, /sensible reversible default/, /\(Recommended\)/, /do not add an `Other` option/i],
    schema: [
      { path: ["properties", "questions", "items", "properties", "options"], descriptionPatterns: [/Do not add an `Other` option/, /recommended (?:choice|option) first/] },
      { path: ["properties", "questions", "items", "properties", "custom"], descriptionPatterns: [/free-text answer choice/, /default/] },
    ],
  },
  {
    tool: "delegate",
    competitorEvidenceIds: ["CC-160-A:Agent", "OC:task", "OMO-D", "CX-MA:spawn_agent"],
    runtimeSourceIds: ["tools/builtins/delegate.ts", "delegation/schema.ts", "execution/session-execution-manager.ts"],
    descriptionPatterns: [/direct child Session/i, /complete DelegationContract/, /independently owned/, /independently verifiable/, /no dependency/, /no overlapping owned scope/, /durable contract/, /resume_session/, /background=true/, /background=false/, /canonical result receipt/, /terminal reminder/, /background_output/],
    schema: [
      { path: ["properties", "agent_type"], expectedEnum: ["plan", "build", "reviewer", "explore", "librarian"] },
      { path: ["properties", "objective"] },
      { path: ["properties", "owned_scope"] },
      { path: ["properties", "owned_scope", "items", "properties", "kind"], expectedEnum: ["file", "tree"] },
      { path: ["properties", "non_goals"] },
      { path: ["properties", "acceptance_criteria"] },
      { path: ["properties", "evidence"] },
      { path: ["properties", "verification"] },
      { path: ["properties", "depends_on"] },
      { path: ["properties", "skills"] },
      { path: ["properties", "background"] },
    ],
  },
  {
    tool: "background_output",
    competitorEvidenceIds: ["CC-160-A:TaskOutput", "OMO-B", "GB:task_output"],
    runtimeSourceIds: ["tools/builtins/background-output.ts"],
    descriptionPatterns: [/status/, /canonical result receipt/, /direct child Session/, /never treats assistant text as a child result/i, /terminal execution without result_receipt/i, /block=true/, /terminal reminder/, /do not poll/i, /background_output\(/, /status is still running.*not a final deliverable/i, /full_session=true/, /50 KiB/, /2,000 lines/, /exact schema-valid nextInput/, /without an artifact or silent truncation/i],
    schema: [
      { path: ["properties", "session_id"], descriptionPatterns: [/delegate, resume_session, a terminal reminder, or a prior child result/i, /must not be the current Session ID/i] },
      { path: ["properties", "block"], descriptionPatterns: [/Default false/, /waits while the Session is running/] },
      { path: ["properties", "timeout_ms"], descriptionPatterns: [/0 to 1800000/, /Default 1800000/, /30 minutes/] },
      { path: ["properties", "full_session"], descriptionPatterns: [/latest assistant message/, /filtered stored messages/, /Default false/] },
      { path: ["properties", "cursor"], descriptionPatterns: [/Exact forward cursor/, /nextInput/, /Do not construct or modify/] },
      { path: ["properties", "include_tool_results"], descriptionPatterns: [/unified tool previews/, /strict details/, /recovery references/, /default/i] },
      { path: ["properties", "include_reasoning"], descriptionPatterns: [/assistant reasoning/, /default/i] },
    ],
  },
  {
    tool: "wait_for_reminder",
    competitorEvidenceIds: ["OMO-B", "CX-MA:wait_agent"],
    runtimeSourceIds: ["tools/builtins/wait-for-reminder.ts:6-17,39-127,130-185"],
    descriptionPatterns: [/Wait once/, /not as a polling loop/i, /wait_for_reminder\(/, /condition.*all/, /first two distinct Sessions/i, /consum/, /not the canonical child receipts/i, /background_output.*block=true/i, /do not poll/i],
    schema: [
      { path: ["properties", "session_ids"], descriptionPatterns: [/all independent children.*one call/i] },
      { path: ["properties", "condition"], descriptionPatterns: [/`any`.*one requested Session/i, /`all`.*every distinct requested Session/i, /count: N.*first N distinct requested Sessions/i] },
      { path: ["properties", "condition", "anyOf", "1", "properties", "count"], descriptionPatterns: [/Positive number/, /distinct requested Sessions/i, /Do not exceed.*distinct session_ids/i] },
      { path: ["properties", "timeout_ms"], descriptionPatterns: [/1000 to 1800000/, /Default 1800000/, /30 minutes/] },
    ],
  },
  {
    tool: "memory_read",
    competitorEvidenceIds: ["GB:memory_search/memory_get"],
    runtimeSourceIds: ["tools/builtins/memory-read.ts:19-23,117-135"],
    descriptionPatterns: [/prior work|historical work/, /decisions/, /preferences/, /unfamiliar/, /compaction/],
    schema: [
      { path: ["properties", "name"], descriptionPatterns: [/combined.*context/, /preferences/, /index/, /topic/] },
    ],
  },
  {
    tool: "create_goal",
    competitorEvidenceIds: ["CX-LOCAL:create_goal"],
    runtimeSourceIds: ["tools/builtins/session-goal.ts", "session-goal/service.ts"],
    descriptionPatterns: [/fresh user input/i, /multiple rounds or delegated work/i, /verifiable outcome/i, /do not use for.*one-step.*question.*diagnosis.*one-time research/i, /fresh user input itself as the entire objective/i, /cannot rewrite/i, /without a Skill or confirmation ceremony/i, /root Engineer Session/i],
  },
  {
    tool: "get_goal",
    competitorEvidenceIds: ["CX-LOCAL:get_goal"],
    runtimeSourceIds: ["tools/builtins/session-goal.ts", "session-goal/service.ts"],
    descriptionPatterns: [/current Session Goal/i, /status, objective, usage, budget, evaluator, and review state/i, /read-only/i],
  },
  {
    tool: "update_goal",
    competitorEvidenceIds: ["CX-LOCAL:update_goal"],
    runtimeSourceIds: ["tools/builtins/session-goal.ts", "session-goal/service.ts"],
    descriptionPatterns: [/edit, pause, resume, clear, or change.*budget/i, /fresh user input/i, /complete.*requests independent review/i, /cannot complete the Goal/i, /blocked.*same.*blocker.*three consecutive Goal turns/i],
    schema: [
      { path: ["anyOf", "0", "properties", "action"] },
      { path: ["anyOf", "5", "properties", "status"], expectedEnum: ["complete", "blocked"] },
    ],
  },
  {
    tool: "automation_create",
    competitorEvidenceIds: ["CC-160-A:CronCreate", "CX-LOCAL:automation"],
    runtimeSourceIds: ["tools/builtins/automation-create.ts:13-45", "automations/schema.ts:23-58,92-96"],
    descriptionPatterns: [/explicitly requests or accepts/i, /separately confirmed/i, /scheduled|recurring|reminder|monitor/i, /do not use.*immediately/i, /Engineer root Session/i],
    schema: [
      { path: ["properties", "trigger"], descriptionPatterns: [/Exactly one trigger/, /once/, /interval/, /cron/] },
      { path: ["properties", "trigger", "oneOf", "2", "properties", "timezone"], descriptionPatterns: [/IANA timezone/, /Asia\/Shanghai/] },
      { path: ["properties", "action"], descriptionPatterns: [/Exactly one action/, /Engineer Session/, /existing Session/] },
      { path: ["properties", "action", "oneOf", "0", "properties", "location"], descriptionPatterns: [/project uses the project workspace/, /worktree uses a managed worktree/] },
      { path: ["properties", "action", "oneOf", "1", "properties", "sessionId"], descriptionPatterns: [/target existing Session/] },
    ],
  },
  {
    tool: "skill_list",
    competitorEvidenceIds: ["CC-160-A:Skill", "OC:skill"],
    runtimeSourceIds: ["tools/builtins/skill-list.ts:6-35"],
    descriptionPatterns: [/currently allowed for this Agent/i, /System Prompt normally already lists the same allowed metadata/i, /fresh machine-readable copy/i, /call skill_read directly/i, /skill_list\(\{\}\)/, /exact returned name/i, /Never guess or invent/i],
  },
  {
    tool: "skill_read",
    competitorEvidenceIds: ["CC-160-A:Skill", "OC:skill"],
    runtimeSourceIds: ["tools/builtins/skill-read.ts:10-14,83-105"],
    descriptionPatterns: [/allowed.*Agent/i, /available names are already listed in the System Prompt/i, /skill_read\(/, /Read the Skill before the work it governs/i, /Do not load unrelated Skills/i, /cannot expand/i, /permissions/, /workspace/],
    schema: [
      { path: ["properties", "name"], descriptionPatterns: [/System Prompt's available-skill list or skill_list/i, /exact/i] },
    ],
  },
  {
    tool: "ast_grep_search",
    competitorEvidenceIds: ["OMO-A"],
    runtimeSourceIds: ["tools/builtins/ast-grep/search.ts:11-18,102-148"],
    descriptionPatterns: [/AST structure/, /not text regex/, /\$VAR.*one AST node/, /\$\$\$.*zero or more nodes/],
    schema: [
      { path: ["properties", "pattern"], descriptionPatterns: [/not a regular expression/, /complete code node/] },
    ],
  },
  {
    tool: "ast_grep_replace",
    competitorEvidenceIds: ["OMO-A"],
    runtimeSourceIds: ["tools/builtins/ast-grep/replace.ts:16-25,105-239,318-330"],
    descriptionPatterns: [/First call.*dryRun: true/, /inspect/, /same pattern, rewrite, language, paths, and globs/, /dryRun: false/],
    schema: [
      { path: ["properties", "dryRun"], descriptionPatterns: [/previews matches without writing/, /repeat the same call/] },
    ],
  },
  {
    tool: "lsp_diagnostics",
    competitorEvidenceIds: ["OMO-L"],
    runtimeSourceIds: ["tools/builtins/lsp/lsp-diagnostics.ts:38-73,363-406", "lsp/types.ts:32-38"],
    descriptionPatterns: [/error, warning, information, or hint/, /after file_edit\/file_write/, /test, build, CLI, API, or UI verification/, /clean diagnostic result proves neither functional behavior nor test success/i],
    schema: [
      { path: ["properties", "severity"], descriptionPatterns: [/Filter by severity/], expectedEnum: ["error", "warning", "information", "hint", "all"] },
    ],
  },
  {
    tool: "lsp_goto_definition",
    competitorEvidenceIds: ["OC:lsp"],
    runtimeSourceIds: ["tools/builtins/lsp/lsp-goto-definition.ts:32-68"],
    descriptionPatterns: [/definition location/, /lsp_symbols/, /file_read/, /language mapping/, /available language server/, /returns an error/],
  },
  {
    tool: "lsp_find_references",
    competitorEvidenceIds: ["OC:lsp"],
    runtimeSourceIds: ["tools/builtins/lsp/lsp-find-references.ts:23-62"],
    descriptionPatterns: [/semantic references/, /before renaming or changing a public symbol/i, /grep.*text-search fallback/i, /language mapping/, /available language server/, /returns an error/],
  },
  {
    tool: "lsp_symbols",
    competitorEvidenceIds: ["OC:lsp"],
    runtimeSourceIds: ["tools/builtins/lsp/lsp-symbols.ts:20-117"],
    descriptionPatterns: [/document or workspace symbols/, /lsp_symbols.*lsp_goto_definition or lsp_find_references.*file_read/i, /1-based line and column/, /character=column-1/, /character input is 0-based/, /Document scope.*filePath/, /workspace scope.*built-in workspace server/, /returns an error/, /fall back to grep\/glob/],
  },
  {
    tool: "web_fetch",
    competitorEvidenceIds: ["CC-160-A:WebFetch", "OC:webfetch"],
    runtimeSourceIds: ["tools/builtins/web-fetch.ts:20-48,60-90,169-274,279-315,340-425"],
    descriptionPatterns: [/unauthenticated/, /does not use browser cookies or login state/, /headers and all redirects share a fixed 30-second deadline/i, /body is not covered by that timer/i, /over 5MB.*rejected/],
    schema: [
      { path: ["properties", "url"], descriptionPatterns: [/HTTP or HTTPS/, /credentials.*rejected/] },
    ],
  },
  {
    tool: "resume_session",
    competitorEvidenceIds: ["CC-160-A:Agent continuation", "OMO-D:task_id", "CX-MA:resume_agent"],
    runtimeSourceIds: ["tools/builtins/resume-session.ts", "execution/session-execution-manager.ts"],
    descriptionPatterns: [/stopped direct child Session/i, /same delegated responsibility/i, /instruction and new_evidence/, /cannot change the durable Agent type, title, Skills, owned scope, dependencies, or acceptance criteria/i, /new canonical child result receipt/i],
    schema: [
      { path: ["properties", "session_id"] },
      { path: ["properties", "instruction"] },
      { path: ["properties", "new_evidence"] },
      { path: ["properties", "background"] },
    ],
  },
] as const;

function getSchemaNode(schema: JsonObject, path: readonly string[]): JsonObject {
  let current: unknown = schema;
  for (const segment of path) {
    expect(current).toBeObject();
    current = (current as JsonObject)[segment];
  }
  expect(current).toBeObject();
  return current as JsonObject;
}

function expectPatterns(value: string, patterns: readonly RegExp[]): void {
  for (const pattern of patterns) {
    expect(value).toMatch(pattern);
  }
}

const registryFixture = createTestToolRegistryFixture();
const registry = registryFixture.registry;
registerBuiltinTools(registry, silentLogger, { github: { enabled: false } });
afterAll(() => registryFixture.dispose());
const resolved = registry.resolveForAgent(engineerAgentDefinition.tools.tools);
const aiTools = resolved.toAITools();

describe("Engineer model-visible Tool Contract", () => {
  it("preserves the exact 33-tool Engineer definition order", () => {
    const expected = [...engineerAgentDefinition.tools.tools];
    expect(expected).toHaveLength(33);
    expect(resolved.descriptors.map((descriptor) => descriptor.name)).toEqual(expected);
    expect(Object.keys(aiTools)).toEqual(expected);
  });

  for (const contract of CONTRACTS) {
    it(`${contract.tool} exposes its evidence-backed runtime contract`, () => {
      expect(contract.competitorEvidenceIds.length).toBeGreaterThan(0);
      expect(contract.runtimeSourceIds.length).toBeGreaterThan(0);

      const tool = aiTools[contract.tool];
      expect(tool).toBeDefined();
      expectPatterns(tool.description, contract.descriptionPatterns);
      for (const excluded of contract.descriptionExcludes ?? []) {
        expect(tool.description).not.toMatch(excluded);
      }

      const schema = z.toJSONSchema(tool.inputSchema as z.ZodType) as JsonObject;
      for (const field of contract.schema ?? []) {
        const node = getSchemaNode(schema, field.path);
        if (field.descriptionPatterns !== undefined) {
          expect(typeof node.description).toBe("string");
          expectPatterns(node.description as string, field.descriptionPatterns);
        }
        if (field.expectedEnum !== undefined) {
          expect(node.enum).toEqual(field.expectedEnum);
        }
      }

      if (contract.descriptionExcludes !== undefined) {
        const modelVisible = `${tool.description}\n${JSON.stringify(schema)}`;
        for (const excluded of contract.descriptionExcludes) {
          expect(modelVisible).not.toMatch(excluded);
        }
      }
    });
  }
});
