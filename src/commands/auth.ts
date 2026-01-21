import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import {
  loadConfig,
  normalizeHost,
  resolvePassword,
  saveConfig,
} from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeExpiry(value: number): number {
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}

function extractToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["token", "jwt", "accessToken", "authToken"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function extractExpiry(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.expiry === "number") {
    return normalizeExpiry(record.expiry);
  }
  if (typeof record.expiresAt === "number") {
    return normalizeExpiry(record.expiresAt);
  }
  if (typeof record.expiresIn === "number") {
    return nowSeconds() + record.expiresIn;
  }
  return undefined;
}

function extractUser(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return record.user;
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

export function registerAuthCommands(app: Command): void {
  app.command("login")
    .description("Authenticate and cache the JWT.")
    .option("--host <host:string>", "Server URL")
    .option("--email <email:string>", "Login email")
    .option("--password <password:string>", "Login password")
    .action(async (options) => {
      const config = await loadConfig();
      const host = resolveHost(options.host ?? config.host);
      const email = options.email ?? config.credentials?.email;
      if (!email) {
        writeError({
          error: "Missing email.",
          suggestion: "Run `rs config set email <email>` or pass --email.",
        });
      }
      const password = options.password ?? resolvePassword(config);
      if (!password) {
        writeError({
          error: "Missing password.",
          suggestion: "Set RS_PASSWORD or run `rs config set password <value>`.",
        });
      }

      const client = new ApiClient(host);
      let response: ApiResponse;
      try {
        response = await client.request("POST", "/auth/login", {
          body: JSON.stringify({ email, password }),
        });
      } catch (error) {
        writeError({
          error: error instanceof Error ? error.message : String(error),
          suggestion: "Check network connectivity and the host URL.",
        });
      }

      if (response.status < 200 || response.status >= 300) {
        writeError({
          status: response.status,
          error: extractErrorMessage(response.data) ??
            "Login failed.",
          suggestion: "Verify the email and password.",
        });
      }

      const token = extractToken(response.data);
      if (!token) {
        writeError({
          status: response.status,
          error: "Login response did not include a token.",
          suggestion: "Check the server login response format.",
        });
      }

      const expiry = extractExpiry(response.data);
      const credentials = { ...config.credentials, email };
      if (options.password) {
        credentials.password = options.password;
      }
      const nextConfig = {
        ...config,
        host,
        credentials,
        auth: { token, expiry },
      };
      await saveConfig(nextConfig);

      const user = extractUser(response.data);
      writeSuccess({
        auth: {
          expiry,
          tokenStored: true,
        },
        user,
      });
    });

  app.command("logout")
    .description("Clear cached authentication token.")
    .action(async () => {
      const config = await loadConfig();
      if (!config.auth?.token) {
        writeSuccess({ message: "No auth token to clear." });
        return;
      }
      const nextConfig = { ...config };
      delete nextConfig.auth;
      await saveConfig(nextConfig);
      writeSuccess({ message: "Logged out." });
    });

  app.command("whoami")
    .description("Show current user info and token validity.")
    .action(async () => {
      const config = await loadConfig();
      const host = resolveHost(config.host);
      const token = config.auth?.token;
      if (!token) {
        writeError({
          error: "No cached auth token.",
          suggestion: "Run `rs login` to authenticate.",
        });
      }

      const expiry = config.auth?.expiry;
      if (expiry && expiry <= nowSeconds()) {
        writeError({
          error: "Auth token expired.",
          suggestion: "Run `rs login` to refresh credentials.",
        });
      }

      const client = new ApiClient(host, token);
      let response: ApiResponse;
      try {
        response = await client.request("GET", "/auth/whoami");
      } catch (error) {
        writeError({
          error: error instanceof Error ? error.message : String(error),
          suggestion: "Check network connectivity and the host URL.",
        });
      }

      if (response.status < 200 || response.status >= 300) {
        writeError({
          status: response.status,
          error: extractErrorMessage(response.data) ??
            "Failed to load user info.",
          suggestion: "Re-authenticate with `rs login`.",
        });
      }

      writeSuccess({
        user: response.data,
        auth: {
          expiry,
          valid: expiry ? expiry > nowSeconds() : null,
        },
      });
    });
}
