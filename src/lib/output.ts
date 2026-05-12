type JsonRecord = Record<string, unknown>;
const textEncoder = new TextEncoder();

function formatJson(success: boolean, payload: JsonRecord): string {
  return JSON.stringify({ success, ...payload }, null, 2);
}

export function writeSuccess(payload: JsonRecord = {}): void {
  console.log(formatJson(true, payload));
}

export function writeRaw(value: string): void {
  const bytes = textEncoder.encode(value);
  let offset = 0;
  while (offset < bytes.length) {
    offset += Deno.stdout.writeSync(bytes.subarray(offset));
  }
}

export function writeError(payload: JsonRecord = {}, exitCode = 1): never {
  console.error(formatJson(false, payload));
  Deno.exit(exitCode);
}
