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
let homeData: {
  needsYou: unknown[];
  running: unknown[];
  readyToReview: unknown[];
  upcoming: unknown[];
  projectErrors: unknown[];
} = { needsYou: [], running: [], readyToReview: [], upcoming: [], projectErrors: [] };
mock.module("../api/queries", () => ({
  useHome: () => ({
    data: homeData,
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

const { HomeRoute, formatHomeSchedule, homeEntityLabel, homeStatusLabel } = await import("./home");

describe("Home", () => {
  test("presents product language instead of raw entity and status enums", () => {
    expect(homeEntityLabel("session")).toBe("Session");
    expect(homeEntityLabel("hitl")).toBe("Request");
    expect(homeStatusLabel("running")).toBe("Running");
    expect(homeStatusLabel("ready_to_review")).toBe("Ready to review");
    expect(homeStatusLabel("provider_paused")).toBe("Provider paused");
    expect(homeStatusLabel(" ")).toBe("Status unavailable");
    const now = new Date(2026, 7, 13, 8, 0).getTime();
    expect(formatHomeSchedule(new Date(2026, 7, 13, 9, 0).getTime(), now)).toContain("Today");
    expect(formatHomeSchedule(new Date(2026, 7, 14, 9, 0).getTime(), now)).toContain("Tomorrow");
  });

  test("always renders its four decision sections with explicit empty states", () => {
    homeData = { needsYou: [], running: [], readyToReview: [], upcoming: [], projectErrors: [] };
    const home = HomeRoute();
    const sections = findAll(home, (element) => (
      typeof element.type === "function" && element.type.name === "HomeSection"
    ));

    expect(sections.map((section) => section.props?.title)).toEqual([
      "Needs you",
      "Running",
      "Ready to review",
      "Upcoming",
    ]);
    expect(textContent(home)).toContain("What needs you, what is running, what is ready to review, and what is coming next.");
    expect(textContent(home)).toContain("Work lives in each project’s Todos.");
    const rendered = sections.map((section) => (
      (section.type as (props: Record<string, unknown>) => unknown)(section.props ?? {})
    ));
    expect(rendered.map(textContent)).toEqual([
      "Needs you0Nothing needs your decision.Permission gates and failed runs surface first — nothing else competes here.",
      "Running0No work is running.",
      "Ready to review0No completed Todo work is waiting for review.",
      "Upcoming0No Automation is scheduled soon.",
    ]);
  });

  test("keeps the 920px pairing and renders exact operational row links without metrics", () => {
    const base = { project: { slug: "archcode", name: "ArchCode" }, context: "Lead", sortAt: 1 };
    homeData = {
      needsYou: [{ ...base, kind: "session", entityId: "failed", title: "Broken run", status: "failed", href: "/projects/archcode/sessions/failed" }],
      running: [{ ...base, kind: "session", entityId: "live", title: "Live run", status: "running", href: "/projects/archcode/sessions/live" }],
      readyToReview: [{ ...base, kind: "todo", entityId: "todo", title: "Review result", status: "ready_to_review", href: "/projects/archcode/todos/todo" }],
      upcoming: [{ ...base, kind: "automation", entityId: "auto", title: "Daily check", status: "scheduled", href: "/projects/archcode/automations/auto" }],
      projectErrors: [],
    };
    const home = HomeRoute();
    const grid = findAll(home, (element) => String(element.props?.className).includes("min-[920px]:grid-cols-2"))[0];
    expect(grid).toBeDefined();
    expect(textContent(home)).not.toContain("New Todo");
    expect(textContent(home)).not.toContain("New Session");
    expect(textContent(home)).toContain("Work lives in each project’s Todos.");

    const sections = findAll(home, (element) => typeof element.type === "function" && element.type.name === "HomeSection");
    const renderedSections = sections.map((section) => (section.type as (props: Record<string, unknown>) => unknown)(section.props ?? {}));
    for (const section of renderedSections) {
      const className = String((section as ElementLike).props?.className);
      expect(className).toContain("border-y");
      expect(className).not.toContain("rounded");
      expect(className).not.toContain("shadow");
    }
    const rowElements = renderedSections.flatMap((section) => findAll(section, (element) => typeof element.type === "function" && element.type.name === "HomeRow"));
    const renderedRows = rowElements.map((row) => (row.type as (props: Record<string, unknown>) => unknown)(row.props ?? {}));
    const links = renderedRows.map((row) => findAll(row, (element) => element.type === "Link")[0]);
    expect(links.map((link) => link?.props?.to)).toEqual([
      "/projects/archcode/sessions/failed",
      "/projects/archcode/sessions/live",
      "/projects/archcode/todos/todo",
      "/projects/archcode/automations/auto",
    ]);
    const upcomingSchedule = formatHomeSchedule(1);
    expect(links.map((link) => link?.props?.["aria-label"])).toEqual([
      "Broken run, ArchCode, Session, Failed",
      "Live run, ArchCode, Session, Running",
      "Review result, ArchCode, Todo, Ready to review",
      `Daily check, ArchCode, Automation, Scheduled, ${upcomingSchedule}`,
    ]);
    expect(links.every((link) => String(link?.props?.className).includes("workbench-row-lift"))).toBe(true);
    expect(textContent(renderedRows[1])).not.toContain("RunningRunning");
    expect(textContent(renderedRows[3])).not.toContain("ScheduledScheduled");
    expect(textContent(renderedRows[3]).split(upcomingSchedule)).toHaveLength(2);
    expect(textContent(renderedRows[3])).not.toContain("ArchCode · Automation ·");
  });
});
