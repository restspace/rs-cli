import { Command } from "cliffy/command/mod.ts";
import { dirname, join, relative, resolve } from "std/path/mod.ts";
import { normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { requestRaw } from "../lib/raw-request.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";

const SYNC_FILE_NAME = ".rs-sync";
const SYNC_STATE_FILE_NAME = ".rs-sync-state.json";
const SERVICES_FILE_NAME = "services.json";
const RAW_CONFIG_PATH = "/.well-known/restspace/raw";
const SERVICES_RAW_CONFIG_PATH = "/.well-known/restspace/services/raw";
const ADMIN_BASE_PATH = "/.well-known/restspace";
const ROOT_SERVICE_DIRECTORY = "$ROOT";
const CLOCK_SKEW_WINDOW_MS = 60_000;
const MANAGE_HEADERS = { "X-Restspace-Request-Mode": "manage" };

type SyncMode = "add" | "delete";

type SyncActionType = "upload" | "download" | "deleteLocal" | "deleteRemote";

type SyncAction = {
  type: SyncActionType;
  relativePath: string;
  localMtimeMs?: number;
  remoteMtimeMs?: number;
  reason: string;
};

type SyncStats = {
  localFiles: number;
  remoteFiles: number;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  ignored: number;
  noChange: number;
  failed: number;
};

type LocalFileMeta = {
  mtimeMs: number;
};

type RemoteFileMeta = {
  mtimeMs: number;
  etag?: string;
};

type ServiceSyncTarget = {
  basePath: string;
  service: Record<string, unknown>;
};

type SyncStateEntry = {
  localMtimeMs: number;
  remoteMtimeMs: number;
  remoteEtag?: string;
  localHash?: string;
};

type SyncStateFile = {
  version: 1;
  siteRelativeUrl: string;
  files: Record<string, SyncStateEntry>;
};

type WorkspaceStateEntry = {
  basePath: string;
  relativePath: string;
  entry: SyncStateEntry;
};

type WorkspaceStateFile = {
  version: 2;
  config?: SyncStateEntry;
  files: WorkspaceStateEntry[];
};

type WorkspaceState = {
  config?: SyncStateEntry;
  files: Map<string, SyncStateEntry>;
};

type ConfigServiceDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

type ConfigSyncAction = {
  direction: "upload" | "download";
  services: ConfigServiceDiff;
};

type SyncPlanSummary = {
  local: {
    add: number;
    delete: number;
  };
  remote: {
    add: number;
    delete: number;
  };
  totalActions: number;
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

function parseModes(
  side: "local" | "remote",
  value?: string | string[],
): SyncMode[] {
  if (!value) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  const modes: SyncMode[] = [];
  for (const entry of values) {
    if (entry === "add" || entry === "delete") {
      if (!modes.includes(entry)) {
        modes.push(entry);
      }
      continue;
    }
    writeError({
      error: `Invalid --${side} mode '${entry}'.`,
      suggestion: `Use --${side} add or --${side} delete.`,
    });
  }
  return modes;
}

function hasMode(
  modes: SyncMode[],
  mode: SyncMode,
): boolean {
  return modes.includes(mode);
}

function normalizeSitePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    writeError({
      error: "Site relative URL cannot be empty.",
      suggestion: "Provide a URL like /content/docs.",
    });
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function toRelativeKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
}

function isSyncMarker(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1];
  return fileName === SYNC_FILE_NAME || fileName === SYNC_STATE_FILE_NAME;
}

function siteFilePath(basePath: string, relativePath: string): string {
  if (basePath === "/") {
    return `/${relativePath}`;
  }
  return `${basePath}/${relativePath}`;
}

function localAbsolutePath(rootPath: string, relativePath: string): string {
  return join(rootPath, ...relativePath.split("/"));
}

function listPath(basePath: string): string {
  return basePath === "/" ? "/" : `${basePath}/`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = normalizeJsonValue(value[key]);
  }
  return result;
}

