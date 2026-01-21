type JsonRecord = Record<string, unknown>;

function formatJson(success: boolean, payload: JsonRecord): string {
  return JSON.stringify({ success, ...payload }, null, 2);
}

export function writeSuccess(payload: JsonRecord = {}): void {
  console.log(formatJson(true, payload));
}

export function writeError(payload: JsonRecord = {}, exitCode = 1): never {
  console.error(formatJson(false, payload));
  Deno.exit(exitCode);
}
