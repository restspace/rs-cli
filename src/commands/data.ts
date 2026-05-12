import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import { normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";
import {
  coerceServiceList,
  loadAgentDiscovery,
  loadServices,
  type ServiceEntry,
} from "./discover.ts";

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

function manageHeaders(manage?: boolean): Record<string, string> | undefined {
  return manage ? { "X-Restspace-Request-Mode": "manage" } : undefined;
}

async function sendRequest(
  client: ApiClient,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<ApiResponse> {
  try {
    return await client.request(method, path, { body, headers });
  } catch (error) {
    writeError({
      error: error instanceof Error ? error.message : String(error),
      suggestion: "Check network connectivity and the host URL.",
    });
  }
}

export function dataCommand() {
  const command = new Command()
    .description("Interact with data services (data.base and data.set).")
    .globalOption("--manage", "Set X-Restspace-Request-Mode: manage on requests");

  command.command("list")
    .description("List available data services.")
    .action(async (options) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const hdrs = manageHeaders(options.manage);

      const agentDiscovery = await loadAgentDiscovery(client, hdrs);
      const services: ServiceEntry[] = agentDiscovery?.services
        ? coerceServiceList(agentDiscovery.services)
        : await loadServices(client, hdrs);

      const dataSets = services
        .filter((s) => (s.apis as string[] ?? []).includes("data.set"))
        .map((s) => s.basePath);

      const databaseServices = services.filter((s) =>
        (s.apis as string[] ?? []).includes("data.base")
      );

      const databases: Array<{ basePath: string; folders: unknown }> = [];
      for (const svc of databaseServices) {
        const response = await sendRequest(client, "GET", svc.basePath, undefined, hdrs);
        databases.push({ basePath: svc.basePath, folders: response.data });
      }

      writeSuccess({ dataSets, databases });
    });

  command.command("schema <path:string>")
    .description("Get the schema for a data service path.")
    .action(async (options, path) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const hdrs = manageHeaders(options.manage);

      const schemaPath = path.replace(/\/$/, "") + "/.schema.json";
      const response = await sendRequest(client, "GET", schemaPath, undefined, hdrs);

      if (response.status < 200 || response.status >= 300) {
        writeError({
          status: response.status,
          error: `Failed to fetch schema for ${path}.`,
          suggestion: "Check the path or verify the service has a schema.",
          details: response.data,
        });
      }

      writeSuccess(response.data as Record<string, unknown>);
    });

  command.action(function () {
    this.showHelp();
  });

  return command;
}