export function normalizeServiceJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(normalizeJsonValue(value), null, 2)}\n`;
}

function extractServicesSource(config: unknown): unknown {
  if (!isRecord(config)) {
    return undefined;
  }
  return "services" in config ? config.services : config;
}

function extractServicesMap(config: unknown): Record<string, unknown> {
  const services = extractServicesSource(config);
  if (isRecord(services)) {
    return services;
  }
  if (!Array.isArray(services)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const service of services) {
    if (!isRecord(service) || typeof service.basePath !== "string") {
      continue;
    }
    result[service.basePath] = service;
  }
  return result;
}

export function validateServiceBasePath(basePath: string):
  | { ok: true; basePath: string }
  | { ok: false; reason: string } {
  const trimmed = basePath.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    return { ok: false, reason: "must start with /" };
  }
  const normalized = trimmed.replace(/\/+$/, "") || "/";
  const segments = normalized.split("/").slice(1);
  if (normalized === "/") {
    return { ok: true, basePath: normalized };
  }
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return { ok: false, reason: "path traversal is not allowed" };
  }
  if (
    normalized === ADMIN_BASE_PATH ||
    normalized.startsWith(`${ADMIN_BASE_PATH}/`)
  ) {
    return { ok: false, reason: "admin service paths are not allowed" };
  }
  return { ok: true, basePath: normalized };
}

function normalizeServiceBasePath(basePath: string): string {
  const validation = validateServiceBasePath(basePath);
  if (!validation.ok) {
    writeError({
      error: `Invalid service base path '${basePath}'.`,
      suggestion:
        "Use a non-root service path outside /.well-known/restspace without traversal.",
      details: validation.reason,
    });
  }
  return validation.basePath;
}

export function serviceBasePathToRelativePath(basePath: string): string {
  const normalized = normalizeServiceBasePath(basePath);
  return normalized === "/"
    ? ROOT_SERVICE_DIRECTORY
    : normalized.replace(/^\/+/, "");
}

function serviceBasePathToLocalPath(
  rootPath: string,
  basePath: string,
): string {
  return join(rootPath, ...serviceBasePathToRelativePath(basePath).split("/"));
}

function readServiceBasePath(
  key: string,
  service: Record<string, unknown>,
): string | undefined {
  if (key.trim()) {
    return key;
  }
  return typeof service.basePath === "string" ? service.basePath : undefined;
}

function serviceHasStoreApi(service: Record<string, unknown>): boolean {
  if (!Array.isArray(service.apis)) {
    return false;
  }
  return service.apis.some((api) =>
    typeof api === "string" && (api === "store" || api.startsWith("store-"))
  );
}

export function extractStoreCapableServices(
  config: unknown,
): ServiceSyncTarget[] {
  const services = extractServicesMap(config);
  const result: ServiceSyncTarget[] = [];
  for (const [key, value] of Object.entries(services)) {
    if (!isRecord(value)) {
      continue;
    }
    if (!serviceHasStoreApi(value)) {
      continue;
    }
    const basePath = readServiceBasePath(key, value);
    if (!basePath) {
      continue;
    }
    result.push({
      basePath: normalizeServiceBasePath(basePath),
      service: value,
    });
  }
  result.sort((left, right) => left.basePath.localeCompare(right.basePath));
  return result;
}

export function diffConfigServices(
  sourceConfig: unknown,
  targetConfig: unknown,
): ConfigServiceDiff {
  const source = extractServicesMap(sourceConfig);
  const target = extractServicesMap(targetConfig);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const basePath of Object.keys(source).sort()) {
    if (!(basePath in target)) {
      added.push(basePath);
      continue;
    }
    if (
      normalizeServiceJson(source[basePath]) !==
        normalizeServiceJson(target[basePath])
    ) {
      changed.push(basePath);
    }
  }
  for (const basePath of Object.keys(target).sort()) {
    if (!(basePath in source)) {
      removed.push(basePath);
    }
  }

  return { added, removed, changed };
}

function parseRemoteTimestamp(response: Response): number {
  const value = response.headers.get("last-modified") ??
    response.headers.get("date");
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return Date.now();
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await Deno.readTextFile(path);
  try {
    return JSON.parse(raw);
  } catch (error) {
    writeError({
      error: `Failed to parse JSON file '${path}'.`,
      suggestion: "Fix the JSON syntax and retry.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function fetchRemoteConfig(
  host: string,
  token: string | undefined,
  path = RAW_CONFIG_PATH,
): Promise<{ json: unknown; meta: RemoteFileMeta; text: string }> {
  const response = await requestRaw(host, path, "GET", {
    token,
    headers: MANAGE_HEADERS,
  });
  const text = await response.text();
  if (!response.ok) {
    writeError({
      status: response.status,
      error: "Failed to fetch tenant services config.",
      suggestion: `Check manage permissions for ${path}.`,
      details: text,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    writeError({
      error: "Remote services config was not valid JSON.",
      suggestion: "Fix the tenant raw services config before syncing.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    json,
    text,
    meta: {
      mtimeMs: parseRemoteTimestamp(response),
      etag: response.headers.get("etag") ?? undefined,
    },
  };
}

function workspaceStateKey(basePath: string, relativePath: string): string {
  return JSON.stringify({ basePath, relativePath });
}

function normalizeExcludedPrefixes(prefixes?: string[]): string[] {
  if (!prefixes?.length) {
    return [];
  }
  return [...new Set(prefixes.map(toRelativeKey).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function isExcludedByPrefix(path: string, prefixes: string[]): boolean {
  const key = toRelativeKey(path);
  return prefixes.some((prefix) =>
    key === prefix || key.startsWith(`${prefix}/`)
  );
}

function isChildServicePath(
  parentBasePath: string,
  childBasePath: string,
): boolean {
  if (parentBasePath === childBasePath) {
    return false;
  }
  if (parentBasePath === "/") {
    return childBasePath !== "/";
  }
  return childBasePath.startsWith(`${parentBasePath}/`);
}

function childServiceExclusionPrefixes(
  basePath: string,
  services: ServiceSyncTarget[],
): string[] {
  const prefixes = services
    .filter((service) => isChildServicePath(basePath, service.basePath))
    .map((service) =>
      basePath === "/"
        ? service.basePath.replace(/^\/+/, "")
        : service.basePath.slice(basePath.length).replace(/^\/+/, "")
    );
  return normalizeExcludedPrefixes(prefixes);
}

async function listRemoteFiles(
  host: string,
  token: string | undefined,
  basePath: string,
  options: { failFast?: boolean; excludePrefixes?: string[] } = {},
): Promise<Map<string, RemoteFileMeta>> {
  const excludedPrefixes = normalizeExcludedPrefixes(options.excludePrefixes);
  function remoteListError(payload: Record<string, unknown>): never {
    if (options.failFast === false) {
      throw new Error(JSON.stringify(payload));
    }
    writeError(payload);
  }

  async function fetchRemoteFileMeta(
    relativePath: string,
  ): Promise<RemoteFileMeta> {
    const filePath = siteFilePath(basePath, relativePath);
    let headResponse: Response | undefined;
    try {
      headResponse = await requestRaw(host, filePath, "HEAD", {
        token,
        headers: MANAGE_HEADERS,
        throwOnNetworkError: true,
      });
    } catch {
      headResponse = undefined;
    }
    const response = headResponse?.ok
      ? headResponse
      : await requestRaw(host, filePath, "GET", {
        token,
        headers: MANAGE_HEADERS,
      });
    if (!response.ok) {
      const text = await response.text();
      remoteListError({
        status: response.status,
        error: `Failed to read timestamp for remote file '${relativePath}'.`,
        suggestion: "Check remote file permissions.",
        details: text,
      });
    }
    const lastModified = response.headers.get("last-modified");
    if (!lastModified) {
      remoteListError({
        error: `Remote file '${relativePath}' has no Last-Modified header.`,
        suggestion:
          "Ensure the service returns Last-Modified for file resources.",
      });
    }
    const parsed = Date.parse(lastModified);
    if (!Number.isFinite(parsed)) {
      remoteListError({
        error:
          `Could not parse Last-Modified for remote file '${relativePath}'.`,
        suggestion: "Ensure Last-Modified is a valid HTTP date.",
        details: { lastModified },
      });
    }
    const etag = response.headers.get("etag") ?? undefined;
    return {
      mtimeMs: Math.trunc(parsed),
      etag,
    };
  }

  async function listDirectoryEntries(
    directoryPath: string,
  ): Promise<unknown[]> {
    const requestPath = `${listPath(directoryPath)}?$list=details`;
    const response = await requestRaw(host, requestPath, "GET", {
      token,
      headers: MANAGE_HEADERS,
    });
    if (!response.ok) {
      const text = await response.text();
      remoteListError({
        status: response.status,
        error: extractErrorMessage(text) ??
          `Failed to list remote directory at ${directoryPath}.`,
        suggestion:
          "Check path permissions and verify the remote directory exists.",
        details: text,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      remoteListError({
        error: "Remote directory listing response was not valid JSON.",
        suggestion: "Verify the endpoint supports ?$list=details.",
      });
    }
    if (Array.isArray(payload)) {
      return payload;
    }
    if (
      payload && typeof payload === "object" &&
      Array.isArray((payload as { paths?: unknown }).paths)
    ) {
      return (payload as { paths: unknown[] }).paths;
    }
    remoteListError({
      error: "Remote directory listing did not return an array of entries.",
      suggestion:
        "Expected tuples in the response or an object containing a paths array.",
      details: payload as Record<string, unknown>,
    });
  }

  const result = new Map<string, RemoteFileMeta>();
  const stack: Array<{ directoryPath: string; prefix: string }> = [{
    directoryPath: basePath,
    prefix: "",
  }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await listDirectoryEntries(current.directoryPath);
    for (const entry of entries) {
      let entryName: string;
      let entryTimestamp: number | undefined;
      if (typeof entry === "string") {
        entryName = entry;
      } else if (Array.isArray(entry) && typeof entry[0] === "string") {
        entryName = entry[0];
        if (typeof entry[1] === "number" && Number.isFinite(entry[1])) {
          entryTimestamp = Math.trunc(entry[1]);
        }
      } else {
        remoteListError({
          error: "Invalid directory entry returned by server.",
          suggestion:
            "Expected entries as names or [name, dateModified] tuples.",
          details: { entry },
        });
      }

      const rawName = entryName.replace(/^\/+/, "");
      if (!rawName) {
        continue;
      }
      if (rawName.endsWith("/")) {
        const childName = rawName.replace(/\/+$/, "");
        if (!childName) {
          continue;
        }
        const childPrefix = current.prefix
          ? `${current.prefix}/${childName}`
          : childName;
        if (isExcludedByPrefix(childPrefix, excludedPrefixes)) {
          continue;
        }
        const childDirectoryPath = siteFilePath(basePath, childPrefix);
        stack.push({ directoryPath: childDirectoryPath, prefix: childPrefix });
        continue;
      }

      const relativeName = current.prefix
        ? `${current.prefix}/${rawName}`
        : rawName;
      const key = toRelativeKey(relativeName);
      if (
        !key || isSyncMarker(key) || isExcludedByPrefix(key, excludedPrefixes)
      ) {
        continue;
      }
      let metadata: RemoteFileMeta;
      if (typeof entryTimestamp === "number") {
        metadata = { mtimeMs: entryTimestamp };
      } else {
        metadata = await fetchRemoteFileMeta(key);
      }
      result.set(key, metadata);
    }
  }
  return result;
}

async function listLocalFiles(
  rootPath: string,
  options: { excludePrefixes?: string[] } = {},
): Promise<Map<string, LocalFileMeta>> {
  const excludedPrefixes = normalizeExcludedPrefixes(options.excludePrefixes);
  const result = new Map<string, LocalFileMeta>();
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for await (const entry of Deno.readDir(current)) {
      const absolutePath = join(current, entry.name);
      const relativePath = toRelativeKey(relative(rootPath, absolutePath));
      if (relativePath && isExcludedByPrefix(relativePath, excludedPrefixes)) {
        continue;
      }
      if (entry.isDirectory) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      if (!relativePath || isSyncMarker(relativePath)) {
        continue;
      }
      const info = await Deno.stat(absolutePath);
      const mtimeMs = info.mtime?.getTime();
      if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
        writeError({
          error:
            `Local file '${relativePath}' has no valid modified timestamp.`,
          suggestion:
            "Ensure local files are on a filesystem with mtime support.",
        });
      }
      result.set(relativePath, { mtimeMs: Math.trunc(mtimeMs) });
    }
  }
  return result;
}

function fmtMs(ms: number): string {
  return new Date(ms).toISOString();
}

function hasMeaningfulTimeDelta(
  leftMs: number,
  rightMs: number,
): boolean {
  return Math.abs(leftMs - rightMs) > CLOCK_SKEW_WINDOW_MS;
}

function hasRemoteChanged(
  remote: RemoteFileMeta,
  state?: SyncStateEntry,
): boolean {
  if (!state) {
    return true;
  }
  if (hasMeaningfulTimeDelta(remote.mtimeMs, state.remoteMtimeMs)) {
    return true;
  }
  if (state.remoteEtag && remote.etag && state.remoteEtag !== remote.etag) {
    return true;
  }
  return false;
}

function hasLocalChanged(
  local: LocalFileMeta,
  state?: SyncStateEntry,
): boolean {
  if (!state) {
    return true;
  }
  return hasMeaningfulTimeDelta(local.mtimeMs, state.localMtimeMs);
}

async function hashLocalFile(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const bytes = await Deno.readFile(localAbsolutePath(rootPath, relativePath));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hashBytes = new Uint8Array(digest);
  return Array.from(hashBytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function planActions(
  localFiles: Map<string, LocalFileMeta>,
  remoteFiles: Map<string, RemoteFileMeta>,
  stateFiles: Map<string, SyncStateEntry>,
  localRoot: string,
  localModes: SyncMode[] = [],
  remoteModes: SyncMode[] = [],
): Promise<{ actions: SyncAction[]; stats: SyncStats }> {
  if (hasMode(localModes, "add") && hasMode(remoteModes, "delete")) {
    writeError({
      error: "Conflicting modes: --local add and --remote delete.",
      suggestion:
        "Pick one behavior for remote-only files (add locally OR delete remotely).",
    });
  }
  if (hasMode(localModes, "delete") && hasMode(remoteModes, "add")) {
    writeError({
      error: "Conflicting modes: --local delete and --remote add.",
      suggestion:
        "Pick one behavior for local-only files (delete locally OR add remotely).",
    });
  }

  const actions: SyncAction[] = [];
  const allPaths = new Set<string>([
    ...localFiles.keys(),
    ...remoteFiles.keys(),
  ]);

  const stats: SyncStats = {
    localFiles: localFiles.size,
    remoteFiles: remoteFiles.size,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    ignored: 0,
    noChange: 0,
    failed: 0,
  };

  for (const path of allPaths) {
    const localMeta = localFiles.get(path);
    const remoteMeta = remoteFiles.get(path);
    const state = stateFiles.get(path);

    if (localMeta && remoteMeta) {
      let localChanged = hasLocalChanged(localMeta, state);
      const remoteChanged = hasRemoteChanged(remoteMeta, state);
      if (localChanged && !remoteChanged && state?.localHash) {
        const currentHash = await hashLocalFile(localRoot, path);
        if (currentHash === state.localHash) {
          localChanged = false;
        }
      }
      if (!localChanged && !remoteChanged) {
        stats.noChange++;
        continue;
      }
      if (localChanged && !remoteChanged) {
        if (localMeta.mtimeMs > remoteMeta.mtimeMs) {
          const prev = state ? fmtMs(state.localMtimeMs) : "unknown";
          actions.push({
            type: "upload",
            relativePath: path,
            localMtimeMs: localMeta.mtimeMs,
            reason: `local modified: ${prev} → ${fmtMs(localMeta.mtimeMs)}`,
          });
        } else {
          stats.noChange++;
        }
        continue;
      }
      if (!localChanged && remoteChanged) {
        const prev = state ? fmtMs(state.remoteMtimeMs) : "unknown";
        actions.push({
          type: "download",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `remote modified: ${prev} → ${fmtMs(remoteMeta.mtimeMs)}`,
        });
        continue;
      }
      const delta = localMeta.mtimeMs - remoteMeta.mtimeMs;
      if (Math.abs(delta) <= CLOCK_SKEW_WINDOW_MS) {
        stats.noChange++;
      } else if (delta > 0) {
        actions.push({
          type: "upload",
          relativePath: path,
          localMtimeMs: localMeta.mtimeMs,
          reason: `conflict: local newer (local: ${
            fmtMs(localMeta.mtimeMs)
          }, remote: ${fmtMs(remoteMeta.mtimeMs)})`,
        });
      } else {
        actions.push({
          type: "download",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `conflict: remote newer (remote: ${
            fmtMs(remoteMeta.mtimeMs)
          }, local: ${fmtMs(localMeta.mtimeMs)})`,
        });
      }
      continue;
    }

    if (localMeta) {
      if (hasMode(remoteModes, "add")) {
        actions.push({
          type: "upload",
          relativePath: path,
          localMtimeMs: localMeta.mtimeMs,
          reason: `new local file (${fmtMs(localMeta.mtimeMs)})`,
        });
      } else if (hasMode(localModes, "delete")) {
        actions.push({
          type: "deleteLocal",
          relativePath: path,
          localMtimeMs: localMeta.mtimeMs,
          reason: `local-only file`,
        });
      } else {
        stats.ignored++;
      }
      continue;
    }

    if (remoteMeta) {
      if (hasMode(localModes, "add")) {
        actions.push({
          type: "download",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `new remote file (${fmtMs(remoteMeta.mtimeMs)})`,
        });
      } else if (hasMode(remoteModes, "delete")) {
        actions.push({
          type: "deleteRemote",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `remote-only file`,
        });
      } else {
        stats.ignored++;
      }
    }
  }

  return { actions, stats };
}

function summarizePlan(actions: SyncAction[]): SyncPlanSummary {
  const summary: SyncPlanSummary = {
    local: {
      add: 0,
      delete: 0,
    },
    remote: {
      add: 0,
      delete: 0,
    },
    totalActions: actions.length,
  };
  for (const action of actions) {
    if (action.type === "download") {
      summary.local.add++;
      continue;
    }
    if (action.type === "deleteLocal") {
      summary.local.delete++;
      continue;
    }
    if (action.type === "upload") {
      summary.remote.add++;
      continue;
    }
    summary.remote.delete++;
  }
  return summary;
}

async function executeAction(
  action: SyncAction,
  host: string,
  token: string | undefined,
  localRoot: string,
  remoteBase: string,
  stats: SyncStats,
): Promise<void> {
  const remotePath = siteFilePath(remoteBase, action.relativePath);
  const localPath = join(localRoot, ...action.relativePath.split("/"));

  if (action.type === "upload") {
    const bytes = await Deno.readFile(localPath);
    const response = await requestRaw(host, remotePath, "PUT", {
      token,
      body: bytes,
      headers: MANAGE_HEADERS,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Upload failed for '${action.relativePath}' (${response.status}): ${text}`,
      );
    }
    stats.uploaded++;
    return;
  }

  if (action.type === "download") {
    const response = await requestRaw(host, remotePath, "GET", {
      token,
      headers: MANAGE_HEADERS,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Download failed for '${action.relativePath}' (${response.status}): ${text}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await Deno.mkdir(dirname(localPath), { recursive: true });
    await Deno.writeFile(localPath, bytes);
    if (typeof action.remoteMtimeMs === "number") {
      const when = new Date(action.remoteMtimeMs);
      await Deno.utime(localPath, when, when);
    }
    stats.downloaded++;
    return;
  }

  if (action.type === "deleteLocal") {
    await Deno.remove(localPath);
    stats.deletedLocal++;
    return;
  }

  if (action.type === "deleteRemote") {
    const response = await requestRaw(host, remotePath, "DELETE", {
      token,
      headers: MANAGE_HEADERS,
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(
        `Remote delete failed for '${action.relativePath}' (${response.status}): ${text}`,
      );
    }
    stats.deletedRemote++;
  }
}

async function readSyncFile(rootPath: string): Promise<string | undefined> {
  const syncPath = join(rootPath, SYNC_FILE_NAME);
  try {
    const value = await Deno.readTextFile(syncPath);
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

async function writeSyncFile(
  rootPath: string,
  sitePath: string,
): Promise<void> {
  const syncPath = join(rootPath, SYNC_FILE_NAME);
  await Deno.writeTextFile(syncPath, `${sitePath}\n`);
}

async function readSyncState(
  rootPath: string,
  sitePath: string,
): Promise<Map<string, SyncStateEntry>> {
  const statePath = join(rootPath, SYNC_STATE_FILE_NAME);
  try {
    const raw = await Deno.readTextFile(statePath);
    if (!raw.trim()) {
      return new Map<string, SyncStateEntry>();
    }
    const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
    if (
      parsed.version !== 1 || parsed.siteRelativeUrl !== sitePath ||
      !parsed.files
    ) {
      return new Map<string, SyncStateEntry>();
    }
    const entries = new Map<string, SyncStateEntry>();
    for (const [path, value] of Object.entries(parsed.files)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const record = value as Partial<SyncStateEntry>;
      if (
        typeof record.localMtimeMs !== "number" ||
        typeof record.remoteMtimeMs !== "number"
      ) {
        continue;
      }
      entries.set(path, {
        localMtimeMs: Math.trunc(record.localMtimeMs),
        remoteMtimeMs: Math.trunc(record.remoteMtimeMs),
        remoteEtag: typeof record.remoteEtag === "string"
          ? record.remoteEtag
          : undefined,
        localHash: typeof record.localHash === "string"
          ? record.localHash
          : undefined,
      });
    }
    return entries;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Map<string, SyncStateEntry>();
    }
    return new Map<string, SyncStateEntry>();
  }
}

async function writeSyncState(
  rootPath: string,
  sitePath: string,
  localFiles: Map<string, LocalFileMeta>,
  remoteFiles: Map<string, RemoteFileMeta>,
): Promise<void> {
  const files: Record<string, SyncStateEntry> = {};
  for (const [path, localMeta] of localFiles.entries()) {
    const remoteMeta = remoteFiles.get(path);
    if (!remoteMeta) {
      continue;
    }
    const localHash = await hashLocalFile(rootPath, path);
    files[path] = {
      localMtimeMs: localMeta.mtimeMs,
      remoteMtimeMs: remoteMeta.mtimeMs,
      remoteEtag: remoteMeta.etag,
      localHash,
    };
  }
  const payload: SyncStateFile = {
    version: 1,
    siteRelativeUrl: sitePath,
    files,
  };
  const statePath = join(rootPath, SYNC_STATE_FILE_NAME);
  await Deno.writeTextFile(statePath, JSON.stringify(payload, null, 2));
}

async function readWorkspaceState(rootPath: string): Promise<WorkspaceState> {
  const statePath = join(rootPath, SYNC_STATE_FILE_NAME);
  const empty = {
    files: new Map<string, SyncStateEntry>(),
  };
  try {
    const raw = await Deno.readTextFile(statePath);
    if (!raw.trim()) {
      return empty;
    }
    const parsed = JSON.parse(raw) as Partial<WorkspaceStateFile>;
    if (parsed.version !== 2 || !Array.isArray(parsed.files)) {
      return empty;
    }
    const files = new Map<string, SyncStateEntry>();
    for (const value of parsed.files) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const record = value as Partial<WorkspaceStateEntry>;
      const entry = record.entry as Partial<SyncStateEntry> | undefined;
      if (
        typeof record.basePath !== "string" ||
        typeof record.relativePath !== "string" ||
        !entry ||
        typeof entry.localMtimeMs !== "number" ||
        typeof entry.remoteMtimeMs !== "number"
      ) {
        continue;
      }
      files.set(workspaceStateKey(record.basePath, record.relativePath), {
        localMtimeMs: Math.trunc(entry.localMtimeMs),
        remoteMtimeMs: Math.trunc(entry.remoteMtimeMs),
        remoteEtag: typeof entry.remoteEtag === "string"
          ? entry.remoteEtag
          : undefined,
        localHash: typeof entry.localHash === "string"
          ? entry.localHash
          : undefined,
      });
    }
    const config = parsed.config &&
        typeof parsed.config.localMtimeMs === "number" &&
        typeof parsed.config.remoteMtimeMs === "number"
      ? {
        localMtimeMs: Math.trunc(parsed.config.localMtimeMs),
        remoteMtimeMs: Math.trunc(parsed.config.remoteMtimeMs),
        remoteEtag: typeof parsed.config.remoteEtag === "string"
          ? parsed.config.remoteEtag
          : undefined,
        localHash: typeof parsed.config.localHash === "string"
          ? parsed.config.localHash
          : undefined,
      }
      : undefined;
    return { config, files };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return empty;
    }
    return empty;
  }
}

function serviceStateFiles(
  state: WorkspaceState,
  basePath: string,
): Map<string, SyncStateEntry> {
  const result = new Map<string, SyncStateEntry>();
  for (const [key, entry] of state.files.entries()) {
    const parsed = JSON.parse(key) as {
      basePath?: unknown;
      relativePath?: unknown;
    };
    if (
      parsed.basePath === basePath &&
      typeof parsed.relativePath === "string"
    ) {
      result.set(parsed.relativePath, entry);
    }
  }
  return result;
}

async function writeWorkspaceState(
  rootPath: string,
  configState: SyncStateEntry | undefined,
  services: Array<{
    basePath: string;
    localRoot: string;
    localFiles: Map<string, LocalFileMeta>;
    remoteFiles: Map<string, RemoteFileMeta>;
  }>,
): Promise<void> {
  const files: WorkspaceStateEntry[] = [];
  for (const service of services) {
    for (const [relativePath, localMeta] of service.localFiles.entries()) {
      const remoteMeta = service.remoteFiles.get(relativePath);
      if (!remoteMeta) {
        continue;
      }
      files.push({
        basePath: service.basePath,
        relativePath,
        entry: {
          localMtimeMs: localMeta.mtimeMs,
          remoteMtimeMs: remoteMeta.mtimeMs,
          remoteEtag: remoteMeta.etag,
          localHash: await hashLocalFile(service.localRoot, relativePath),
        },
      });
    }
  }
  files.sort((left, right) =>
    left.basePath.localeCompare(right.basePath) ||
    left.relativePath.localeCompare(right.relativePath)
  );
  const payload: WorkspaceStateFile = {
    version: 2,
    config: configState,
    files,
  };
  const statePath = join(rootPath, SYNC_STATE_FILE_NAME);
  await Deno.writeTextFile(statePath, JSON.stringify(payload, null, 2));
}

async function buildConfigState(
  rootPath: string,
  remoteMeta: RemoteFileMeta,
): Promise<SyncStateEntry> {
  const configPath = join(rootPath, SERVICES_FILE_NAME);
  const localInfo = await Deno.stat(configPath);
  return {
    localMtimeMs: Math.trunc(localInfo.mtime?.getTime() ?? Date.now()),
    remoteMtimeMs: remoteMeta.mtimeMs,
    remoteEtag: remoteMeta.etag,
    localHash: await hashLocalFile(rootPath, SERVICES_FILE_NAME),
  };
}

export const SYNC_DESCRIPTION = `Sync local files with Restspace store services.

Single-directory mode syncs <path> with [siteRelativeUrl]. If siteRelativeUrl is
omitted, rs uses the path's .rs-sync file when present.

Multi-directory mode treats <path> as a workspace when it contains services.json.
Each service base path with a store API maps to a matching local directory
("/" maps to "$ROOT"), and nested service directories are treated as separate
sync boundaries. Use --init to create a workspace from the tenant services
configuration before syncing.

Sync previews changes and asks for confirmation unless --yes is provided.`;

async function ensureInitRoot(
  localRoot: string,
  inputPath: string,
): Promise<void> {
  try {
    const stat = await Deno.stat(localRoot);
    if (!stat.isDirectory) {
      writeError({
        error: `Local path '${inputPath}' is not a directory.`,
        suggestion: "Provide a directory path to initialize.",
      });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.mkdir(localRoot, { recursive: true });
      return;
    }
    throw error;
  }
}

async function servicesFileExists(localRoot: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(localRoot, SERVICES_FILE_NAME));
    return stat.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function servicesPathExists(localRoot: string): Promise<boolean> {
  try {
    await Deno.stat(join(localRoot, SERVICES_FILE_NAME));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function runSyncInit(
  path: string,
  siteRelativeUrl: string | undefined,
): Promise<void> {
  if (siteRelativeUrl?.trim()) {
    writeError({
      error: "--init does not accept a siteRelativeUrl.",
      suggestion: "Run `rs sync <path> --init` for workspace initialization.",
    });
  }

  const localRoot = resolve(path);
  await ensureInitRoot(localRoot, path);
  const servicesPath = join(localRoot, SERVICES_FILE_NAME);
  if (await servicesPathExists(localRoot)) {
    writeError({
      error: `${SERVICES_FILE_NAME} already exists.`,
      suggestion: "Use the existing workspace or choose an empty path.",
    });
  }

  const config = await loadAuthReadyConfig();
  const host = resolveHost(config.host);
  const token = config.auth?.token;
  const remoteConfig = await fetchRemoteConfig(host, token);
  const serviceMetadata = await fetchRemoteConfig(
    host,
    token,
    SERVICES_RAW_CONFIG_PATH,
  );
  await Deno.writeTextFile(servicesPath, prettyJson(remoteConfig.json));

  const directories: string[] = [];
  for (const service of extractStoreCapableServices(serviceMetadata.json)) {
    const relativePath = serviceBasePathToRelativePath(service.basePath);
    await Deno.mkdir(serviceBasePathToLocalPath(localRoot, service.basePath), {
      recursive: true,
    });
    directories.push(relativePath);
  }

  writeSuccess({
    initialized: true,
    path: localRoot,
    servicesJson: servicesPath,
    directories,
  });
}

async function planConfigSync(
  rootPath: string,
  host: string,
  token: string | undefined,
  state: SyncStateEntry | undefined,
): Promise<{
  localJson: unknown;
  remoteJson: unknown;
  remoteMeta: RemoteFileMeta;
  action?: ConfigSyncAction;
}> {
  const localJson = await readJsonFile(join(rootPath, SERVICES_FILE_NAME));
  const remoteConfig = await fetchRemoteConfig(host, token);
  const localNormalized = normalizeServiceJson(localJson);
  const remoteNormalized = normalizeServiceJson(remoteConfig.json);
  if (localNormalized === remoteNormalized) {
    return {
      localJson,
      remoteJson: remoteConfig.json,
      remoteMeta: remoteConfig.meta,
    };
  }

  const localInfo = await Deno.stat(join(rootPath, SERVICES_FILE_NAME));
  const localMeta = {
    mtimeMs: Math.trunc(localInfo.mtime?.getTime() ?? Date.now()),
  };
  let localChanged = hasLocalChanged(localMeta, state);
  if (localChanged && state?.localHash) {
    const currentHash = await hashLocalFile(rootPath, SERVICES_FILE_NAME);
    if (currentHash === state.localHash) {
      localChanged = false;
    }
  }
  const remoteChanged = hasRemoteChanged(remoteConfig.meta, state);

  let direction: "upload" | "download";
  if (localChanged && !remoteChanged) {
    direction = "upload";
  } else if (!localChanged && remoteChanged) {
    direction = "download";
  } else {
    direction = localMeta.mtimeMs >= remoteConfig.meta.mtimeMs
      ? "upload"
      : "download";
  }

  const services = direction === "upload"
    ? diffConfigServices(localJson, remoteConfig.json)
    : diffConfigServices(remoteConfig.json, localJson);

  return {
    localJson,
    remoteJson: remoteConfig.json,
    remoteMeta: remoteConfig.meta,
    action: { direction, services },
  };
}

async function applyConfigSync(
  rootPath: string,
  host: string,
  token: string | undefined,
  plan: Awaited<ReturnType<typeof planConfigSync>>,
): Promise<RemoteFileMeta> {
  if (!plan.action) {
    return plan.remoteMeta;
  }

  if (plan.action.direction === "download") {
    await Deno.writeTextFile(
      join(rootPath, SERVICES_FILE_NAME),
      prettyJson(plan.remoteJson),
    );
    const when = new Date(plan.remoteMeta.mtimeMs);
    await Deno.utime(join(rootPath, SERVICES_FILE_NAME), when, when);
    return plan.remoteMeta;
  }

  const body = prettyJson(plan.localJson);
  const response = await requestRaw(host, RAW_CONFIG_PATH, "PUT", {
    token,
    body,
    headers: {
      ...MANAGE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    writeError({
      status: response.status,
      error: "Failed to upload tenant services config.",
      suggestion: "Check manage permissions for /.well-known/restspace/raw.",
      details: text,
    });
  }
  await Deno.writeTextFile(join(rootPath, SERVICES_FILE_NAME), body);
  return (await fetchRemoteConfig(host, token)).meta;
}

function emptyStats(): SyncStats {
  return {
    localFiles: 0,
    remoteFiles: 0,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    ignored: 0,
    noChange: 0,
    failed: 0,
  };
}

function addStats(target: SyncStats, source: SyncStats): void {
  target.localFiles += source.localFiles;
  target.remoteFiles += source.remoteFiles;
  target.uploaded += source.uploaded;
  target.downloaded += source.downloaded;
  target.deletedLocal += source.deletedLocal;
  target.deletedRemote += source.deletedRemote;
  target.ignored += source.ignored;
  target.noChange += source.noChange;
  target.failed += source.failed;
}

async function runMultiServiceSync(
  options: {
    local?: string | string[];
    remote?: string | string[];
    yes?: boolean;
    verbose?: boolean;
  },
  localRoot: string,
): Promise<void> {
  const localModes = parseModes("local", options.local);
  const remoteModes = parseModes("remote", options.remote);

  const config = await loadAuthReadyConfig();
  const host = resolveHost(config.host);
  const token = config.auth?.token;
  const workspaceState = await readWorkspaceState(localRoot);

  const configPlan = await planConfigSync(
    localRoot,
    host,
    token,
    workspaceState.config,
  );
  if (configPlan.action) {
    writeSuccess({
      preview: true,
      path: localRoot,
      config: configPlan.action,
    });
    if (!options.yes) {
      let approved = false;
      try {
        approved = confirm("Proceed with services.json sync changes? [y/N]");
      } catch {
        writeError({
          error: "Unable to read interactive confirmation.",
          suggestion: "Run with -y or --yes to bypass confirmation.",
        });
      }
      if (!approved) {
        writeSuccess({
          path: localRoot,
          config: configPlan.action,
          aborted: true,
        });
        return;
      }
    }
  }

  const remoteConfigMeta = await applyConfigSync(
    localRoot,
    host,
    token,
    configPlan,
  );
  const configState = await buildConfigState(localRoot, remoteConfigMeta);
  const serviceMetadata = await fetchRemoteConfig(
    host,
    token,
    SERVICES_RAW_CONFIG_PATH,
  );
  const services = extractStoreCapableServices(serviceMetadata.json);

  const servicePlans: Array<{
    basePath: string;
    localRoot: string;
    localFiles: Map<string, LocalFileMeta>;
    remoteFiles: Map<string, RemoteFileMeta>;
    actions: SyncAction[];
    stats: SyncStats;
  }> = [];
  const skipped: Array<{ basePath: string; reason: string }> = [];
  const failures: Array<
    { basePath: string; action?: SyncActionType; path?: string; error: string }
  > = [];
  const stats = emptyStats();

  for (const service of services) {
    const serviceRoot = serviceBasePathToLocalPath(localRoot, service.basePath);
    let localStat: Deno.FileInfo;
    try {
      localStat = await Deno.stat(serviceRoot);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        skipped.push({
          basePath: service.basePath,
          reason: "local directory missing",
        });
        continue;
      }
      throw error;
    }
    if (!localStat.isDirectory) {
      failures.push({
        basePath: service.basePath,
        error: "local service path is not a directory",
      });
      stats.failed++;
      continue;
    }

    try {
      const excludePrefixes = childServiceExclusionPrefixes(
        service.basePath,
        services,
      );
      const [localFiles, remoteFiles] = await Promise.all([
        listLocalFiles(serviceRoot, { excludePrefixes }),
        listRemoteFiles(host, token, service.basePath, {
          failFast: false,
          excludePrefixes,
        }),
      ]);
      const { actions, stats: serviceStats } = await planActions(
        localFiles,
        remoteFiles,
        serviceStateFiles(workspaceState, service.basePath),
        serviceRoot,
        localModes,
        remoteModes,
      );
      addStats(stats, serviceStats);
      servicePlans.push({
        basePath: service.basePath,
        localRoot: serviceRoot,
        localFiles,
        remoteFiles,
        actions,
        stats: serviceStats,
      });
    } catch (error) {
      stats.failed++;
      failures.push({
        basePath: service.basePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const allActions = servicePlans.flatMap((service) =>
    service.actions.map((action) => ({ basePath: service.basePath, action }))
  );
  const planned = summarizePlan(allActions.map((value) => value.action));

  writeSuccess({
    preview: true,
    path: localRoot,
    workspace: true,
    modes: {
      local: localModes.length > 0 ? localModes : null,
      remote: remoteModes.length > 0 ? remoteModes : null,
    },
    planned,
    skipped,
    failedServices: failures,
    analysis: {
      localFiles: stats.localFiles,
      remoteFiles: stats.remoteFiles,
      noChange: stats.noChange,
      ignored: stats.ignored,
    },
    ...(options.verbose && allActions.length > 0
      ? {
        actions: allActions.map(({ basePath, action }) => ({
          service: basePath,
          type: action.type,
          path: action.relativePath,
          reason: action.reason,
        })),
      }
      : {}),
  });

  if (allActions.length > 0 && !options.yes) {
    let approved = false;
    try {
      approved = confirm("Proceed with sync changes? [y/N]");
    } catch {
      writeError({
        error: "Unable to read interactive confirmation.",
        suggestion: "Run with -y or --yes to bypass confirmation.",
      });
    }
    if (!approved) {
      writeSuccess({
        path: localRoot,
        workspace: true,
        planned,
        skipped,
        aborted: true,
      });
      return;
    }
  }

  for (const service of servicePlans) {
    for (const action of service.actions) {
      try {
        await executeAction(
          action,
          host,
          token,
          service.localRoot,
          service.basePath,
          stats,
        );
      } catch (error) {
        stats.failed++;
        failures.push({
          basePath: service.basePath,
          action: action.type,
          path: action.relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (stats.failed > 0) {
    writeError({
      error: "Workspace sync completed with errors.",
      stats,
      skipped,
      failures,
    });
  }

  const refreshedServices = [];
  for (const service of servicePlans) {
    const excludePrefixes = childServiceExclusionPrefixes(
      service.basePath,
      services,
    );
    const [localFiles, remoteFiles] = await Promise.all([
      listLocalFiles(service.localRoot, { excludePrefixes }),
      listRemoteFiles(host, token, service.basePath, {
        failFast: false,
        excludePrefixes,
      }),
    ]);
    refreshedServices.push({
      basePath: service.basePath,
      localRoot: service.localRoot,
      localFiles,
      remoteFiles,
    });
  }
  await writeWorkspaceState(localRoot, configState, refreshedServices);

  writeSuccess({
    path: localRoot,
    workspace: true,
    modes: {
      local: localModes.length > 0 ? localModes : null,
      remote: remoteModes.length > 0 ? remoteModes : null,
    },
    skipped,
    stats,
  });
}

export async function runSync(
  options: {
    local?: string | string[];
    remote?: string | string[];
    yes?: boolean;
    verbose?: boolean;
    init?: boolean;
  },
  path: string,
  siteRelativeUrl?: string,
): Promise<void> {
  const localRoot = resolve(path);
  if (options.init) {
    await runSyncInit(path, siteRelativeUrl);
    return;
  }

  let localStat: Deno.FileInfo;
  try {
    localStat = await Deno.stat(localRoot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      writeError({
        error: `Local path '${path}' does not exist.`,
        suggestion: "Create the directory before syncing.",
      });
    }
    throw error;
  }
  if (!localStat.isDirectory) {
    writeError({
      error: `Local path '${path}' is not a directory.`,
      suggestion: "Provide a directory path to sync.",
    });
  }

  if (!siteRelativeUrl?.trim() && await servicesFileExists(localRoot)) {
    await runMultiServiceSync(options, localRoot);
    return;
  }

  const localModes = parseModes("local", options.local);
  const remoteModes = parseModes("remote", options.remote);

  const storedSitePath = await readSyncFile(localRoot);
  const resolvedSitePath = normalizeSitePath(
    siteRelativeUrl?.trim() || storedSitePath || "",
  );

  const config = await loadAuthReadyConfig();
  const host = resolveHost(config.host);
  const token = config.auth?.token;

  const [localFiles, remoteFiles] = await Promise.all([
    listLocalFiles(localRoot),
    listRemoteFiles(host, token, resolvedSitePath),
  ]);
  const stateFiles = await readSyncState(localRoot, resolvedSitePath);

  const { actions, stats } = await planActions(
    localFiles,
    remoteFiles,
    stateFiles,
    localRoot,
    localModes,
    remoteModes,
  );
  const planned = summarizePlan(actions);

  writeSuccess({
    preview: true,
    path: localRoot,
    siteRelativeUrl: resolvedSitePath,
    modes: {
      local: localModes.length > 0 ? localModes : null,
      remote: remoteModes.length > 0 ? remoteModes : null,
    },
    planned,
    analysis: {
      localFiles: stats.localFiles,
      remoteFiles: stats.remoteFiles,
      noChange: stats.noChange,
      ignored: stats.ignored,
    },
    ...(options.verbose && actions.length > 0
      ? {
        actions: actions.map((a) => ({
          type: a.type,
          path: a.relativePath,
          reason: a.reason,
        })),
      }
      : {}),
  });

  if (actions.length > 0 && !options.yes) {
    let approved = false;
    try {
      approved = confirm("Proceed with sync changes? [y/N]");
    } catch {
      writeError({
        error: "Unable to read interactive confirmation.",
        suggestion: "Run with -y or --yes to bypass confirmation.",
      });
    }
    if (!approved) {
      writeSuccess({
        path: localRoot,
        siteRelativeUrl: resolvedSitePath,
        planned,
        aborted: true,
      });
      return;
    }
  }

  await writeSyncFile(localRoot, resolvedSitePath);

  if (actions.length === 0) {
    await writeSyncState(localRoot, resolvedSitePath, localFiles, remoteFiles);
  }

  const failures: Array<
    { action: SyncActionType; path: string; error: string }
  > = [];
  for (const action of actions) {
    try {
      await executeAction(
        action,
        host,
        token,
        localRoot,
        resolvedSitePath,
        stats,
      );
    } catch (error) {
      stats.failed++;
      failures.push({
        action: action.type,
        path: action.relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (stats.failed > 0) {
    writeError({
      error: "Sync completed with errors.",
      siteRelativeUrl: resolvedSitePath,
      stats,
      failures,
    });
  }

  if (actions.length > 0) {
    const [nextLocalFiles, nextRemoteFiles] = await Promise.all([
      listLocalFiles(localRoot),
      listRemoteFiles(host, token, resolvedSitePath),
    ]);
    await writeSyncState(
      localRoot,
      resolvedSitePath,
      nextLocalFiles,
      nextRemoteFiles,
    );
  }

  writeSuccess({
    path: localRoot,
    siteRelativeUrl: resolvedSitePath,
    modes: {
      local: localModes.length > 0 ? localModes : null,
      remote: remoteModes.length > 0 ? remoteModes : null,
    },
    stats,
  });
}

export function syncCommand() {
  return new Command()
    .description(SYNC_DESCRIPTION)
    .arguments("<path:string> [siteRelativeUrl:string]")
    .example(
      "Initialize a multi-directory workspace",
      "rs sync ./workspace --init",
    )
    .example(
      "Sync all store service directories in a workspace",
      "rs sync ./workspace",
    )
    .example(
      "Sync one directory with one remote path",
      "rs sync ./public /app",
    )
    .option(
      "--local <mode:string>",
      "Local mismatch behavior: add|delete (repeatable)",
      { collect: true },
    )
    .option(
      "--remote <mode:string>",
      "Remote mismatch behavior: add|delete (repeatable)",
      { collect: true },
    )
    .option("-y, --yes", "Bypass confirmation prompt")
    .option("--init", "Initialize a multi-directory sync workspace")
    .option(
      "-v, --verbose",
      "Show per-file reasons for scheduled uploads/downloads",
    )
    .action(async (options, path, siteRelativeUrl) => {
      await runSync(
        options as {
          local?: string | string[];
          remote?: string | string[];
          yes?: boolean;
          verbose?: boolean;
          init?: boolean;
        },
        path,
        siteRelativeUrl,
      );
    });
}
