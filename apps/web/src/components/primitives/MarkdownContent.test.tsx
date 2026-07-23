import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent";

const MARKDOWN_FIXTURE = [
  "# Markdown heading",
  "",
  "Paragraph with **strong text**, [a link](https://example.com), and `inlineCode()`.",
  "",
  "- First item",
  "- Second item",
  "",
  "> Quoted guidance",
  "",
  "```typescript",
  "const answer: number = 42;",
  "console.log(answer);",
  "```",
  "",
  "| State | Owner |",
  "| --- | --- |",
  "| Running | Lead |",
].join("\n");

describe("MarkdownContent", () => {
  test("renders the complete ArchCode Markdown surface with Streamdown semantics intact", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{MARKDOWN_FIXTURE}</MarkdownContent>,
    );

    expect(html).toContain("markdown-content space-y-0");
    expect(html).not.toContain("space-y-4");
    expect(html).toContain('data-markdown-table="surface"');
    expect(html).toContain('data-markdown-table="toolbar"');
    expect(html).toContain('data-markdown-table="scroll"');
    expect(html).toContain('aria-label="View table fullscreen"');
    expect(html).toContain("Copy table");
    expect(html).toContain("Download table");
    for (const semantic of [
      "heading-1",
      "strong",
      "link",
      "inline-code",
      "unordered-list",
      "blockquote",
      "code-block",
      "code-block-header",
      "code-block-actions",
      "code-block-copy-button",
      "code-block-download-button",
      "code-block-body",
      "table-wrapper",
      "table",
    ]) {
      expect(html).toContain(`data-streamdown="${semantic}"`);
    }
  });

  test("uses one explicit compact variant for embedded Markdown surfaces", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent variant="compact">{"## Compact heading\n\n`code`"}</MarkdownContent>,
    );

    expect(html).toContain("markdown-content markdown-content--compact space-y-0");
    expect(html).not.toContain("space-y-4");
    expect(html).not.toContain("conversation-markdown-body");
  });

  test("preserves Streamdown streaming behavior and disables incomplete code actions", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent isStreaming>{"```typescript\nconst pending = true;"}</MarkdownContent>,
    );

    expect(html).toContain('data-incomplete="true"');
    expect(html).toContain('data-streamdown="code-block"');
    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain("disabled");
  });

  test("keeps renderer configuration, Tailwind adaptation, and presentation separated", async () => {
    const componentSource = await Bun.file(new URL("./MarkdownContent.tsx", import.meta.url)).text();
    const componentCss = await Bun.file(new URL("./MarkdownContent.css", import.meta.url)).text();
    const globalsCss = await Bun.file(new URL("../../styles/globals.css", import.meta.url)).text();

    expect(componentSource).toContain("createCodePlugin");
    expect(componentSource).toContain("MarkdownTable");
    expect(componentSource).toContain("components={MARKDOWN_COMPONENTS}");
    expect(componentSource).toContain("table: false");
    expect(componentSource).toContain('themes: ["vitesse-light", "vitesse-dark"]');
    expect(componentSource).toContain('animation: "fadeIn"');
    expect(componentSource).toContain("duration: 120");
    expect(componentSource).toContain("stagger: 8");
    expect(componentSource).not.toContain("shikiTheme");
    expect(componentSource).toContain("space-y-0");
    expect(componentSource).not.toContain("space-y-2");
    expect(componentSource).not.toContain("space-y-3");
    expect(componentSource).not.toContain("space-y-4");
    expect(componentCss).toContain("--markdown-panel-body:");
    expect(componentCss).toContain("> :not(:first-child)");
    expect(componentCss).toContain('[data-streamdown="code-block"]');
    expect(componentCss).toContain('[data-streamdown="code-block-body"]');
    expect(componentCss).toContain("--markdown-code-gutter");
    expect(componentCss).toContain("width: 38px");
    expect(componentCss).toContain(":has(> span:not(:empty))");
    expect(componentCss).toContain("> span:empty");
    expect(componentCss).toContain('content: "CODE"');
    expect(componentCss).not.toContain('content: "TABLE"');
    expect(componentCss).toContain('[data-markdown-table="surface"]');
    expect(componentCss).toContain('[data-markdown-table="scroll"]');
    expect(componentCss).toContain(".markdown-table-action");
    expect(componentCss).not.toContain("> div:first-child");
    expect(componentCss).toContain("min-height: 32px");
    expect(componentCss).toContain("min-width: 440px");
    expect(componentCss).toContain("white-space: nowrap");
    expect(componentCss).toContain("font-style: normal");
    expect(globalsCss).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
    expect(globalsCss).toContain("--color-background: var(--bg-elevated)");
    expect(globalsCss).toContain("--color-muted-foreground: var(--text-tertiary)");
    expect(globalsCss).toContain("--color-primary: var(--brand)");
    expect(globalsCss).not.toContain("conversation-markdown-body");

    const surfaceRuleStart = componentCss.indexOf('[data-markdown-table="surface"] {');
    const surfaceRuleEnd = componentCss.indexOf("}", surfaceRuleStart);
    const surfaceRule = componentCss.slice(surfaceRuleStart, surfaceRuleEnd);
    expect(surfaceRuleStart).toBeGreaterThanOrEqual(0);
    expect(surfaceRule).not.toContain("overflow:");

    const scrollRuleStart = componentCss.indexOf('[data-markdown-table="scroll"] {');
    const scrollRuleEnd = componentCss.indexOf("}", scrollRuleStart);
    const scrollRule = componentCss.slice(scrollRuleStart, scrollRuleEnd);
    expect(scrollRuleStart).toBeGreaterThanOrEqual(0);
    expect(scrollRule).toContain("overflow: auto");
  });
});
