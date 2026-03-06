import { Command } from "cliffy/command/mod.ts";
import { ApiClient, type ApiResponse } from "../lib/api-client.ts";
import {
  loadConfig,
  loadProjectConfig,
  loadUserConfig,
  normalizeHost,
  saveConfig,
} from "../lib/config-store.ts";
import {
  AuthSessionError,
  extractErrorMessage,
  isAuthExpired,
  loginWithCredentials,
  nowSeconds,
} from "../lib/auth-session.ts";
import { writeError, writeSuccess } from "../lib/output.ts";
import { loadAuthReadyConfig } from "../lib/runtime-config.ts";

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
      const userConfig = await loadUserConfig();
      const project = await loadProjectConfig();
      const config = await loadConfig();
      const host = resolveHost(options.host ?? config.host);
      const email = options.email ?? config.credentials?.email;
      if (!email) {
        writeError({
          error: "Missing email.",
          suggestion: "Run `rs config set email <email>` or pass --email.",
        });
      }
      const password = options.password ?? Deno.env.get("RS_PASSWORD") ??
        config.credentials?.password;
      if (!password) {
        writeError({
          error: "Missing password.",
          suggestion:
            "Set RS_PASSWORD or run `rs config set password <value>`.",
        });
      }

      try {
        const session = await loginWithCredentials(host, email, password);
        const credentials = { ...userConfig.credentials };
        credentials.email = email;
        if (options.password) {
          credentials.password = options.password;
        }

        const nextConfig = {
          ...userConfig,
          credentials: credentials.email || credentials.password
            ? credentials
            : undefined,
          auth: {
            token: session.token,
            expiry: session.expiry,
            host,
          },
        };
        if (options.host || !project.path) {
          nextConfig.host = host;
        }

        await saveConfig(nextConfig);

        writeSuccess({
          auth: {
            expiry: session.expiry,
            tokenStored: true,
          },
          user: session.user,
        });
      } catch (error) {
        if (error instanceof AuthSessionError) {
          writeError({
            status: error.status,
            error: error.message,
            suggestion: error.suggestion,
            details: error.details,
          });
        }
        throw error;
      }
    });

  app.command("logout")
    .description("Clear cached authentication token.")
    .action(async () => {
      const config = await loadUserConfig();
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
      const config = await loadAuthReadyConfig();
      const host = resolveHost(config.host);
      const token = config.auth?.token;
      if (!token) {
        writeError({
          error: "No cached auth token.",
          suggestion: "Run `rs login` to authenticate.",
        });
      }

      const expiry = config.auth?.expiry;
      if (isAuthExpired(expiry)) {
        writeError({
          error: "Auth token expired.",
          suggestion: "Run `rs login` to refresh credentials.",
        });
      }

      const client = new ApiClient(host, token);
      let response: ApiResponse;
      try {
        response = await client.request("GET", "/auth/user");
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
