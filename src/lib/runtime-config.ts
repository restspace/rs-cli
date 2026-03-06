import { AuthSessionError } from "./auth-session.ts";
import { loadConfig, type RsConfig } from "./config-store.ts";
import { writeError } from "./output.ts";

export async function loadAuthReadyConfig(): Promise<RsConfig> {
  try {
    return await loadConfig({ autoLogin: true });
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
}
