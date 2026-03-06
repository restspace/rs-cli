import { Command } from "cliffy/command/mod.ts";
import { dirname, join, relative, resolve } from "std/path/mod.ts";
import { loadConfig, normalizeHost } from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { requestRaw } from "../lib/raw-request.ts";

const SYNC_FILE_NAME = ".rs-sync";
const SYNC_STATE_FILE_NAME = ".rs-sync-state.json";
const CLOCK_SKEW_WINDOW_MS = 60_000;

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

function parseMode(
  side: "local" | "remote",
  value?: string,
): SyncMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "add" || value === "delete") {
    return value;
  }
  writeError({
    error: `Invalid --${side} mode '${value}'.`,
    suggestion: `Use --${side} add or --${side} delete.`,
  });
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

async function listRemoteFiles(
  host: string,
  token: string | undefined,
  basePath: string,
): Promise<Map<string, RemoteFileMeta>> {
  async function fetchRemoteFileMeta(relativePath: string): Promise<RemoteFileMeta> {
    const filePath = siteFilePath(basePath, relativePath);
    const headResponse = await requestRaw(host, filePath, "HEAD", { token });
    const response = headResponse.ok
      ? headResponse
      : await requestRaw(host, filePath, "GET", { token });
    if (!response.ok) {
      const text = await response.text();
      writeError({
        status: response.status,
        error: `Failed to read timestamp for remote file '${relativePath}'.`,
        suggestion: "Check remote file permissions.",
        details: text,
      });
    }
    const lastModified = response.headers.get("last-modified");
    if (!lastModified) {
      writeError({
        error: `Remote file '${relativePath}' has no Last-Modified header.`,
        suggestion: "Ensure the service returns Last-Modified for file resources.",
      });
    }
    const parsed = Date.parse(lastModified);
    if (!Number.isFinite(parsed)) {
      writeError({
        error: `Could not parse Last-Modified for remote file '${relativePath}'.`,
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

  async function listDirectoryEntries(directoryPath: string): Promise<unknown[]> {
    const requestPath = `${listPath(directoryPath)}?$list=details`;
    const response = await requestRaw(host, requestPath, "GET", { token });
    if (!response.ok) {
      const text = await response.text();
      writeError({
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
      writeError({
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
    writeError({
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
        writeError({
          error: "Invalid directory entry returned by server.",
          suggestion: "Expected entries as names or [name, dateModified] tuples.",
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
        const childDirectoryPath = siteFilePath(basePath, childPrefix);
        stack.push({ directoryPath: childDirectoryPath, prefix: childPrefix });
        continue;
      }

      const relativeName = current.prefix
        ? `${current.prefix}/${rawName}`
        : rawName;
      const key = toRelativeKey(relativeName);
      if (!key || isSyncMarker(key)) {
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

async function listLocalFiles(rootPath: string): Promise<Map<string, LocalFileMeta>> {
  const result = new Map<string, LocalFileMeta>();
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for await (const entry of Deno.readDir(current)) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      const relativePath = toRelativeKey(relative(rootPath, absolutePath));
      if (!relativePath || isSyncMarker(relativePath)) {
        continue;
      }
      const info = await Deno.stat(absolutePath);
      const mtimeMs = info.mtime?.getTime();
      if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) {
        writeError({
          error: `Local file '${relativePath}' has no valid modified timestamp.`,
          suggestion: "Ensure local files are on a filesystem with mtime support.",
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

async function planActions(
  localFiles: Map<string, LocalFileMeta>,
  remoteFiles: Map<string, RemoteFileMeta>,
  stateFiles: Map<string, SyncStateEntry>,
  localRoot: string,
  localMode?: SyncMode,
  remoteMode?: SyncMode,
): Promise<{ actions: SyncAction[]; stats: SyncStats }> {
  if (localMode === "add" && remoteMode === "delete") {
    writeError({
      error: "Conflicting modes: --local add and --remote delete.",
      suggestion:
        "Pick one behavior for remote-only files (add locally OR delete remotely).",
    });
  }
  if (localMode === "delete" && remoteMode === "add") {
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
          reason: `conflict: local newer (local: ${fmtMs(localMeta.mtimeMs)}, remote: ${fmtMs(remoteMeta.mtimeMs)})`,
        });
      } else {
        actions.push({
          type: "download",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `conflict: remote newer (remote: ${fmtMs(remoteMeta.mtimeMs)}, local: ${fmtMs(localMeta.mtimeMs)})`,
        });
      }
      continue;
    }

    if (localMeta) {
      if (remoteMode === "add") {
        actions.push({
          type: "upload",
          relativePath: path,
          localMtimeMs: localMeta.mtimeMs,
          reason: `new local file (${fmtMs(localMeta.mtimeMs)})`,
        });
      } else if (localMode === "delete") {
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
      if (localMode === "add") {
        actions.push({
          type: "download",
          relativePath: path,
          remoteMtimeMs: remoteMeta.mtimeMs,
          reason: `new remote file (${fmtMs(remoteMeta.mtimeMs)})`,
        });
      } else if (remoteMode === "delete") {
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
    const response = await requestRaw(host, remotePath, "GET", { token });
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
    const response = await requestRaw(host, remotePath, "DELETE", { token });
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

async function writeSyncFile(rootPath: string, sitePath: string): Promise<void> {
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
    if (parsed.version !== 1 || parsed.siteRelativeUrl !== sitePath || !parsed.files) {
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
        localHash: typeof record.localHash === "string" ? record.localHash : undefined,
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

export const SYNC_DESCRIPTION =
  "Sync a local directory with a remote Restspace directory (previews changes and asks for confirmation unless --yes is provided).";

export async function runSync(
  options: { local?: string; remote?: string; yes?: boolean; verbose?: boolean },
  path: string,
  siteRelativeUrl?: string,
): Promise<void> {
  const localRoot = resolve(path);
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

  const localMode = parseMode("local", options.local);
  const remoteMode = parseMode("remote", options.remote);

  const storedSitePath = await readSyncFile(localRoot);
  const resolvedSitePath = normalizeSitePath(
    siteRelativeUrl?.trim() || storedSitePath || "",
  );

  const config = await loadConfig();
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
    localMode,
    remoteMode,
  );
  const planned = summarizePlan(actions);

  writeSuccess({
    preview: true,
    path: localRoot,
    siteRelativeUrl: resolvedSitePath,
    modes: {
      local: localMode ?? null,
      remote: remoteMode ?? null,
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

  const failures: Array<{ action: SyncActionType; path: string; error: string }> = [];
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
      local: localMode ?? null,
      remote: remoteMode ?? null,
    },
    stats,
  });
}

export function syncCommand() {
  return new Command()
    .description(SYNC_DESCRIPTION)
    .arguments("<path:string> [siteRelativeUrl:string]")
    .option("--local <mode:string>", "Local mismatch behavior: add|delete")
    .option("--remote <mode:string>", "Remote mismatch behavior: add|delete")
    .option("-y, --yes", "Bypass confirmation prompt")
    .option("-v, --verbose", "Show per-file reasons for scheduled uploads/downloads")
    .action(async (options, path, siteRelativeUrl) => {
      await runSync(
        options as { local?: string; remote?: string; yes?: boolean; verbose?: boolean },
        path,
        siteRelativeUrl,
      );
    });
}
