import { Command } from "cliffy/command/mod.ts";
import {
  configExists,
  getConfigPath,
  loadConfig,
  maskConfigForOutput,
  normalizeHost,
  saveConfig,
} from "../lib/config-store.ts";
import { writeError, writeSuccess } from "../lib/output.ts";

function normalizeAndValidateHost(host: string): string {
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

export function configCommand(): Command {
  const command = new Command().description("Manage CLI configuration.");

  command.command("init")
    .description("Create a config file.")
    .option("--host <host:string>", "Server URL")
    .option("--email <email:string>", "Login email")
    .option("--password <password:string>", "Login password")
    .action(async (options) => {
      if (await configExists()) {
        writeError({
          error: "Config already exists.",
          suggestion: "Use `rs config set` to update values.",
        });
      }

      const config: {
        host?: string;
        credentials?: { email?: string; password?: string };
      } = {};

      if (options.host) {
        config.host = normalizeAndValidateHost(options.host);
      }
      if (options.email || options.password) {
        config.credentials = {
          email: options.email,
          password: options.password,
        };
      }

      await saveConfig(config);
      writeSuccess({
        configPath: getConfigPath(),
        config: maskConfigForOutput(config),
      });
    });

  const setCommand = new Command().description("Set a config value.");

  setCommand.command("host <url:string>")
    .description("Set the Restspace host URL.")
    .action(async (_options, url) => {
      const config = await loadConfig();
      config.host = normalizeAndValidateHost(url);
      await saveConfig(config);
      writeSuccess({
        configPath: getConfigPath(),
        config: maskConfigForOutput(config),
      });
    });

  setCommand.command("email <email:string>")
    .description("Set the login email.")
    .action(async (_options, email) => {
      const config = await loadConfig();
      config.credentials = { ...config.credentials, email };
      await saveConfig(config);
      writeSuccess({
        configPath: getConfigPath(),
        config: maskConfigForOutput(config),
      });
    });

  setCommand.command("password <password:string>")
    .description("Set the login password.")
    .action(async (_options, password) => {
      const config = await loadConfig();
      config.credentials = { ...config.credentials, password };
      await saveConfig(config);
      writeSuccess({
        configPath: getConfigPath(),
        config: maskConfigForOutput(config),
      });
    });

  command.command("set", setCommand);

  command.command("show")
    .description("Show the current config.")
    .action(async () => {
      if (!(await configExists())) {
        writeError({
          error: "Config file not found.",
          suggestion: "Run `rs config init` or `rs config set host <url>`.",
        });
      }
      const config = await loadConfig();
      writeSuccess({
        configPath: getConfigPath(),
        config: maskConfigForOutput(config),
      });
    });

  return command;
}
