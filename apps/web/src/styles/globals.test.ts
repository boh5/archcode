import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const css = await Bun.file(new URL("./globals.css", import.meta.url)).text();

type Rgb = readonly [number, number, number];

function block(selector: string): string {
  const escaped = selector.replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll('"', '\\"');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing CSS block ${selector}`);
  return match[1];
}

function variable(source: string, name: string): string {
  const match = source.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing --${name}`);
  return match[1].trim().toLowerCase();
}

function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function blend(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as unknown as Rgb;
}

function luminance(color: Rgb): number {
  const channels = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function reducedMotionDeclarations(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start < 0) throw new Error("Missing reduced-motion media query");
  const opening = css.indexOf("{", start);
  let depth = 1;
  let end = opening + 1;
  while (depth > 0 && end < css.length) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}") depth -= 1;
    end += 1;
  }
  const mediaBody = css.slice(opening + 1, end - 1);
  const universal = mediaBody.match(/\*,\s*\*::before,\s*\*::after\s*\{([\s\S]*?)\}/);
  if (!universal) throw new Error("Missing reduced-motion universal rule");
  return universal[1];
}

const locked = {
  dark: {
    selector: ":root",
    alpha: 0.08,
    surface: ["#0b0d10", "#101318", "#151922", "#1b202a"],
    interaction: ["#202632", "#282f3d"],
    border: ["#222936", "#2c3544", "#3b4658"],
    text: ["#f2f4f7", "#a8b0bf", "#818b99", "#626d7d"],
    semantic: ["#8b7ff5", "#6ea0ff", "#4ccb7a", "#e4b454", "#ff6b72", "#818b99"],
    agents: ["#a78bfa", "#60a5fa", "#22d3ee", "#94a3b8", "#c084fc"],
  },
  light: {
    selector: '[data-theme="light"]',
    alpha: 0.06,
    surface: ["#f1f3f6", "#f7f8fa", "#fcfcfd", "#ffffff"],
    interaction: ["#eceff3", "#e3e7ed"],
    border: ["#e6e9ee", "#d7dce4", "#b8c0cc"],
    text: ["#151820", "#4e5665", "#66707f", "#8d96a4"],
    semantic: ["#6254d8", "#315fd0", "#187a43", "#8c5c12", "#bf3e45", "#606a79"],
    agents: ["#6d28d9", "#1d4ed8", "#0e7490", "#475569", "#7e22ce"],
  },
} as const;

const groups = {
  surface: ["bg-base", "bg-surface", "bg-elevated", "bg-overlay"],
  interaction: ["bg-hover", "bg-active"],
  border: ["border-subtle", "border-default", "border-strong"],
  text: ["text-primary", "text-secondary", "text-tertiary", "text-muted"],
  semantic: ["brand", "info", "success", "warning", "error", "neutral"],
  agents: ["agent-lead", "agent-analyst", "agent-build", "agent-explore", "agent-librarian"],
} as const;

describe("workbench visual tokens", () => {
  test("matches the locked dark and light palettes exactly", () => {
    for (const theme of Object.values(locked)) {
      const source = block(theme.selector);
      for (const [groupName, names] of Object.entries(groups)) {
        expect(names.map((name) => variable(source, name))).toEqual([...(theme[groupName as keyof typeof groups] as readonly string[])]);
      }
    }
  });

  test("keeps readable foreground and focus contrast on persistent surfaces", () => {
    for (const theme of Object.values(locked)) {
      const source = block(theme.selector);
      const surfaces = [rgb(variable(source, "bg-surface")), rgb(variable(source, "bg-elevated"))];
      const readable = [...groups.text.slice(0, 3), ...groups.semantic, ...groups.agents];
      for (const name of readable) {
        const foreground = rgb(variable(source, name));
        for (const surface of surfaces) expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
      const brand = rgb(variable(source, "brand"));
      for (const surface of surfaces) expect(contrast(brand, surface)).toBeGreaterThanOrEqual(3);
      expect(variable(source, "control-border")).toBe("var(--text-tertiary)");
      const controlBoundary = rgb(variable(source, "text-tertiary"));
      for (const surface of surfaces) expect(contrast(controlBoundary, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  test("keeps semantic foreground readable on generated subtle backgrounds", () => {
    for (const theme of Object.values(locked)) {
      const source = block(theme.selector);
      for (const surfaceName of ["bg-surface", "bg-elevated"] as const) {
        const surface = rgb(variable(source, surfaceName));
        for (const semanticName of groups.semantic) {
          const foreground = rgb(variable(source, semanticName));
          expect(contrast(foreground, blend(foreground, surface, theme.alpha))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("hard-cuts legacy tokens and defines the complete motion contract", () => {
    expect(css).not.toContain("--accent");
    expect(css).not.toContain("pulse-dot");
    expect(css).not.toContain("pulse-ring");
    expect(css).not.toContain("--background:");
    expect(css).toContain("--motion-hover: 120ms");
    expect(css).toContain("--motion-icon: 160ms");
    expect(css).toContain("--motion-overlay: 220ms");
    expect(css).toContain("--motion-activity: 1600ms");
    expect(css).toContain("--motion-attention: 700ms");
    expect(css).toContain("--motion-complete: 180ms");
    expect(css).toContain("--color-border-control: var(--control-border)");
    expect(css).toContain("overlay-exit var(--motion-overlay) var(--ease-exit)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: status-attention var(--motion-attention) var(--ease-standard) 2");
    expect(css).toContain("animation: status-complete var(--motion-complete) var(--ease-standard) 1");
  });

  test("resolves animated primitives to zero-duration computed styles under the reduced-motion declarations", () => {
    const dom = new JSDOM(`<!doctype html><style>
      .animated { animation-name: activity-rotate; animation-duration: 1600ms; animation-iteration-count: infinite; transition-duration: 160ms; }
      .reduced { ${reducedMotionDeclarations()} }
    </style><div class="animated reduced"></div>`);
    const animated = dom.window.document.querySelector(".animated");
    if (!(animated instanceof dom.window.HTMLElement)) throw new Error("Missing animated test element");
    const computed = dom.window.getComputedStyle(animated);
    expect(computed.animationDuration).toBe("0s");
    expect(computed.animationIterationCount).toBe("1");
    expect(computed.transitionDuration).toBe("0s");
    dom.window.close();
  });
});
