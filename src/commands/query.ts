import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import { loadConfig, normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";

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

async function resolveJsonBody(options: BodyOptions): Promise<string | undefined> {
  if (options.data && options.file) {
    writeError({
      error: "Provide either --data or --file, not both.",
      suggestion: "Use -d for inline JSON or -f for a JSON file.",
    });
  }
  if (options.data) {
    return parseJsonBody(options.data);
  }
  if (options.file) {
    const raw = await Deno.readTextFile(options.file);
    return parseJsonBody(raw);
  }
  return undefined;
}

async function resolveTextBody(options: BodyOptions): Promise<string | undefined> {
  if (options.data && options.file) {
    writeError({
      error: "Provide either --data or --file, not both.",
      suggestion: "Use -d for inline text or -f for a file.",
    });
  }
  if (options.data) {
    return options.data;
  }
  if (options.file) {
    return await Deno.readTextFile(options.file);
  }
  return undefined;
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
    return "Check the query path or list available queries.";
  }
  if (status === 400) {
    return "Verify the query template or parameters.";
  }
  if (status >= 500) {
    return "Server error. Retry later or check server logs.";
  }
  return "Verify the request parameters and try again.";
}

async function sendRequest(
  client: ApiClient,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<void> {
  let response: ApiResponse;
  try {
    response = await client.request(method, path, { body, headers });
  } catch (error) {
    writeError({
      error: error instanceof Error ? error.message : String(error),
      suggestion: "Check network connectivity and the host URL.",
    });
  }

  const metadata = {
    method,
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
}

export function queryCommand(): Command {
  const command = new Command().description("Query operations.");

  command.command("list [path:string]")
    .description("List stored queries.")
    .action(async (_options, path) => {
      if (!path) {
        writeError({
          error: "Missing query store path.",
          suggestion: "Provide a store path, e.g. `rs query list /queries`.",
        });
      }
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "GET", path);
    });

  command.command("get <path:string>")
    .description("Get a query template.")
    .action(async (_options, path) => {
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "GET", path);
    });

  command.command("create <path:string>")
    .description("Create or update a query template.")
    .option("-d, --data <text:string>", "Query template text")
    .option("-f, --file <path:string>", "Read template from file")
    .action(async (options, path) => {
      const body = await resolveTextBody(options);
      if (!body) {
        writeError({
          error: "Missing query template data.",
          suggestion: "Provide -d or -f with a query template.",
        });
      }
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "PUT", path, body, {
        "content-type": "text/plain",
      });
    });

  command.command("execute <path:string>")
    .description("Execute a query with parameters.")
    .option("-d, --data <json:string>", "Input parameters (JSON string)")
    .option("-f, --file <path:string>", "Read parameters from file")
    .action(async (options, path) => {
      const body = await resolveJsonBody(options);
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "POST", path, body);
    });

  command.command("explain")
    .description("Explain query syntax.")
    .action(() => {
      writeError({
        error: "Query explain is not configured yet.",
        suggestion: "Provide documentation content for query syntax.",
      });
    });

  return command;
}
