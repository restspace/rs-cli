import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import { normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";

const SERVICES_ENDPOINT = "/.well-known/restspace/services";
const AGENT_DISCOVERY_ENDPOINT =
  "/.well-known/restspace/services/agent-discovery";

type JsonRecord = Record<string, unknown>;
type ServiceEntry = JsonRecord & { basePath: string };
type AgentDiscovery = {
  services?: unknown;
  patterns?: unknown;
  concepts?: unknown;
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

function patternFromApis(apis?: unknown): string | undefined {
  if (!Array.isArray(apis)) {
    return undefined;
  }
  const apiList = apis.filter((api) => typeof api === "string") as string[];
  if (apiList.includes("store-transform")) return "store-transform";
  if (apiList.includes("store-view")) return "store-view";
  if (apiList.includes("store-operation")) return "store-operation";
  if (apiList.includes("store-directory")) return "store-directory";
  if (apiList.includes("transform")) return "transform";
  if (apiList.includes("view")) return "view";
  if (apiList.includes("operation")) return "operation";
  if (apiList.includes("directory")) return "directory";
  if (apiList.includes("store")) return "store";
  return undefined;
}

const patternDescriptions: Record<string, string> = {
  store: "RESTful CRUD directory",
  "store-transform": "Store + transform combined",
  "store-view": "Stored resources with view semantics",
  "store-operation": "Stored resources that trigger operations",
  "store-directory": "Store with fixed directory structure",
  transform: "POST-only transformation endpoint",
  view: "Read-only GET endpoint",
  operation: "Action endpoint (no response body)",
  directory: "Fixed URL structure",
};

function coerceServiceList(data: unknown): ServiceEntry[] {
  if (Array.isArray(data)) {
    return data.filter((entry) =>
      entry && typeof entry === "object" && "basePath" in entry
    ) as ServiceEntry[];
  }
  if (!data || typeof data !== "object") {
    return [];
  }
  return Object.entries(data as Record<string, unknown>).map(
    ([basePath, value]) => {
      const entry = (value && typeof value === "object")
        ? { ...(value as JsonRecord) }
        : {};
      const apis = entry.apis;
      const pattern = typeof entry.pattern === "string"
        ? entry.pattern
        : patternFromApis(apis);
      if (pattern && !entry.patternDescription) {
        entry.patternDescription = patternDescriptions[pattern];
      }
      return {
        basePath,
        ...entry,
      } as ServiceEntry;
    },
  );
}

async function request(
  client: ApiClient,
  path: string,
): Promise<ApiResponse> {
  try {
    return await client.request("GET", path);
  } catch (error) {
    writeError({
      error: error instanceof Error ? error.message : String(error),
      suggestion: "Check network connectivity and the host URL.",
    });
  }
}

async function loadAgentDiscovery(
  client: ApiClient,
): Promise<AgentDiscovery | null> {
  const response = await request(client, AGENT_DISCOVERY_ENDPOINT);
  if (response.status === 404) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    writeError({
      status: response.status,
      error: "Failed to load agent discovery data.",
      suggestion: "Check server configuration or try `rs discover services`.",
      details: response.data,
    });
  }
  if (!response.data || typeof response.data !== "object") {
    return null;
  }
  return response.data as AgentDiscovery;
}

async function loadServices(client: ApiClient): Promise<ServiceEntry[]> {
  const response = await request(client, SERVICES_ENDPOINT);
  if (response.status < 200 || response.status >= 300) {
    writeError({
      status: response.status,
      error: "Failed to load services.",
      suggestion: "Check server configuration or permissions.",
      details: response.data,
    });
  }
  return coerceServiceList(response.data);
}

async function loadJsonFile(relativePath: string): Promise<unknown> {
  const url = new URL(relativePath, import.meta.url);
  const raw = await Deno.readTextFile(url);
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function loadConcepts(): Promise<Record<string, unknown>> {
  const concepts: Record<string, unknown> = {};
  const mappings: Array<[string, string]> = [
    ["services", "../concepts/services.json"],
    ["pipelines", "../concepts/pipelines.json"],
    ["queries", "../concepts/queries.json"],
  ];
  for (const [key, path] of mappings) {
    concepts[key] = await loadJsonFile(path);
  }
  return concepts;
}

export function discoverCommand() {
  const command = new Command()
    .description("Discover available services and patterns.");

  command.command("services")
    .description("List all configured services.")
    .action(async () => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(client);
      if (agentDiscovery?.services) {
        writeSuccess({ services: coerceServiceList(agentDiscovery.services) });
        return;
      }
      const services = await loadServices(client);
      writeSuccess({ services });
    });

  command.command("service <basePath:string>")
    .description("Get details for a single service.")
    .action(async (_options, basePath) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(client);
      const services = agentDiscovery?.services
        ? coerceServiceList(agentDiscovery.services)
        : await loadServices(client);
      const service = services.find((entry) => entry.basePath === basePath);
      if (!service) {
        writeError({
          error: "Service not found.",
          suggestion: "Run `rs discover services` to list valid base paths.",
        });
      }
      writeSuccess({ service });
    });

  command.command("patterns")
    .description("Explain all API patterns.")
    .action(async () => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(client);
      if (agentDiscovery?.patterns) {
        writeSuccess({ patterns: agentDiscovery.patterns });
        return;
      }
      const patterns = await loadJsonFile("../concepts/patterns.json");
      writeSuccess({ patterns });
    });

  command.command("pattern <name:string>")
    .description("Explain a specific API pattern.")
    .action(async (_options, name) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(client);
      let patterns: Record<string, unknown> = {};
      if (
        agentDiscovery?.patterns && typeof agentDiscovery.patterns === "object"
      ) {
        patterns = agentDiscovery.patterns as Record<string, unknown>;
      } else {
        const loaded = await loadJsonFile("../concepts/patterns.json");
        if (loaded && typeof loaded === "object") {
          patterns = loaded as Record<string, unknown>;
        }
      }
      const pattern = patterns[name];
      if (!pattern) {
        writeError({
          error: "Pattern not found.",
          suggestion: "Run `rs discover patterns` to list available patterns.",
        });
      }
      writeSuccess({ pattern });
    });

  command.command("concepts")
    .description("Explain all Restspace concepts.")
    .action(async () => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(client);
      if (agentDiscovery?.concepts) {
        writeSuccess({ concepts: agentDiscovery.concepts });
        return;
      }
      const concepts = await loadConcepts();
      writeSuccess({ concepts });
    });

  command.command("concept <name:string>")
    .description("Explain a specific concept.")
    .action(async (_options, name) => {
      const concepts = await loadConcepts();
      const concept = concepts[name];
      if (!concept) {
        writeError({
          error: "Concept not found.",
          suggestion: "Run `rs discover concepts` to list available concepts.",
        });
      }
      writeSuccess({ concept });
    });

  command.action(function () {
    this.showHelp();
  });

  return command;
}
