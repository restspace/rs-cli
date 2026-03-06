import { Command } from "cliffy/command/mod.ts";
import { registerAuthCommands } from "./commands/auth.ts";
import { callCommand } from "./commands/call.ts";
import { configCommand } from "./commands/config.ts";
import { discoverCommand } from "./commands/discover.ts";
import { pipelineCommand } from "./commands/pipeline.ts";
import { queryCommand } from "./commands/query.ts";
import { sendCommand } from "./commands/send.ts";
import { syncCommand } from "./commands/sync.ts";

const app = new Command()
  .name("rs")
  .version("0.1.0")
  .description("Restspace agent-first CLI (scaffold)");

app.command("config", configCommand());
registerAuthCommands(app);
app.command("call", callCommand());
app.command("discover", discoverCommand());
app.command("pipeline", pipelineCommand());
app.command("send", sendCommand());
app.command("sync", syncCommand());
app.command("query", queryCommand());

app.action(() => {
  app.showHelp();
});

if (import.meta.main) {
  await app.parse(Deno.args);
}
