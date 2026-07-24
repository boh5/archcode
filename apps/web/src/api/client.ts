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
  /** Login and Setup handle their own credential failures inline. */
  authFailure?: "invalidate" | "ignore";
}

type AuthInvalidationListener = () => void;
const authInvalidationListeners = new Set<AuthInvalidationListener>();

export function subscribeAuthInvalidation(listener: AuthInvalidationListener): () => void {
  authInvalidationListeners.add(listener);
  return () => authInvalidationListeners.delete(listener);
}

export function notifyAuthInvalidated(): void {
  for (const listener of authInvalidationListeners) listener();
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { authFailure = "invalidate", body: requestedBody, ...requestOptions } = options;
  const headers = createApiHeaders(requestOptions.headers);
  const body = normalizeBody(requestedBody, headers);

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...requestOptions,
    body,
    headers,
    credentials: "same-origin",
  });

  if (response.ok) {
    return parseJson<T>(response);
  }

  const error = await createApiError(response);
  if (error.status === 401 && authFailure !== "ignore") notifyAuthInvalidated();
  throw error;
}

export function createApiHeaders(input?: HeadersInit): Headers {
  return new Headers(input);
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
