interface ApiErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly status: number;

  constructor(input: { code: string; message: string; details?: unknown; status: number }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.details = input.details;
    this.status = input.status;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | Record<string, unknown> | null;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const headers = createApiHeaders(options.headers);
  const body = normalizeBody(options.body, headers);

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...options,
    body,
    headers,
  });

  if (response.ok) {
    return parseJson<T>(response);
  }

  throw await createApiError(response);
}

export function createApiHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  const password = readServerPasswordCookie();

  if (password && !headers.has("Authorization")) {
    headers.set("Authorization", `Basic ${btoa(`:${password}`)}`);
  }

  return headers;
}

export function apiBaseUrl(): string {
  return "";
}

function normalizeBody(
  body: ApiFetchOptions["body"],
  headers: Headers,
): BodyInit | null | undefined {
  if (body === undefined || body === null) return body;
  if (isBodyInit(body)) return body;

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return JSON.stringify(body);
}

function isBodyInit(value: unknown): value is BodyInit {
  return typeof value === "string"
    || value instanceof Blob
    || value instanceof FormData
    || value instanceof URLSearchParams
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || value instanceof ReadableStream;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function createApiError(response: Response): Promise<ApiError> {
  const payload = await safeParseErrorPayload(response);
  const error = payload?.error;
  const code = typeof error?.code === "string" ? error.code : "HTTP_ERROR";
  const message = typeof error?.message === "string"
    ? error.message
    : `Request failed with status ${response.status}`;

  return new ApiError({
    code,
    message,
    details: error?.details,
    status: response.status,
  });
}

async function safeParseErrorPayload(response: Response): Promise<ApiErrorPayload | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return undefined;
  }
}

function readServerPasswordCookie(): string | undefined {
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("SPECRA_SERVER_PASSWORD="));

  if (!cookie) return undefined;
  return decodeURIComponent(cookie.slice("SPECRA_SERVER_PASSWORD=".length));
}
