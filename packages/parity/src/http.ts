export type BackendName = "python" | "typescript";

export type Backend = {
  readonly name: BackendName;
  readonly baseUrl: string;
};

export type CapturedResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
  readonly text: string;
};

export type RequestSpec = {
  readonly id: string;
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly bearer?: string;
};

const contentTypeBase = (value: string | null) => {
  if (value === null) {
    return null;
  }
  const [base] = value.toLowerCase().split(";", 1);
  return base?.trim() || null;
};

const parseBody = (text: string, contentType: string | null): unknown => {
  if (text.length === 0) {
    return undefined;
  }
  if (contentTypeBase(contentType) === "application/json") {
    return JSON.parse(text) as unknown;
  }
  return text;
};

export const normalizedContentType = contentTypeBase;

export const requestBackend = async (
  backend: Backend,
  request: RequestSpec,
): Promise<CapturedResponse> => {
  const headers = new Headers();
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (request.bearer !== undefined) {
    headers.set("authorization", `Bearer ${request.bearer}`);
  }
  const response = await fetch(`${backend.baseUrl}${request.path}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  return {
    status: response.status,
    contentType,
    body: parseBody(text, contentType),
    text,
  };
};
