import { dirname, join } from "std/path/mod.ts";

export type RsConfig = {
  host?: string;
  credentials?: {
    email?: string;
    password?: string;
  };
  auth?: {
    token?: string;
    expiry?: number;
  };
};

const CONFIG_DIR = ".restspace";
const CONFIG_FILE = "config.json";

function getHomeDir(): string {
  return Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ??
    Deno.env.get("HOMEPATH") ??
    Deno.cwd();
}

export function getConfigPath(): string {
  return join(getHomeDir(), CONFIG_DIR, CONFIG_FILE);
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

export async function loadConfig(): Promise<RsConfig> {
  if (!(await configExists())) {
    return {};
  }
  const raw = await Deno.readTextFile(getConfigPath());
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as RsConfig;
}

export async function saveConfig(config: RsConfig): Promise<void> {
  const path = getConfigPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2));
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
