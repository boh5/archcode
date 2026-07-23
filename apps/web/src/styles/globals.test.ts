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
  light: {
    selector: ":root",
    surface: ["#f3f1e9", "#faf9f4", "#ffffff", "#ffffff"],
    interaction: ["#e4e1d7", "#dcd9ce"],
    border: ["#e2ded3", "#d2cec2", "#aaa69b"],
    text: ["#24241f", "#5e5d55", "#696860", "#6f6e66"],
    semantic: ["#4b50c8", "#397454", "#91651c", "#b4473f", "#696860"],
    signal: ["#b8d94a", "#edf4cf", "#53631d", "#252c0b"],
    rail: ["#24241f", "#f4f2e9", "#85847a"],
  },
  dark: {
    selector: '[data-theme="dark"]',
    surface: ["#141512", "#1b1d19", "#22241f", "#22241f"],
    interaction: ["#2f322b", "#383b33"],
    border: ["#292b26", "#393c34", "#595d51"],
    text: ["#f1f0e8", "#b8b7ad", "#a3a198", "#85847c"],
    semantic: ["#858bff", "#72b88a", "#dfb85d", "#ec7b72", "#a3a198"],
    signal: ["#c5e85a", "#2c3518", "#c5e85a", "#1c2206"],
    rail: ["#0f100e", "#f1f0e8", "#74746d"],
  },
} as const;

const groups = {
  surface: ["bg-base", "bg-surface", "bg-elevated", "bg-overlay"],
  interaction: ["bg-hover", "bg-active"],
  border: ["border-subtle", "border-default", "border-strong"],
  text: ["text-primary", "text-secondary", "text-tertiary", "text-muted"],
  semantic: ["brand", "success", "warning", "error", "neutral"],
  signal: ["signal", "signal-field", "signal-foreground", "signal-ink"],
  rail: ["rail", "rail-ink", "rail-muted"],
} as const;

describe("workbench visual tokens", () => {
  test("matches the locked mineral light and dark palettes exactly", () => {
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
      const readable = [...groups.text.slice(0, 3), ...groups.semantic];
      for (const name of readable) {
        const foreground = rgb(variable(source, name));
        for (const surface of surfaces) expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
      const brand = rgb(variable(source, "brand"));
      for (const surface of surfaces) expect(contrast(brand, surface)).toBeGreaterThanOrEqual(3);
      expect(variable(source, "control-border")).toBe("var(--border-default)");
    }
  });

  test("reserves lime for signal state fields and eliminates the agent rainbow", () => {
    for (const theme of Object.values(locked)) {
      const source = block(theme.selector);
      expect(variable(source, "info")).toBe(variable(source, "brand"));
      expect(variable(source, "signal")).not.toBe(variable(source, "brand"));
      expect(variable(source, "signal-field")).not.toBe(variable(source, "brand-field"));
      expect(
        contrast(rgb(variable(source, "signal-foreground")), rgb(variable(source, "signal-field"))),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(rgb(variable(source, "signal-foreground")), rgb(variable(source, "bg-surface"))),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(rgb(variable(source, "signal-ink")), rgb(variable(source, "signal"))),
      ).toBeGreaterThanOrEqual(4.5);
      expect(source).not.toContain("--agent-");
    }
  });

  test("hard-cuts legacy tokens and defines the complete motion contract", () => {
    expect(css).not.toContain("--accent");
    expect(css).not.toContain("pulse-dot");
    expect(css).not.toContain("pulse-ring");
    expect(css).not.toContain("--background:");
    expect(css).not.toContain("--brand-muted");
    expect(css).toContain("--motion-hover: 140ms");
    expect(css).toContain("--motion-icon: 160ms");
    expect(css).toContain("--motion-overlay: 220ms");
    expect(css).toContain("--motion-activity: 1800ms");
    expect(css).toContain("--motion-attention: 700ms");
    expect(css).toContain("--motion-complete: 180ms");
    expect(css).toContain("--color-border-control: var(--control-border)");
    expect(css).toContain("--color-signal: var(--signal)");
    expect(css).toContain("--color-signal-foreground: var(--signal-foreground)");
    expect(css).toContain("--color-rail: var(--rail)");
    expect(css).toContain('font-stack-sans: "Avenir Next", Avenir');
    expect(css).toContain('font-stack-mono: "SFMono-Regular"');
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
