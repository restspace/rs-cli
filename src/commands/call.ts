import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import { loadConfig, normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";

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

function parseJsonBody(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    writeError({
      error: "Request body is not valid JSON.",
      suggestion: "Provide a valid JSON string or file.",
    });
  }
}

function parseHeader(value: string): [string, string] {
  const index = value.indexOf(":");
  if (index <= 0) {
    writeError({
      error: "Header must be in key:value format.",
      suggestion: "Example: -H \"x-request-id:123\"",
    });
  }
  const key = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!key) {
    writeError({
      error: "Header key cannot be empty.",
      suggestion: "Example: -H \"x-request-id:123\"",
    });
  }
  return [key, headerValue];
}

function parseQuery(value: string): [string, string] {
  const index = value.indexOf("=");
  if (index <= 0) {
    writeError({
      error: "Query parameter must be in key=value format.",
      suggestion: "Example: -q \"limit=10\"",
    });
  }
  const key = value.slice(0, index).trim();
  const queryValue = value.slice(index + 1);
  if (!key) {
    writeError({
      error: "Query key cannot be empty.",
      suggestion: "Example: -q \"limit=10\"",
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
    return "Verify request JSON and parameters.";
  }
  if (status >= 500) {
    return "Server error. Retry later or check server logs.";
  }
  return "Verify the request parameters and try again.";
}

export function callCommand(): Command {
  return new Command()
    .description("Call a Restspace API endpoint.")
    .arguments("<method:string> <path:string>")
    .option("-d, --data <json:string>", "Request body (JSON string)")
    .option("-f, --file <path:string>", "Read request body from file")
    .option("-H, --header <header:string>", "Additional header", {
      collect: true,
    })
    .option("-q, --query <query:string>", "Query parameter", {
      collect: true,
    })
    .option("--timeout <ms:number>", "Request timeout in milliseconds")
    .action(async (options, method, path) => {
      if (options.data && options.file) {
        writeError({
          error: "Provide either --data or --file, not both.",
          suggestion: "Use -d for inline JSON or -f for a JSON file.",
        });
      }

      const config = await loadConfig();
      const host = resolveHost(config.host);
      const token = config.auth?.token;

      let body: string | undefined;
      if (options.data) {
        body = parseJsonBody(options.data);
      } else if (options.file) {
        const raw = await Deno.readTextFile(options.file);
        body = parseJsonBody(raw);
      }

      const headers: Record<string, string> = {};
      if (options.header) {
        for (const header of options.header as string[]) {
          const [key, value] = parseHeader(header);
          headers[key] = value;
        }
      }

      const query: Array<[string, string]> = [];
      if (options.query) {
        for (const entry of options.query as string[]) {
          query.push(parseQuery(entry));
        }
      }

      const client = new ApiClient(host, token);
      let response: ApiResponse;
      try {
        response = await client.request(method.toUpperCase(), path, {
          headers,
          query,
          body,
          timeoutMs: options.timeout,
        });
      } catch (error) {
        writeError({
          error: error instanceof Error ? error.message : String(error),
          suggestion: "Check network connectivity and the host URL.",
        });
      }

      const metadata = {
        method: method.toUpperCase(),
        path,
        duration: response.durationMs,
      };

      if (response.status < 200 || response.status >= 300) {
        writeError({
          status: response.status,
          error: extractErrorMessage(response.data) ??
            `Request failed with status ${response.status}.`,
          suggestion: suggestionForStatus(response.status),
          metadata,
          details: response.data,
        });
      }

      writeSuccess({
        status: response.status,
        headers: response.headers,
        data: response.data,
        metadata,
      });
    });
}
