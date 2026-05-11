type JsonRecord = Record<string, unknown>;
const textEncoder = new TextEncoder();

function formatJson(success: boolean, payload: JsonRecord): string {
  return JSON.stringify({ success, ...payload }, null, 2);
}

export function writeSuccess(payload: JsonRecord = {}): void {
  console.log(formatJson(true, payload));
}

export function writeRaw(value: string): void {
  Deno.stdout.writeSync(textEncoder.encode(value));
}

export function writeError(payload: JsonRecord = {}, exitCode = 1): never {
  console.error(formatJson(false, payload));
  Deno.exit(exitCode);
}
