import { ApiClient, type ApiResponse } from "./api-client.ts";

export type LoginResult = {
  token: string;
  expiry?: number;
  user?: unknown;
};

export class AuthSessionError extends Error {
  status?: number;
  details?: unknown;
  suggestion?: string;

  constructor(
    message: string,
    options: { status?: number; details?: unknown; suggestion?: string } = {},
  ) {
    super(message);
    this.name = "AuthSessionError";
    this.status = options.status;
    this.details = options.details;
    this.suggestion = options.suggestion;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeExpiry(value: number): number {
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}

export function isAuthExpired(expiry?: number): boolean {
  return typeof expiry === "number" && expiry <= nowSeconds();
}

function extractTokenFromCookie(
  headers: Record<string, string>,
): string | undefined {
  const setCookie = headers["set-cookie"];
  if (!setCookie) {
    return undefined;
  }
  const match = setCookie.match(/rs-auth=([^;]+)/);
  return match ? match[1] : undefined;
}

function extractTokenFromUser(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return typeof record._jwt === "string" ? record._jwt : undefined;
}

export function extractExpiry(payload: unknown): number | undefined {
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

export function extractUser(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return record.user;
}

export function extractErrorMessage(payload: unknown): string | undefined {
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

function extractToken(response: ApiResponse): string | undefined {
  return extractTokenFromCookie(response.headers) ??
    extractTokenFromUser(response.data);
}

export async function loginWithCredentials(
  host: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const client = new ApiClient(host);
  let response: ApiResponse;
  try {
    response = await client.request("POST", "/auth/login", {
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new AuthSessionError(
      error instanceof Error ? error.message : String(error),
      {
        suggestion: "Check network connectivity and the host URL.",
      },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new AuthSessionError(
      extractErrorMessage(response.data) ?? "Login failed.",
      {
        status: response.status,
        details: response.data,
        suggestion: "Verify the email and password.",
      },
    );
  }

  const token = extractToken(response);
  if (!token) {
    throw new AuthSessionError(
      "Login response did not include rs-auth cookie or user._jwt.",
      {
        status: response.status,
        suggestion: "Check the server login response.",
      },
    );
  }

  return {
    token,
    expiry: extractExpiry(response.data),
    user: extractUser(response.data),
  };
}
