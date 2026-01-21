export type RequestOptions = {
  headers?: Record<string, string>;
  query?: Array<[string, string]>;
  body?: string;
  timeoutMs?: number;
};

export type ApiResponse = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  durationMs: number;
};

export class ApiClient {
  constructor(private host: string, private token?: string) {}

  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const url = new URL(path, this.host);
    if (options.query) {
      for (const [key, value] of options.query) {
        url.searchParams.append(key, value);
      }
    }

    const headers = new Headers(options.headers);
    if (this.token) {
      headers.set("authorization", `Bearer ${this.token}`);
    }
    if (options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const controller = new AbortController();
    const timeoutId = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;

    const startedAt = Date.now();
    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeaders[key] = value;
      }

      let data: unknown = null;
      if (response.status !== 204) {
        const contentType = response.headers.get("content-type") ?? "";
        const text = await response.text();
        if (text.length) {
          if (contentType.includes("application/json")) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          } else {
            data = text;
          }
        }
      }

      return {
        status: response.status,
        headers: responseHeaders,
        data,
        durationMs,
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
