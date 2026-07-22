import { describe, expect, mock, test } from "bun:test";

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

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
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

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return isElement(value) ? textContent(value.props?.children) : "";
}

const Fragment = Symbol.for("react.fragment");
const jsx = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV: jsx, jsx, jsxs: jsx }));
mock.module("react-router-dom", () => ({ Link: "Link" }));
mock.module("../hooks/use-dashboard-projection", () => ({
  useDashboardProjection: () => ({
    data: { scope: { kind: "global" }, sessions: [], automations: [], errors: [] },
    sections: { attention: [], running: [], continueWorking: [], upcoming: [] },
    isLoading: false,
    error: null,
  }),
}));
mock.module("lucide-react", () => ({
  AlertCircle: "AlertCircle",
  Ban: "Ban",
  Calendar: "Calendar",
  Activity: "Activity",
  Circle: "Circle",
  CircleAlert: "CircleAlert",
  CircleCheck: "CircleCheck",
  CircleDashed: "CircleDashed",
  CircleDot: "CircleDot",
  CirclePause: "CirclePause",
  CircleStop: "CircleStop",
  CircleX: "CircleX",
  Clock3: "Clock3",
  Gauge: "Gauge",
  Loader2: "Loader2",
  LoaderCircle: "LoaderCircle",
  MessageCircleQuestion: "MessageCircleQuestion",
  Play: "Play",
  Target: "Target",
  TriangleAlert: "TriangleAlert",
}));

const { Dashboard } = await import("./dashboard");

describe("Dashboard empty sections", () => {
  test("always renders all four sections with a dedicated placeholder", () => {
    const dashboard = Dashboard({ scope: { kind: "global" } });
    const sections = findAll(dashboard, (element) => (
      typeof element.type === "function" && element.type.name === "DashboardSection"
    ));

    expect(sections.map((section) => section.props?.title)).toEqual([
      "Needs attention",
      "Running now",
      "Continue working",
      "Upcoming",
    ]);
    expect(sections.map((section) => section.props?.count)).toEqual([0, 0, 0, 0]);

    const renderedSections = sections.map((section) => (
      (section.type as (props: Record<string, unknown>) => unknown)(section.props ?? {})
    ));
    expect(renderedSections.map(textContent)).toEqual([
      "Needs attention0Nothing needs your attention.",
      "Running now0No sessions are running.",
      "Continue working0No recent sessions to continue.",
      "Upcoming0No scheduled automations.",
    ]);
  });
});
