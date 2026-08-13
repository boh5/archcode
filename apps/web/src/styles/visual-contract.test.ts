import { describe, expect, test } from "bun:test";

const sourceRoot = new URL("../", import.meta.url).pathname;

async function productionSources(): Promise<Array<{ path: string; source: string }>> {
  const paths: string[] = [];
  for (const pattern of ["**/*.ts", "**/*.tsx", "**/*.css"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: sourceRoot, onlyFiles: true })) {
      if (path.includes(".test.") || path.includes(".interaction.")) continue;
      paths.push(path);
    }
  }
  return Promise.all(paths.sort().map(async (path) => ({ path, source: await Bun.file(`${sourceRoot}/${path}`).text() })));
}

function classNameForTagContaining(source: string, tag: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  const start = source.lastIndexOf(`<${tag}`, markerIndex);
  const className = source.indexOf("className=", start);
  const end = source.indexOf("\n", className);
  if (markerIndex < 0 || start < 0 || className < 0 || end < 0) throw new Error(`Could not find className for <${tag}> containing ${marker}`);
  return source.slice(className, end);
}

describe("visual contract", () => {
  test("keeps RootLayout as the single work-canvas main landmark", async () => {
    const rootLayout = await Bun.file(`${sourceRoot}/routes/root-layout.tsx`).text();
    expect(rootLayout.match(/<main\b/g)).toHaveLength(1);
    for (const path of ["home.tsx", "project-todos.tsx", "project-todo-detail.tsx", "project-sessions.tsx", "automations.tsx", "automation-detail.tsx"]) {
      const route = await Bun.file(`${sourceRoot}/routes/${path}`).text();
      expect(route).not.toContain("<main");
    }
  });

  test("locks the dense 2/4px geometry unit and named type scale independently of root font size", async () => {
    const globals = await Bun.file(`${sourceRoot}/styles/globals.css`).text();
    expect(globals).toContain("--spacing: 4px;");
    expect(globals).toContain("--text-xs: 12px;");
    expect(globals).toContain("--text-xs--line-height: 16px;");
    expect(globals).toContain("--text-sm: 14px;");
    expect(globals).toContain("--text-sm--line-height: 21px;");
    expect(globals).toContain("--text-base: 15px;");
    expect(globals).toContain("--text-base--line-height: 23.25px;");
    expect(globals).toContain("line-height: 1.55;");
    expect(globals).toContain("letter-spacing: -0.006em;");
  });

  test("keeps project command bars usable on narrow viewports", async () => {
    const todos = await Bun.file(`${sourceRoot}/routes/project-todos.tsx`).text();
    const automations = await Bun.file(`${sourceRoot}/routes/automations.tsx`).text();
    const sessions = await Bun.file(`${sourceRoot}/routes/project-sessions.tsx`).text();
    const primaryAction = await Bun.file(`${sourceRoot}/components/primitives/PrimaryActionButton.tsx`).text();

    const todoSearch = classNameForTagContaining(todos, "label", ">Filter Todos<");
    expect(todoSearch).toContain("h-11");
    expect(todoSearch).toContain("min-[761px]:h-[38px]");
    const todoSearchInput = classNameForTagContaining(todos, "input", 'placeholder="Filter Todos…"');
    expect(todoSearchInput).toContain("text-[16px]");
    expect(todoSearchInput).toContain("min-[761px]:text-[12px]");
    expect(todos).toContain("grid-cols-1");
    expect(todos).toContain("min-[761px]:grid-cols-[minmax(0,1fr)_auto]");
    const todoSurfaceButton = classNameForTagContaining(todos, "button", "aria-pressed={active}");
    expect(todoSurfaceButton).toContain("h-[30px]");
    expect(todoSurfaceButton).toContain("cursor-pointer");
    expect(todos).toContain("h-9 w-9 min-w-9 cursor-pointer");
    expect(todos).toContain("min-[761px]:h-7 min-[761px]:w-[30px]");
    expect(todos).toContain('import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton"');
    expect(todos).toContain('<PrimaryActionButton ref={newTodoTriggerRef} className="min-[761px]:h-9"');

    const automationSearch = classNameForTagContaining(automations, "label", ">Filter Automations<");
    expect(automationSearch).toContain("h-11");
    expect(automationSearch).toContain("min-[761px]:h-[38px]");
    const automationSearchInput = classNameForTagContaining(automations, "input", 'placeholder="Filter Automations…"');
    expect(automationSearchInput).toContain("text-[16px]");
    expect(automationSearchInput).toContain("min-[761px]:text-[12px]");
    expect(automations).toContain("<PrimaryActionButton");

    const sessionSearch = classNameForTagContaining(sessions, "label", ">Filter Sessions<");
    expect(sessionSearch).toContain("h-11");
    expect(sessionSearch).toContain("min-[761px]:h-[38px]");
    const sessionSearchInput = classNameForTagContaining(sessions, "input", 'placeholder="Filter Sessions…"');
    expect(sessionSearchInput).toContain("text-[16px]");
    expect(sessionSearchInput).toContain("min-[761px]:text-[12px]");
    expect(sessions).toContain('data-testid="session-source-picker"');
    expect(sessions).toContain('aria-haspopup="menu"');
    expect(sessions).toContain('role="menuitemradio"');
    expect(sessions).toContain("h-11 w-[150px]");
    expect(sessions).toContain("min-[761px]:h-9 min-[761px]:w-[142px]");
    expect(sessions).toContain("<PrimaryActionButton");
    expect(primaryAction).toContain("primary-action-button");
    expect(primaryAction).toContain("h-11");
    expect(primaryAction).toContain("min-[761px]:h-8");
    expect(primaryAction).toContain("[@media(pointer:coarse)]:h-11");
    expect(sessions).toContain("<ChevronRight");
  });

  test("enforces the current motion and structural-surface safety rules", async () => {
    const sources = await productionSources();
    const globalRules: Array<[string, RegExp]> = [
      ["Tailwind default spinner", /animate-spin/],
      ["persistent pulse", /animate-pulse/],
      ["oversized generic radius", /rounded-2xl/],
      ["unnamed duration", /duration-(?:75|100|150|200|300|500|700|1000)\b/],
      ["broad transition", /transition-all/],
      ["unlocked extra-large shadow", /\bshadow-xl\b/],
      ["out-of-scale named type size", /\btext-(?:lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/],
      ["unlocked named line height", /\bleading-(?:tight|snug|relaxed|loose)\b/],
      ["undersized compact control", /(?:\bh-6\s+w-6\b|\bw-6\s+h-6\b)/],
      ["zoom overlay motion", /zoom-(?:in|out)/],
      ["double-faded semantic subtle background", /\bbg-(?:brand|info|signal|success|warning|error|neutral)-muted\/\d+\b/],
      ["transparent structural surface", /\bbg-bg-(?:base|surface|elevated|overlay)\/\d+\b/],
    ];
    const violations: string[] = [];
    for (const { path, source } of sources) {
      for (const [name, rule] of globalRules) {
        if (rule.test(source)) violations.push(`${path}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
