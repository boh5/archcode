import { afterEach, describe, expect, mock, test } from "bun:test";
import { invalidateAutomation } from "./mutations";
import { activeAutomationsQueryOptions, automationInvocationsQueryOptions, automationQueryOptions, automationsQueryOptions, queryKeys } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("Automation API queries", () => {
  test("uses only Automation REST paths", async () => {
    globalThis.document = { cookie: "" } as Document;
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (String(input).endsWith("/invocations")) return response({ invocations: [] });
      if (String(input).includes("/automations/")) return response({ automation: { id: "a1" } });
      return response({ automations: [] });
    }) as unknown as typeof fetch;

    await automationsQueryOptions("demo space").queryFn!({} as never);
    await automationQueryOptions("demo space", "a1").queryFn!({} as never);
    await automationInvocationsQueryOptions("demo space", "a1").queryFn!({} as never);
    await activeAutomationsQueryOptions().queryFn!({} as never);

    expect(requests).toEqual([
      "/api/projects/demo%20space/automations",
      "/api/projects/demo%20space/automations/a1",
      "/api/projects/demo%20space/automations/a1/invocations",
      "/api/automations?status=active",
    ]);
  });
});

test("Automation invalidation refreshes list, dashboard, detail, and history", async () => {
  const calls: unknown[] = [];
  await invalidateAutomation({ invalidateQueries: async (input) => { calls.push(input.queryKey); } }, "demo", "a1");
  expect(calls).toEqual([
    queryKeys.projectAutomations("demo"),
    queryKeys.activeAutomations,
    queryKeys.automation("demo", "a1"),
    queryKeys.automationInvocations("demo", "a1"),
  ]);
});
