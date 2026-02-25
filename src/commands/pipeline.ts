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

async function resolveBody(options: BodyOptions): Promise<string | undefined> {
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
    return "Check the pipeline path or list available pipelines.";
  }
  if (status === 400) {
    return "Verify the pipeline spec or input payload.";
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
): Promise<void> {
  let response: ApiResponse;
  try {
    response = await client.request(method, path, { body });
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

export function pipelineCommand(): Command {
  const command = new Command().description("Pipeline operations.");

  command.command("list [path:string]")
    .description("List stored pipelines.")
    .action(async (_options, path) => {
      if (!path) {
        writeError({
          error: "Missing pipeline store path.",
          suggestion: "Provide a store path, e.g. `rs pipeline list /pipelines`.",
        });
      }
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "GET", path);
    });

  command.command("get <path:string>")
    .description("Get a pipeline spec.")
    .action(async (_options, path) => {
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "GET", path);
    });

  command.command("create <path:string>")
    .description("Create or update a pipeline spec.")
    .option("-d, --data <json:string>", "Pipeline spec (JSON string)")
    .option("-f, --file <path:string>", "Read spec from file")
    .action(async (options, path) => {
      const body = await resolveBody(options);
      if (!body) {
        writeError({
          error: "Missing pipeline spec data.",
          suggestion: "Provide -d or -f with a JSON pipeline spec.",
        });
      }
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "PUT", path, body);
    });

  command.command("execute <path:string>")
    .description("Execute a pipeline.")
    .option("-d, --data <json:string>", "Input payload (JSON string)")
    .option("-f, --file <path:string>", "Read payload from file")
    .action(async (options, path) => {
      const body = await resolveBody(options);
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      await sendRequest(client, "POST", path, body);
    });

  command.command("explain")
    .description("Explain pipeline syntax.")
    .action(() => {
      writeError({
        error: "Pipeline explain is not configured yet.",
        suggestion: "Provide documentation content for pipeline syntax.",
      });
    });

  command.command("validate")
    .description("Validate a pipeline spec.")
    .option("-d, --data <json:string>", "Pipeline spec (JSON string)")
    .option("-f, --file <path:string>", "Read spec from file")
    .action(() => {
      writeError({
        error: "Pipeline validation is not configured yet.",
        suggestion: "Provide validation rules or a server endpoint.",
      });
    });

  return command;
}
