import { describe, expect, mock, test } from "bun:test";

const Fragment = Symbol.for("react.fragment");
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: props ?? {}, key });
mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsx, jsxs: jsx, jsxDEV: jsx }));
let slug = "archcode";
mock.module("react-router-dom", () => ({ Navigate: "Navigate", Outlet: "Outlet", useParams: () => ({ slug }) }));
mock.module("../components/features/ProjectToolbar", () => ({ ProjectToolbar: "ProjectToolbar" }));

const { ProjectLayout, ProjectRoute } = await import("./project");

describe("project routes", () => {
  test("redirects the project root to Todos with replace semantics", () => {
    slug = "archcode";
    const route = ProjectRoute() as { type: unknown; props: Record<string, unknown> };
    expect(route.type).toBe("Navigate");
    expect(route.props).toMatchObject({ replace: true, to: "/projects/archcode/todos" });
  });

  test("owns the project toolbar above its nested route outlet", () => {
    const layout = ProjectLayout() as { props: { children: unknown[] } };
    const children = layout.props.children;
    expect((children[0] as { type: unknown }).type).toBe("ProjectToolbar");
    expect(((children[1] as { props: { children: { type: unknown } } }).props.children).type).toBe("Outlet");
  });

});
