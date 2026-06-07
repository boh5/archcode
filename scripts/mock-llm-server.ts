/// <reference types="bun" />

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Scenario =
  | "normal"
  | "zero-eof-once"
  | "partial-eof-once"
  | "tool-eof-once"
  | "always-zero-eof"
  | "always-partial-eof";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
}

interface MockState {
  requestCount: number;
  streamRequestCount: number;
  failStreamAttempts: number;
  scenario: Scenario;
}

const port = Number(Bun.env.MOCK_LLM_PORT ?? "19998");
const state: MockState = {
  requestCount: 0,
  streamRequestCount: 0,
  failStreamAttempts: parsePositiveInteger(Bun.env.MOCK_LLM_FAIL_STREAM_ATTEMPTS, 1),
  scenario: parseScenario(Bun.env.MOCK_LLM_SCENARIO),
};

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error("[mock-llm] request failed", error);
    if (!response.headersSent) {
      sendJson(response, { error: { message: errorMessage(error) } }, 500);
    } else {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
});

server.listen(port, () => {
  console.log(`[mock-llm] OpenAI-compatible server listening on http://localhost:${port}/v1`);
  console.log(`[mock-llm] scenario=${state.scenario}`);
  console.log("[mock-llm] reset: curl -s -X POST http://localhost:" + port + "/__mock/reset -d '{\"scenario\":\"partial-eof-once\"}'");
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, { ok: true, scenario: state.scenario, requestCount: state.requestCount, streamRequestCount: state.streamRequestCount, failStreamAttempts: state.failStreamAttempts });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, { object: "list", data: [{ id: "mock-model", object: "model", owned_by: "specra-mock" }] });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__mock/reset") {
    const body = await readJsonObject(request);
    state.requestCount = 0;
    state.streamRequestCount = 0;
    if (typeof body.scenario === "string") state.scenario = parseScenario(body.scenario);
    if (typeof body.failStreamAttempts === "number" && Number.isInteger(body.failStreamAttempts) && body.failStreamAttempts > 0) {
      state.failStreamAttempts = body.failStreamAttempts;
    }
    sendJson(response, { ok: true, scenario: state.scenario, requestCount: state.requestCount, streamRequestCount: state.streamRequestCount, failStreamAttempts: state.failStreamAttempts });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readChatRequest(request);
    state.requestCount++;
    const attempt = state.requestCount;
    const streaming = body.stream === true;
    const streamAttempt = streaming ? ++state.streamRequestCount : state.streamRequestCount;
    console.log(`[mock-llm] request #${attempt} streamAttempt=${streaming ? streamAttempt : "-"} failFirstStreams=${state.failStreamAttempts} scenario=${state.scenario} stream=${streaming} model=${body.model ?? "unknown"} user=${JSON.stringify(latestUserText(body).slice(0, 80))}`);

    if (!streaming) {
      sendJson(response, {
        id: completionId(attempt),
        object: "chat.completion",
        created: unixSeconds(),
        model: body.model ?? "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: normalText(body, attempt) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
      });
      return;
    }

    await streamChatCompletion(response, body, streamAttempt, state.scenario);
    return;
  }

  sendJson(response, { error: { message: `Not found: ${request.method ?? "UNKNOWN"} ${url.pathname}` } }, 404);
}

async function streamChatCompletion(
  response: ServerResponse,
  body: ChatCompletionRequest,
  streamAttempt: number,
  scenario: Scenario,
): Promise<void> {
  const shouldFail = shouldFailAttempt(scenario, streamAttempt);

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  await writeChunk(response, roleChunk(body, streamAttempt));

  if (scenario === "zero-eof-once" || scenario === "always-zero-eof") {
    if (shouldFail) return abortStream(response, "mock zero-output unexpected EOF");
  }

  if (scenario === "tool-eof-once" && shouldFail) {
    await writeChunk(response, toolCallChunk(body, streamAttempt));
    return abortStream(response, "mock toolCalls finalization unexpected EOF");
  }

  const text = normalText(body, streamAttempt);
  const first = shouldFail && (scenario === "partial-eof-once" || scenario === "always-partial-eof")
    ? "MOCK_PARTIAL_VISIBLE_SHOULD_NOT_REPLAY"
    : text;

  await writeChunk(response, textChunk(body, streamAttempt, first));

  if ((scenario === "partial-eof-once" || scenario === "always-partial-eof") && shouldFail) {
    return abortStream(response, "mock partial-output unexpected EOF");
  }

  if (first !== text) {
    await writeChunk(response, textChunk(body, streamAttempt, "\nRecovered final response from mock server."));
  }

  await writeChunk(response, finishChunk(body, streamAttempt));
  response.write("data: [DONE]\n\n");
  response.end();
}

