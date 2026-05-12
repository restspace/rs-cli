import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import { normalizeHost } from "../lib/config-store.ts";
import { writeError, writeRaw, writeSuccess } from "../lib/output.ts";
import { requestRaw } from "../lib/raw-request.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";

const SERVICES_ENDPOINT = "/.well-known/restspace/services";
const SERVICES_JSONC_ENDPOINT = "/services.jsonc";
const CATALOGUE_ENDPOINT = "/.well-known/restspace/catalogue";
const AGENT_DISCOVERY_ENDPOINT =
  "/.well-known/restspace/services/agent-discovery";
const AGENT_DISCOVERY_RAW_ENDPOINT =
  "/.well-known/restspace/services/agent-discovery/raw.jsonc";

type JsonRecord = Record<string, unknown>;
export type ServiceEntry = JsonRecord & { basePath: string };
export type ServiceSummary = {
  description: string;
  name: string;
  basePath: string;
};
type CatalogueMatch = {
  key: string;
  entry: JsonRecord;
};
type CatalogueSummary = {
  services: Record<string, string>;
  adapters: Record<string, string>;
};
type AgentDiscovery = {
  services?: unknown;
  patterns?: unknown;
  concepts?: unknown;
};
type ScanState = {
  inString: boolean;
  escape: boolean;
  depth: number;
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

export function coerceServiceList(data: unknown): ServiceEntry[] {
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

function manageHeaders(manage?: boolean): Record<string, string> | undefined {
  return manage ? { "X-Restspace-Request-Mode": "manage" } : undefined;
}

async function request(
  client: ApiClient,
  path: string,
  headers?: Record<string, string>,
): Promise<ApiResponse> {
  try {
    return await client.request("GET", path, { headers });
  } catch (error) {
    writeError({
      error: error instanceof Error ? error.message : String(error),
      suggestion: "Check network connectivity and the host URL.",
    });
  }
}

export async function loadAgentDiscovery(
  client: ApiClient,
  headers?: Record<string, string>,
): Promise<AgentDiscovery | null> {
  const response = await request(client, AGENT_DISCOVERY_ENDPOINT, headers);
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

export async function loadAgentDiscoveryJsonc(
  host: string,
  token?: string,
  headers?: Record<string, string>,
): Promise<string> {
  const response = await requestRaw(host, AGENT_DISCOVERY_RAW_ENDPOINT, "GET", {
    token,
    headers,
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    writeError({
      status: response.status,
      error: "Failed to load agent discovery data.",
      suggestion: "Check server configuration or permissions.",
      details: text,
    });
  }
  return text;
}

export async function loadServicesJsonc(
  host: string,
  token?: string,
  headers?: Record<string, string>,
): Promise<string> {
  const response = await requestRaw(host, SERVICES_JSONC_ENDPOINT, "GET", {
    token,
    headers,
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    writeError({
      status: response.status,
      error: "Failed to load services.jsonc.",
      suggestion: "Check server configuration or permissions.",
      details: text,
    });
  }
  return text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateScanState(line: string, state: ScanState): ScanState {
  let { inString, escape, depth } = state;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && next === "/") {
      break;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
    }
  }
  return { inString, escape, depth };
}

function findObjectEndLine(lines: string[], startLine: number): number | null {
  let state: ScanState = {
    inString: false,
    escape: false,
    depth: 0,
  };
  for (let index = startLine; index < lines.length; index++) {
    state = updateScanState(lines[index], state);
    if (state.depth === 0) {
      return index;
    }
  }
  return null;
}

export function extractServiceJsonc(
  raw: string,
  basePath: string,
): string | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const servicesLineIndex = lines.findIndex((line) =>
    /^\s*"services"\s*:\s*\{\s*$/.test(line)
  );
  if (servicesLineIndex < 0) {
    return null;
  }

  const servicesEndLine = findObjectEndLine(lines, servicesLineIndex);
  if (servicesEndLine === null) {
    return null;
  }

  const serviceLinePattern = new RegExp(
    `^\\s*${escapeRegExp(JSON.stringify(basePath))}\\s*:\\s*\\{\\s*$`,
  );
  let serviceLineIndex = -1;
  for (
    let index = servicesLineIndex + 1;
    index < servicesEndLine;
    index++
  ) {
    if (serviceLinePattern.test(lines[index])) {
      serviceLineIndex = index;
      break;
    }
  }
  if (serviceLineIndex < 0) {
    return null;
  }

  let snippetStart = serviceLineIndex;
  while (
    snippetStart > servicesLineIndex + 1 &&
    lines[snippetStart - 1].trimStart().startsWith("//")
  ) {
    snippetStart--;
  }

  const serviceEndLine = findObjectEndLine(lines, serviceLineIndex);
  if (serviceEndLine === null || serviceEndLine > servicesEndLine) {
    return null;
  }

  const snippetLines = lines.slice(snippetStart, serviceEndLine + 1);
  const lastLineIndex = snippetLines.length - 1;
  snippetLines[lastLineIndex] = snippetLines[lastLineIndex].replace(
    /,\s*$/,
    "",
  );
  return snippetLines.join("\n");
}

function stripJsoncComments(raw: string): string {
  let output = "";
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    const next = raw[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "\n" || char === "\r") {
        output += char;
        continue;
      }
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

function removeTrailingCommas(json: string): string {
  let output = "";
  let inString = false;
  let escape = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (inString) {
      output += char;
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(json[nextIndex] ?? "")) {
        nextIndex++;
      }
      if (json[nextIndex] === "}" || json[nextIndex] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function parseJsonc(raw: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsoncComments(raw)));
}

function cleanLineComment(line: string): string {
  return line.trimStart().replace(/^\/\/\s?/, "").trimEnd();
}

function cleanBlockComment(lines: string[]): string {
  const joined = lines.join("\n");
  const content = joined
    .replace(/^[\s\S]*?\/\*/, "")
    .replace(/\*\/[\s\S]*$/, "");
  return content
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function extractLeadingServiceComment(raw: string, basePath: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const serviceLinePattern = new RegExp(
    `^\\s*${escapeRegExp(JSON.stringify(basePath))}\\s*:`,
  );
  const serviceLineIndex = lines.findIndex((line) =>
    serviceLinePattern.test(line)
  );
  if (serviceLineIndex < 1) {
    return "";
  }

  const chunks: string[] = [];
  let index = serviceLineIndex - 1;
  while (index >= 0) {
    const line = lines[index];
    const trimmedStart = line.trimStart();
    const trimmedEnd = line.trimEnd();

    if (trimmedStart.startsWith("//")) {
      const commentLines: string[] = [];
      while (index >= 0 && lines[index].trimStart().startsWith("//")) {
        commentLines.unshift(cleanLineComment(lines[index]));
        index--;
      }
      chunks.unshift(commentLines.join("\n").trim());
      continue;
    }

    if (trimmedEnd.endsWith("*/")) {
      const blockLines: string[] = [];
      while (index >= 0) {
        blockLines.unshift(lines[index]);
        if (lines[index].includes("/*")) {
          break;
        }
        index--;
      }
      if (blockLines[0]?.includes("/*")) {
        chunks.unshift(cleanBlockComment(blockLines));
        index--;
        continue;
      }
    }

    break;
  }

  return chunks.filter(Boolean).join("\n").trim();
}

function prependDescription(comment: string, description: string): string {
  if (comment && description) {
    return `${comment}\n\n${description}`;
  }
  return comment || description;
}

export function parseServicesJsoncSummaries(raw: string): ServiceSummary[] {
  const parsed = parseJsonc(raw);
  const services = isRecord(parsed) && isRecord(parsed.services)
    ? parsed.services
    : parsed;

  if (Array.isArray(services)) {
    return services
      .filter(isRecord)
      .map((service) => {
        const basePath = typeof service.basePath === "string"
          ? service.basePath
          : "";
        const comment = basePath
          ? extractLeadingServiceComment(raw, basePath)
          : "";
        const description = typeof service.description === "string"
          ? service.description
          : "";
        return {
          description: prependDescription(comment, description),
          name: typeof service.name === "string" ? service.name : "",
          basePath,
        };
      });
  }

  if (!isRecord(services)) {
    return [];
  }

  const summaries: ServiceSummary[] = [];
  for (const [basePath, service] of Object.entries(services)) {
    if (!isRecord(service)) {
      continue;
    }
    const description = typeof service.description === "string"
      ? service.description
      : "";
    const comment = extractLeadingServiceComment(raw, basePath);
    summaries.push({
      description: prependDescription(comment, description),
      name: typeof service.name === "string" ? service.name : "",
      basePath,
    });
  }
  return summaries;
}

export async function loadServices(
  client: ApiClient,
  headers?: Record<string, string>,
): Promise<ServiceEntry[]> {
  const response = await request(client, SERVICES_ENDPOINT, headers);
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

export async function loadCatalogue(
  client: ApiClient,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await request(client, CATALOGUE_ENDPOINT, headers);
  if (response.status < 200 || response.status >= 300) {
    writeError({
      status: response.status,
      error: "Failed to load the service catalogue.",
      suggestion: "Check server configuration or permissions.",
      details: response.data,
    });
  }
  return response.data;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summarizeCatalogueSection(section: unknown): Record<string, string> {
  const summary: Record<string, string> = {};
  const entries = Array.isArray(section)
    ? section
    : isRecord(section)
    ? Object.values(section)
    : [];

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }
    summary[entry.name] = typeof entry.description === "string"
      ? entry.description
      : "";
  }
  return summary;
}

export function summarizeCatalogue(catalogue: unknown): CatalogueSummary {
  const source = isRecord(catalogue) ? catalogue : {};
  return {
    services: summarizeCatalogueSection(source.services),
    adapters: summarizeCatalogueSection(source.adapters),
  };
}

export function findCatalogueEntry(
  catalogue: unknown,
  lookup: string,
): CatalogueMatch | null {
  if (Array.isArray(catalogue)) {
    for (const item of catalogue) {
      if (!isRecord(item)) continue;
      if (
        item.basePath === lookup ||
        item.name === lookup ||
        item.key === lookup
      ) {
        const key = typeof item.basePath === "string"
          ? item.basePath
          : typeof item.name === "string"
          ? item.name
          : lookup;
        return { key, entry: item };
      }
    }
    return null;
  }
  if (!isRecord(catalogue)) {
    return null;
  }
  const direct = catalogue[lookup];
  if (isRecord(direct)) {
    return { key: lookup, entry: direct };
  }
  for (const [key, value] of Object.entries(catalogue)) {
    if (
      isRecord(value) &&
      (value.basePath === lookup || value.name === lookup ||
        value.key === lookup)
    ) {
      return { key, entry: value };
    }
  }
  return null;
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
    .description("Discover available services and patterns.")
    .globalOption(
      "--manage",
      "Set X-Restspace-Request-Mode: manage on requests",
    );

  command.command("services")
    .description("List all configured services.")
    .action(async (options) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const hdrs = manageHeaders(options.manage);
      const jsonc = await loadServicesJsonc(
        host,
        config.auth?.token,
        hdrs,
      );
      const services = parseServicesJsoncSummaries(jsonc);
      writeRaw(`${JSON.stringify(services, null, 2)}\n`);
    });

  command.command("catalogue [name:string]")
    .description("Show the full catalogue or one service or adapter entry.")
    .action(async (options, name?: string) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const catalogue = await loadCatalogue(
        client,
        manageHeaders(options.manage),
      );
      if (!name) {
        writeRaw(`${JSON.stringify(summarizeCatalogue(catalogue), null, 2)}\n`);
        return;
      }
      const match = findCatalogueEntry(catalogue, name);
      if (!match) {
        writeError({
          error: "Catalogue entry not found.",
          suggestion: "Run `rs discover catalogue` to list available entries.",
        });
      }
      writeSuccess({
        catalogueEntry: {
          key: match.key,
          ...match.entry,
        },
      });
    });

  command.command("service <basePath:string>")
    .description("Get details for a single service.")
    .action(async (options, basePath) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const hdrs = manageHeaders(options.manage);
      const jsonc = await loadAgentDiscoveryJsonc(
        host,
        config.auth?.token,
        hdrs,
      );
      const snippet = extractServiceJsonc(jsonc, basePath);
      if (!snippet) {
        writeError({
          error: "Service not found.",
          suggestion: "Run `rs discover services` to list valid base paths.",
        });
      }
      writeRaw(`${snippet}\n`);
    });

  command.command("patterns")
    .description("Explain all API patterns.")
    .action(async (options) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(
        client,
        manageHeaders(options.manage),
      );
      if (agentDiscovery?.patterns) {
        writeSuccess({ patterns: agentDiscovery.patterns });
        return;
      }
      const patterns = await loadJsonFile("../concepts/patterns.json");
      writeSuccess({ patterns });
    });

  command.command("pattern <name:string>")
    .description("Explain a specific API pattern.")
    .action(async (options, name) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(
        client,
        manageHeaders(options.manage),
      );
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
    .action(async (options) => {
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const client = new ApiClient(host, config.auth?.token);
      const agentDiscovery = await loadAgentDiscovery(
        client,
        manageHeaders(options.manage),
      );
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
