import { Command } from "cliffy/command/mod.ts";
import { dirname } from "std/path/mod.ts";
import { normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { decodeRawResponse, requestRaw } from "../lib/raw-request.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";

type BodyOptions = {
  data?: string;
  file?: string;
};

function resolveHost(host?: string): string {
  if (!host) {
    writeError({
      error: "Missing host configuration.",
      suggestion: "Run `rs config set host <url>`.",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    writeError({
      error: "Invalid host URL.",
      suggestion: "Use a full URL such as https://tenant.restspace.io.",
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    writeError({
      error: "Host URL must start with http:// or https://.",
      suggestion: "Use a full URL such as https://tenant.restspace.io.",
    });
  }
  return normalizeHost(parsed.toString());
}

function parseHeader(value: string): [string, string] {
  const index = value.indexOf(":");
  if (index <= 0) {
    writeError({
      error: "Header must be in key:value format.",
      suggestion: 'Example: -H "x-request-id:123"',
    });
  }
  const key = value.slice(0, index).trim().toLowerCase();
  const headerValue = value.slice(index + 1).trim();
  if (!key) {
    writeError({
      error: "Header key cannot be empty.",
      suggestion: 'Example: -H "x-request-id:123"',
    });
  }
  return [key, headerValue];
}

function parseQuery(value: string): [string, string] {
  const index = value.indexOf("=");
  if (index <= 0) {
    writeError({
      error: "Query parameter must be in key=value format.",
      suggestion: 'Example: -q "limit=10"',
    });
  }
  const key = value.slice(0, index).trim();
  const queryValue = value.slice(index + 1);
  if (!key) {
    writeError({
      error: "Query key cannot be empty.",
      suggestion: 'Example: -q "limit=10"',
    });
  }
  return [key, queryValue];
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") {
    return record.error;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return undefined;
}

function suggestionForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Authenticate with `rs login` and retry.";
  }
  if (status === 404) {
    return "Check the path or use `rs discover services` to confirm endpoints.";
  }
  if (status === 400) {
    return "Verify the request body, headers, and parameters.";
  }
  if (status >= 500) {
    return "Server error. Retry later or check server logs.";
  }
  return "Verify the request parameters and try again.";
}

async function resolveBody(
  options: BodyOptions,
): Promise<string | Uint8Array | undefined> {
  if (options.data && options.file) {
    writeError({
      error: "Provide either --data or --file, not both.",
      suggestion: "Use -d for inline text or -f for a file body.",
    });
  }
  if (options.data !== undefined) {
    return options.data;
  }
  if (options.file) {
    return await Deno.readFile(options.file);
  }
  return undefined;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  return headers;
}

async function writeResponseBody(
  response: Response,
  outputPath: string,
): Promise<{
  byteLength: number;
  contentType: string | null;
}> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  await Deno.writeFile(outputPath, bytes);
  return {
    byteLength: bytes.length,
    contentType: response.headers.get("content-type"),
  };
}

export function sendCommand() {
  return new Command()
    .description(
      "Send an arbitrary HTTP request body.\n\nExamples:\n" +
        "  rs send PUT /files/logo.png -f ./logo.png --content-type image/png\n" +
        "  rs send POST /hooks/test -d 'hello' --content-type text/plain\n" +
        "  rs send POST /api/items -f ./payload.json --content-type application/json\n" +
        "  rs send GET /files/logo.png --output ./downloads/logo.png",
    )
    .arguments("<method:string> <path:string>")
    .option("-d, --data <text:string>", "Raw request body as inline text")
    .option("-f, --file <path:string>", "Read request body from file as bytes")
    .option(
      "--content-type <type:string>",
      "Content-Type header for the request body",
    )
    .option("-o, --output <path:string>", "Write the response body to a file")
    .option("-H, --header <header:string>", "Additional header", {
      collect: true,
    })
    .option("-q, --query <query:string>", "Query parameter", {
      collect: true,
    })
    .option("--timeout <ms:number>", "Request timeout in milliseconds")
    .action(async (options, method, path) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const token = config.auth?.token;
      const body = await resolveBody(options);

      const headers: Record<string, string> = {};
      if (options.header) {
        for (const header of options.header as string[]) {
          const [key, value] = parseHeader(header);
          headers[key] = value;
        }
      }
      if (options.contentType) {
        headers["content-type"] = options.contentType;
      }

      const query: Array<[string, string]> = [];
      if (options.query) {
        for (const entry of options.query as string[]) {
          query.push(parseQuery(entry));
        }
      }

      const startedAt = Date.now();
      const response = await requestRaw(host, path, method.toUpperCase(), {
        token,
        headers,
        query,
        body,
        timeoutMs: options.timeout,
      });
      const durationMs = Date.now() - startedAt;

      const metadata = {
        method: method.toUpperCase(),
        path,
        duration: durationMs,
        requestBodySource: options.file
          ? "file"
          : options.data !== undefined
          ? "inline"
          : "none",
        responseBodyDestination: options.output ? "file" : "stdout",
      };

      if (response.status < 200 || response.status >= 300) {
        const decoded = await decodeRawResponse(response);
        writeError({
          status: decoded.status,
          error: extractErrorMessage(decoded.data) ??
            `Request failed with status ${decoded.status}.`,
          suggestion: suggestionForStatus(decoded.status),
          metadata,
          details: decoded.data,
        });
      }

      if (options.output) {
        const saved = await writeResponseBody(response, options.output);
        writeSuccess({
          status: response.status,
          headers: responseHeaders(response),
          metadata,
          output: {
            path: options.output,
            byteLength: saved.byteLength,
            contentType: saved.contentType,
          },
        });
        return;
      }

      const decoded = await decodeRawResponse(response);
      writeSuccess({
        status: decoded.status,
        headers: decoded.headers,
        data: decoded.data,
        metadata,
      });
    });
}
