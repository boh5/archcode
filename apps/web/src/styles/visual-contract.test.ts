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

describe("visual contract", () => {
  test("locks the dense 2/4px geometry unit and named type scale independently of root font size", async () => {
    const globals = await Bun.file(`${sourceRoot}/styles/globals.css`).text();
    expect(globals).toContain("--spacing: 4px;");
    expect(globals).toContain("--text-xs: 12px;");
    expect(globals).toContain("--text-xs--line-height: 16px;");
    expect(globals).toContain("--text-sm: 14px;");
    expect(globals).toContain("--text-sm--line-height: 21px;");
    expect(globals).toContain("--text-base: 15px;");
    expect(globals).toContain("--text-base--line-height: 22px;");
  });

  test("enforces the current motion, radius, contrast, and status presentation rules", async () => {
    const sources = await productionSources();
    const globalRules: Array<[string, RegExp]> = [
      ["raw white foreground", /\btext-white\b/],
      ["Tailwind default spinner", /animate-spin/],
      ["persistent pulse", /animate-pulse/],
      ["arbitrary radius", /rounded-\[[^\]]+\]/],
      ["oversized generic radius", /rounded-2xl/],
      ["unnamed duration", /duration-(?:75|100|150|200|300|500|700|1000)\b/],
      ["broad transition", /transition-all/],
      ["arbitrary shadow", /shadow-\[/],
      ["unlocked extra-large shadow", /\bshadow-xl\b/],
      ["fractional type size", /text-\[\d+\.5px\]/],
      ["out-of-scale named type size", /\btext-(?:lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/],
      ["unlocked named line height", /\bleading-(?:tight|snug|relaxed|loose)\b/],
      ["undersized compact control", /(?:\bh-6\s+w-6\b|\bw-6\s+h-6\b)/],
      ["unlocked 30px control", /\b[hw]-\[30px\]/],
      ["zoom overlay motion", /zoom-(?:in|out)/],
      ["double-faded semantic subtle background", /\bbg-(?:brand|info|signal|success|warning|error|neutral)-muted\/\d+\b/],
      ["transparent structural surface", /\bbg-bg-(?:base|surface|elevated|overlay)\/\d+\b/],
    ];
    const violations: string[] = [];
    const roundedLgAllowlist = new Map<string, number>([
      ["routes/root-layout.tsx", 1],
      ["routes/dashboard.tsx", 1],
      ["routes/project-todos.tsx", 2],
      ["components/ui/ContextMenu.tsx", 1],
      ["components/ui/DropdownMenu.tsx", 1],
      ["components/features/ChatInput.tsx", 1],
      ["components/features/AddProjectModal.tsx", 1],
      ["components/ui/Dialog.tsx", 1],
      ["components/features/ModelPicker.tsx", 1],
      ["components/features/TodoProgressButton.tsx", 1],
      ["components/features/HitlBell.tsx", 1],
      ["components/features/ProjectBar.tsx", 2],
      ["components/primitives/IconAction.tsx", 1],
      ["components/composite/Toast.tsx", 1],
      ["components/composite/ExecutionWorkstream.tsx", 1],
    ]);
    const roundedXlAllowlist = new Map<string, number>([["components/features/ChatInput.tsx", 1]]);
    const shadowSmAllowlist = new Map<string, number>([
      ["components/features/ChatInput.tsx", 1],
      ["routes/project-todos.tsx", 2],
    ]);
    for (const { path, source } of sources) {
      for (const [name, rule] of globalRules) {
        if (rule.test(source)) violations.push(`${path}: ${name}`);
      }
      for (const match of source.matchAll(/\b[pm][trblxy]?-\[(\d+)px\]/g)) {
        if (![2, 4, 6, 8, 10, 12, 14, 18, 24, 30, 40].includes(Number(match[1]))) {
          violations.push(`${path}: off-grid arbitrary spacing ${match[0]}`);
        }
      }
      for (const match of source.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (![8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 26, 30].includes(Number(match[1]))) violations.push(`${path}: out-of-scale type size ${match[0]}`);
      }
      const roundedLgCount = [...source.matchAll(/\brounded-lg\b/g)].length;
      if (roundedLgCount !== (roundedLgAllowlist.get(path) ?? 0)) {
        violations.push(`${path}: rounded-lg ownership expected ${roundedLgAllowlist.get(path) ?? 0}, received ${roundedLgCount}`);
      }
      const roundedXlCount = [...source.matchAll(/\brounded-xl\b/g)].length;
      if (roundedXlCount !== (roundedXlAllowlist.get(path) ?? 0)) {
        violations.push(`${path}: rounded-xl ownership expected ${roundedXlAllowlist.get(path) ?? 0}, received ${roundedXlCount}`);
      }
      if (path.endsWith(".tsx")) {
        const shadowSmCount = [...source.matchAll(/\bshadow-sm\b/g)].length;
        if (shadowSmCount !== (shadowSmAllowlist.get(path) ?? 0)) {
          violations.push(`${path}: shadow-sm ownership expected ${shadowSmAllowlist.get(path) ?? 0}, received ${shadowSmCount}`);
        }
      }

      // Muted is intentionally restricted to placeholders, disabled controls,
      // aria-hidden decoration, and short uppercase eyebrow labels. Everything
      // users need to read or act on must use at least tertiary contrast.
      let mutedRemainder = source
        .replaceAll("placeholder:text-text-muted", "")
        .replaceAll("disabled:text-text-muted", "");
      mutedRemainder = mutedRemainder.replace(/<[^>]*\btext-text-muted\b[^>]*>/gs, (tag) => {
        return tag.includes('aria-hidden="true"') || tag.includes("uppercase") ? tag.replaceAll("text-text-muted", "") : tag;
      });
      if (/\btext-text-muted\b/.test(mutedRemainder)) {
        violations.push(`${path}: text-muted outside the explicit incidental-content allowlist`);
      }
    }

    expect(violations).toEqual([]);
  });
});
