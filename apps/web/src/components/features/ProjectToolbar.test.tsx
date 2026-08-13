import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Project } from "../../api/types";

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
  return children === undefined || children === null ? [] : Array.isArray(children) ? children : [children];
}

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(visit);
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    childrenOf(node).forEach(visit);
  };
  visit(value);
  return matches;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  return isElement(value) ? textContent(value.props?.children) : "";
}

const project: Project = {
  slug: "archcode",
  name: "ArchCode",
  workspaceRoot: "/workspace/archcode",
  addedAt: "2026-01-01T00:00:00.000Z",
};
const navigate = mock((_to: string) => {});
let routeParams: { slug: string; automationId?: string; sessionId?: string; todoId?: string } = { slug: "archcode" };
const useState = mock(<T,>(initial: T) => [initial, mock(() => {})] as const);
const Fragment = Symbol.for("react.fragment");
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: props ?? {}, key });

mock.module("react", () => ({ useCallback: (callback: unknown) => callback, useState }));
mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsx, jsxs: jsx, jsxDEV: jsx }));
mock.module("react-router-dom", () => ({
  NavLink: "NavLink",
  useNavigate: () => navigate,
  useParams: () => routeParams,
}));
mock.module("../../api/queries", () => ({ useProjects: () => ({ data: [project] }) }));
mock.module("./ProjectActionMenu", () => ({ ProjectActionDropdown: "ProjectActionDropdown" }));
mock.module("./EditProjectDialog", () => ({ EditProjectDialog: "EditProjectDialog" }));
mock.module("./CloseProjectDialog", () => ({ CloseProjectDialog: "CloseProjectDialog" }));

const { ProjectToolbar } = await import("./ProjectToolbar");

describe("ProjectToolbar", () => {
  beforeEach(() => {
    navigate.mockClear();
    useState.mockClear();
    routeParams = { slug: "archcode" };
  });

  test("shows project identity and the stable project navigation order", () => {
    const tree = ProjectToolbar();
    const menu = findAll(tree, (element) => element.type === "ProjectActionDropdown")[0];
    const trigger = menu?.props?.trigger as ElementLike;
    const heading = findAll(trigger, (element) => element.type === "h1")[0];
    const links = findAll(tree, (element) => element.type === "NavLink");
    const navigation = findAll(tree, (element) => element.type === "nav")[0];

    expect(textContent(heading)).toBe("ArchCode");
    expect(links.map((link) => textContent(link))).toEqual(["Todos", "Automations", "Sessions"]);
    expect(links.map((link) => link.props?.to)).toEqual([
      "/projects/archcode/todos",
      "/projects/archcode/automations",
      "/projects/archcode/sessions",
    ]);
    expect(navigation?.props?.className).toContain("[@media(pointer:coarse)]:h-11");
    expect(navigation?.props?.className).toContain("h-10");
    expect((tree as ElementLike).props?.className).toContain("min-h-12");
    expect((tree as ElementLike).props?.className).not.toContain("h-[88px]");
    expect(links.every((link) => String(link.props?.className).includes("min-h-11"))).toBe(true);
  });

  test("keeps the Session detail toolbar at the prototype's fixed mobile height", () => {
    routeParams = { slug: "archcode", sessionId: "session-1" };
    const tree = ProjectToolbar();
    expect((tree as ElementLike).props?.className).toContain("h-[88px]");
  });

  test("uses the project identity itself as the project-actions trigger", () => {
    const tree = ProjectToolbar();
    const menu = findAll(tree, (element) => element.type === "ProjectActionDropdown")[0];
    expect(menu?.props?.project).toBe(project);
    const trigger = menu?.props?.trigger as ElementLike;
    expect(trigger.props?.["aria-label"]).toBe("Project actions for ArchCode");
    expect(textContent(trigger)).toContain("ArchCode/workspace/archcode");
  });

  test("leaves the page h1 to Todo, Session, and Automation detail headers", () => {
    for (const detailParams of [
      { todoId: "todo-1" },
      { sessionId: "session-1" },
      { automationId: "automation-1" },
    ]) {
      routeParams = { slug: "archcode", ...detailParams };
      const tree = ProjectToolbar();
      const menu = findAll(tree, (element) => element.type === "ProjectActionDropdown")[0];
      const trigger = menu?.props?.trigger as ElementLike;

      expect(findAll(trigger, (element) => element.type === "h1")).toEqual([]);
      expect(findAll(trigger, (element) => element.type === "p").some((element) => textContent(element) === "ArchCode")).toBe(true);
    }
  });
});
