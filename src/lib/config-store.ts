import { dirname, join } from "std/path/mod.ts";
import {
  isAuthExpired,
  type LoginResult,
  loginWithCredentials,
} from "./auth-session.ts";

export type RsConfig = {
  host?: string;
  credentials?: {
    email?: string;
    password?: string;
  };
  auth?: {
    token?: string;
    expiry?: number;
    host?: string;
  };
};

const CONFIG_DIR = ".restspace";
const CONFIG_FILE = "config.json";
export const PROJECT_CONFIG_FILE = "rsconfig.json";

type RsProjectConfigFile = {
  url?: string;
  host?: string;
  login?: {
    email?: string;
    password?: string;
  };
  credentials?: {
    email?: string;
    password?: string;
  };
};

type LoadConfigOptions = {
  autoLogin?: boolean;
  cwd?: string;
  login?: (
    host: string,
    email: string,
    password: string,
  ) => Promise<LoginResult>;
};

export type ProjectConfigResult = {
  path?: string;
  config: RsConfig;
};

function getHomeDir(): string {
  return Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ??
    Deno.env.get("HOMEPATH") ??
    Deno.cwd();
}

export function getConfigPath(): string {
  return join(getHomeDir(), CONFIG_DIR, CONFIG_FILE);
}

async function readConfigFile<T>(path: string): Promise<T | undefined> {
  const raw = await Deno.readTextFile(path);
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

export async function configExists(): Promise<boolean> {
  try {
    await Deno.stat(getConfigPath());
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export async function loadUserConfig(): Promise<RsConfig> {
  if (!(await configExists())) {
    return {};
  }
  return await readConfigFile<RsConfig>(getConfigPath()) ?? {};
}

export async function saveConfig(config: RsConfig): Promise<void> {
  const path = getConfigPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2));
}

function mapProjectConfig(config: RsProjectConfigFile | undefined): RsConfig {
  if (!config) {
    return {};
  }

  const credentials = {
    ...config.credentials,
    ...config.login,
  };

  return {
    host: typeof config.url === "string"
      ? normalizeHost(config.url)
      : typeof config.host === "string"
      ? normalizeHost(config.host)
      : undefined,
    credentials: credentials.email || credentials.password
      ? credentials
      : undefined,
  };
}

export async function findProjectConfigPath(
  startDir = Deno.cwd(),
): Promise<string | undefined> {
  let currentDir = startDir;

  while (true) {
    const candidate = join(currentDir, PROJECT_CONFIG_FILE);
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) {
        return candidate;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Continue walking up until we hit the filesystem root.
      } else if (error instanceof Deno.errors.PermissionDenied) {
        return undefined;
      } else {
        throw error;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

export async function loadProjectConfig(
  startDir = Deno.cwd(),
): Promise<ProjectConfigResult> {
  const path = await findProjectConfigPath(startDir);
  if (!path) {
    return { config: {} };
  }

  const raw = await readConfigFile<RsProjectConfigFile>(path);
  return {
    path,
    config: mapProjectConfig(raw),
  };
}

function mergeCredentials(
  primary?: RsConfig["credentials"],
  override?: RsConfig["credentials"],
): RsConfig["credentials"] {
  const merged = { ...primary, ...override };
  return merged.email || merged.password ? merged : undefined;
}

function authMatchesHost(config: RsConfig, host?: string): boolean {
  const authHost = config.auth?.host ?? config.host;
  if (!config.auth?.token) {
    return false;
  }
  if (!host || !authHost) {
    return true;
  }
  return normalizeHost(authHost) === normalizeHost(host);
}

function resolveEffectiveAuth(
  config: RsConfig,
  host?: string,
): RsConfig["auth"] {
  if (!config.auth?.token) {
    return undefined;
  }
  if (!authMatchesHost(config, host)) {
    return undefined;
  }
  return {
    ...config.auth,
    host: config.auth.host ?? config.host,
  };
}

function mergeConfigLayers(
  userConfig: RsConfig,
  projectConfig: RsConfig,
): RsConfig {
  const host = projectConfig.host ?? userConfig.host;
  const credentials = mergeCredentials(
    userConfig.credentials,
    projectConfig.credentials,
  );
  const auth = resolveEffectiveAuth(userConfig, host);

  return {
    host,
    credentials,
    auth,
  };
}

function shouldAutoLogin(config: RsConfig): boolean {
  if (!config.host || !config.credentials?.email || !resolvePassword(config)) {
    return false;
  }
  if (!config.auth?.token) {
    return true;
  }
  return isAuthExpired(config.auth.expiry);
}

function stripExpiredAuth(config: RsConfig): RsConfig {
  if (!config.auth?.token || !isAuthExpired(config.auth.expiry)) {
    return config;
  }
  const nextConfig = { ...config };
  delete nextConfig.auth;
  return nextConfig;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<RsConfig> {
  const userConfig = await loadUserConfig();
  const project = await loadProjectConfig(options.cwd);
  let resolvedConfig = mergeConfigLayers(userConfig, project.config);

  if (options.autoLogin && project.path && shouldAutoLogin(resolvedConfig)) {
    const password = resolvePassword(resolvedConfig);
    if (resolvedConfig.host && resolvedConfig.credentials?.email && password) {
      const login = options.login ?? loginWithCredentials;
      const session = await login(
        resolvedConfig.host,
        resolvedConfig.credentials.email,
        password,
      );
      const nextUserConfig: RsConfig = {
        ...userConfig,
        auth: {
          token: session.token,
          expiry: session.expiry,
          host: resolvedConfig.host,
        },
      };
      await saveConfig(nextUserConfig);
      resolvedConfig = mergeConfigLayers(nextUserConfig, project.config);
    }
  }

  return options.autoLogin ? stripExpiredAuth(resolvedConfig) : resolvedConfig;
}

export function maskConfigForOutput(config: RsConfig): RsConfig {
  const masked: RsConfig = { ...config };
  if (config.credentials) {
    masked.credentials = { ...config.credentials };
    if (masked.credentials.password) {
      masked.credentials.password = "********";
    }
  }
  return masked;
}

export function resolvePassword(config: RsConfig): string | undefined {
  return Deno.env.get("RS_PASSWORD") ?? config.credentials?.password;
}

export function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}
