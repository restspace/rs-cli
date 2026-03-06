import { writeError } from "./output.ts";

export type RawRequestOptions = {
  headers?: Record<string, string>;
  query?: Array<[string, string]>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  token?: string;
};

export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
};

const TEXTUAL_CONTENT_TYPES = [
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
];

function isTextualContentType(contentType: string): boolean {
  if (!contentType) {
    return true;
  }
  if (contentType.startsWith("text/")) {
    return true;
  }
  return TEXTUAL_CONTENT_TYPES.some((value) => contentType.includes(value));
}

function defaultContentType(body: string | Uint8Array): string {
  if (body instanceof Uint8Array) {
    return "application/octet-stream";
  }
  return "text/plain; charset=utf-8";
}

export async function requestRaw(
  host: string,
  path: string,
  method: string,
  options: RawRequestOptions = {},
): Promise<Response> {
  const url = new URL(path, host);
  if (options.query) {
    for (const [key, value] of options.query) {
      url.searchParams.append(key, value);
    }
  }

  const headers = new Headers(options.headers);
  if (options.token) {
    headers.set("cookie", `rs-auth=${options.token}`);
  }
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", defaultContentType(options.body));
  }

  const controller = new AbortController();
  const timeoutId = options.timeoutMs && options.timeoutMs > 0
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    return await fetch(url.toString(), {
      method,
      headers,
      body: options.body,
      signal: controller.signal,
    });
  } catch (error) {
    writeError({
      error: error instanceof Error ? error.message : String(error),
      suggestion: "Check network connectivity and the host URL.",
    });
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function decodeRawResponse(response: Response): Promise<RawResponse> {
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    responseHeaders[key] = value;
  }

  let data: unknown = null;
  if (response.status !== 204) {
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 0) {
      if (isTextualContentType(contentType)) {
        const text = new TextDecoder().decode(bytes);
        if (contentType.includes("application/json")) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        } else {
          data = text;
        }
      } else {
        data = {
          encoding: "binary",
          byteLength: bytes.length,
          contentType: contentType || null,
        };
      }
    }
  }

  return {
    status: response.status,
    headers: responseHeaders,
    data,
  };
}
