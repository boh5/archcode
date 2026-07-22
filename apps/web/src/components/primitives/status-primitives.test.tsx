import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityArc } from "./ActivityArc";
import { ProgressRing } from "./ProgressRing";
import { StatusGlyph } from "./StatusGlyph";

describe("status primitives", () => {
  test("ActivityArc rotates only its active SVG arc", () => {
    const html = renderToStaticMarkup(<ActivityArc label="Execution running" />);
    expect(html).toContain('data-motion="loop"');
    expect(html).toContain('aria-label="Execution running"');
    expect(html.match(/animate-activity/g)?.length).toBe(1);
    expect(html).not.toContain("box-shadow");
  });

  test("ProgressRing clamps percent and exposes deterministic geometry", () => {
    const empty = renderToStaticMarkup(<ProgressRing percent={-10} label="0 of 4 Todos completed" />);
    const full = renderToStaticMarkup(<ProgressRing percent={120} label="4 of 4 Todos completed" tone="success" />);
    expect(empty).toContain('data-percent="0"');
    expect(full).toContain('data-percent="100"');
    expect(full).toContain("text-success");
    expect(full).toContain('stroke-dashoffset="0"');
    expect(full).toContain("var(--motion-overlay)");
  });

  test("StatusGlyph keeps static states static and allows explicit one-shot transitions", () => {
    const paused = renderToStaticMarkup(<StatusGlyph kind="paused" label="Paused" />);
    const completed = renderToStaticMarkup(<StatusGlyph kind="completed" label="Completed" transition="complete" />);
    expect(paused).toContain('data-motion="none"');
    expect(paused).not.toContain("animate-activity");
    expect(completed).toContain('data-motion="complete"');
    expect(completed).toContain("animate-status-complete");
  });

  test("exposes an accessible image name for every primary product status", () => {
    for (const [kind, label] of [
      ["running", "Running"],
      ["needs_you", "Needs you"],
      ["paused", "Paused"],
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["stopped", "Stopped"],
    ] as const) {
      const html = renderToStaticMarkup(<StatusGlyph kind={kind} label={label} />);
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(kind === "running" ? 'data-testid="activity-arc"' : `data-visual-kind="${kind}"`);
    }
  });
});