function shouldFailAttempt(scenario: Scenario, attempt: number): boolean {
  if (scenario.startsWith("always-")) return true;
  if (scenario === "normal") return false;
  return attempt <= state.failStreamAttempts;
}

function abortStream(response: ServerResponse, message: string): void {
  console.log(`[mock-llm] destroying socket: ${message}`);
  response.socket?.destroy(new Error(message));
}

async function writeChunk(
  response: ServerResponse,
  value: unknown,
): Promise<void> {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
  await Bun.sleep(25);
}

function roleChunk(body: ChatCompletionRequest, attempt: number): Record<string, unknown> {
  return baseChunk(body, attempt, { role: "assistant" }, null);
}

function textChunk(body: ChatCompletionRequest, attempt: number, content: string): Record<string, unknown> {
  return baseChunk(body, attempt, { content }, null);
}

function toolCallChunk(body: ChatCompletionRequest, attempt: number): Record<string, unknown> {
  return baseChunk(body, attempt, {
    tool_calls: [{
      index: 0,
      id: "call_mock_echo",
      type: "function",
      function: { name: firstToolName(body), arguments: "{\"message\":\"mock tool call before EOF\"}" },
    }],
  }, null);
}

function finishChunk(body: ChatCompletionRequest, attempt: number): Record<string, unknown> {
  return baseChunk(body, attempt, {}, "stop");
}

function baseChunk(
  body: ChatCompletionRequest,
  attempt: number,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id: completionId(attempt),
    object: "chat.completion.chunk",
    created: unixSeconds(),
    model: body.model ?? "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function normalText(body: ChatCompletionRequest, attempt: number): string {
  const userText = latestUserText(body).slice(0, 80);
  return `Mock LLM recovered response #${attempt}. Latest user message: ${userText}`;
}

function latestUserText(body: ChatCompletionRequest): string {
  const latestUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  if (typeof latestUser?.content === "string") return latestUser.content;
  if (Array.isArray(latestUser?.content)) return JSON.stringify(latestUser.content);
  return "no user text";
}

function firstToolName(body: ChatCompletionRequest): string {
  const firstTool = body.tools?.[0];
  if (!isRecord(firstTool)) return "echo";
  const functionDef = firstTool.function;
  if (!isRecord(functionDef) || typeof functionDef.name !== "string") return "echo";
  return functionDef.name;
}

async function readChatRequest(request: IncomingMessage): Promise<ChatCompletionRequest> {
  const body = await readJsonObject(request);
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    messages: Array.isArray(body.messages) ? body.messages.filter(isRecord).map(toChatMessage) : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
  };
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const text = await readRequestText(request);
    const value: unknown = text.length === 0 ? {} : JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function readRequestText(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return text;
}

function toChatMessage(value: Record<string, unknown>): ChatMessage {
  return {
    role: typeof value.role === "string" ? value.role : undefined,
    content: value.content,
  };
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
}

function completionId(attempt: number): string {
  return `chatcmpl-mock-${attempt}`;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseScenario(value: string | undefined): Scenario {
  switch (value) {
    case "normal":
    case "zero-eof-once":
    case "partial-eof-once":
    case "tool-eof-once":
    case "always-zero-eof":
    case "always-partial-eof":
      return value;
    default:
      return "partial-eof-once";
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
