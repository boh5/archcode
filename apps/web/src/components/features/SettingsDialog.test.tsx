import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpServerStatus } from "@archcode/protocol";
import { SettingsDialogContent, SettingsMcpStatusPanel } from "./SettingsDialog";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value.props?.children);
}

function findAll(
  value: unknown,
  predicate: (element: ElementLike) => boolean,
): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(value);
  return matches;
}

const onClose = mock(() => {});

function renderShell(servers: Record<string, McpServerStatus> = {}): unknown {
  return SettingsDialogContent({ servers, onClose });
}

function renderMcpPanel(servers: Record<string, McpServerStatus> = {}): unknown {
  return SettingsMcpStatusPanel({ servers });
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    onClose.mockClear();
  });

  test("renders an opencode-style settings shell with only MCP Status enabled", () => {
    const tree = renderShell();
    const sectionButtons = findAll(tree, (element) => element.type === "button" && element.props?.type === "button");

    expect(textContent(tree)).toContain("Settings");
    expect(textContent(tree)).toContain("General");
    expect(textContent(tree)).toContain("MCP Status");
    expect(textContent(tree)).toContain("Providers");
    expect(textContent(tree)).toContain("Models");
    expect(textContent(tree)).toContain("Coming soon");

    const mcpButton = sectionButtons.find((button) => textContent(button).includes("MCP Status"));
    const disabledButtons = sectionButtons.filter((button) => button.props?.disabled === true);

    expect(mcpButton?.props?.["aria-current"]).toBe("page");
    expect(disabledButtons).toHaveLength(3);
  });

  test("closes from the settings header", () => {
    const tree = renderShell();
    const closeButton = findAll(tree, (element) => element.props?.["aria-label"] === "Close settings")[0];

    (closeButton?.props?.onClick as () => void)();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows an empty MCP status state before servers are reported", () => {
    const tree = renderMcpPanel();

    expect(textContent(tree)).toContain("MCP Status");
    expect(textContent(tree)).toContain("0 servers");
    expect(textContent(tree)).toContain("No MCP servers reported yet");
  });

  test("renders ready, pending, failed, and disabled MCP servers", () => {
    const tree = renderMcpPanel({
      exa: { state: "failed", error: "connection refused" },
      context7: { state: "ready", toolCount: 4 },
      disabled: { state: "disabled" },
      grep: { state: "pending" },
    });

    expect(textContent(tree)).toContain("4 servers");
    expect(textContent(tree)).toContain("1 ready");
    expect(textContent(tree)).toContain("1 failed");
    expect(textContent(tree)).toContain("context7");
    expect(textContent(tree)).toContain("4 tools available");
    expect(textContent(tree)).toContain("exa");
    expect(textContent(tree)).toContain("connection refused");
    expect(textContent(tree)).toContain("Discovery is still running");
    expect(textContent(tree)).toContain("Server is disabled in configuration");
  });

  test("uses singular copy for one ready tool", () => {
    const tree = renderMcpPanel({
      context7: { state: "ready", toolCount: 1 },
    });

    expect(textContent(tree)).toContain("1 tool available");
  });
});
