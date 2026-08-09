import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const prefix = process.argv[2] ?? "stdio";
const tool = (suffix: string) => ({
  name: `${prefix}.${suffix}`,
  description: `${prefix} paginated fixture tool ${suffix}`,
  inputSchema: {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  annotations: { readOnlyHint: true },
});
const server = new Server(
  { name: "archcode-mcp-stdio-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, ({ params }) => (
  params?.cursor === "page-2"
    ? { tools: [tool("two")] }
    : { tools: [tool("one")], nextCursor: "page-2" }
));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
  content: [{ type: "text", text: String(params.arguments?.value ?? "") }],
}));

await server.connect(new StdioServerTransport());
