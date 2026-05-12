import { assert, assertEquals, assertFalse } from "std/assert/mod.ts";
import { join } from "std/path/mod.ts";
import { stub } from "std/testing/mock.ts";
import { saveConfig } from "../lib/config-store.ts";
import {
  diffConfigServices,
  extractStoreCapableServices,
  normalizeServiceJson,
  planActions,
  runSync,
  serviceBasePathToRelativePath,
  validateServiceBasePath,
} from "./sync.ts";

let envLock = Promise.resolve();

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const run = envLock.then(async () => {
    const tempHome = await Deno.makeTempDir();
    const previousHome = Deno.env.get("HOME");
    const previousUserProfile = Deno.env.get("USERPROFILE");
    const previousHomePath = Deno.env.get("HOMEPATH");
    Deno.env.set("HOME", tempHome);
    Deno.env.delete("USERPROFILE");
    Deno.env.delete("HOMEPATH");
    try {
      await saveConfig({
        host: "https://tenant.restspace.io/",
        auth: {
          token: "test-token",
          expiry: 4_102_444_800,
          host: "https://tenant.restspace.io/",
        },
      });
      return await fn();
    } finally {
      if (previousHome === undefined) {
        Deno.env.delete("HOME");
      } else {
        Deno.env.set("HOME", previousHome);
      }
      if (previousUserProfile === undefined) {
        Deno.env.delete("USERPROFILE");
      } else {
        Deno.env.set("USERPROFILE", previousUserProfile);
      }
      if (previousHomePath === undefined) {
        Deno.env.delete("HOMEPATH");
      } else {
        Deno.env.set("HOMEPATH", previousHomePath);
      }
      await Deno.remove(tempHome, { recursive: true });
    }
  });
  envLock = run.then(() => undefined, () => undefined);
  return await run;
}

async function withTempDir<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const tempDir = await Deno.makeTempDir();
  try {
    return await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("planActions supports add and delete on remote", async () => {
  const { actions, stats } = await planActions(
    new Map([
      ["local-only.txt", { mtimeMs: 1000 }],
    ]),
    new Map([
      ["remote-only.txt", { mtimeMs: 2000 }],
    ]),
    new Map(),
    ".",
    [],
    ["add", "delete"],
  );

  assertEquals(actions, [
    {
      type: "upload",
      relativePath: "local-only.txt",
      localMtimeMs: 1000,
      reason: "new local file (1970-01-01T00:00:01.000Z)",
    },
    {
      type: "deleteRemote",
      relativePath: "remote-only.txt",
      remoteMtimeMs: 2000,
      reason: "remote-only file",
    },
  ]);
  assertEquals(stats.ignored, 0);
});

Deno.test("planActions supports add and delete on local", async () => {
  const { actions, stats } = await planActions(
    new Map([
      ["local-only.txt", { mtimeMs: 1000 }],
    ]),
    new Map([
      ["remote-only.txt", { mtimeMs: 2000 }],
    ]),
    new Map(),
    ".",
    ["add", "delete"],
    [],
  );

  assertEquals(actions, [
    {
      type: "deleteLocal",
      relativePath: "local-only.txt",
      localMtimeMs: 1000,
      reason: "local-only file",
    },
    {
      type: "download",
      relativePath: "remote-only.txt",
      remoteMtimeMs: 2000,
      reason: "new remote file (1970-01-01T00:00:02.000Z)",
    },
  ]);
  assertEquals(stats.ignored, 0);
});

Deno.test("extractStoreCapableServices only includes store APIs", () => {
  const services = extractStoreCapableServices({
    services: {
      "/app": { apis: ["store"] },
      "/api/v1": { apis: ["query", "store-draft"] },
      "/plain": { apis: ["query"] },
      "/missing": {},
      "/bad": { apis: ["restore", 12] },
    },
  });

  assertEquals(services.map((service) => service.basePath), [
    "/api/v1",
    "/app",
  ]);
  assertEquals(
    extractStoreCapableServices({
      services: [{ basePath: "/array", apis: ["store"] }],
    }).map((service) => service.basePath),
    ["/array"],
  );
});

Deno.test("diffConfigServices reports added removed and changed with deterministic normalization", () => {
  const source = {
    services: {
      "/added": { apis: ["store"] },
      "/changed": { nested: { b: 2, a: 1 } },
      "/same": { b: 2, a: 1 },
    },
  };
  const target = {
    services: {
      "/removed": { apis: ["store"] },
      "/changed": { nested: { a: 1, b: 3 } },
      "/same": { a: 1, b: 2 },
    },
  };

  assertEquals(diffConfigServices(source, target), {
    added: ["/added"],
    removed: ["/removed"],
    changed: ["/changed"],
  });
  assertEquals(
    normalizeServiceJson({ b: 2, a: 1 }),
    normalizeServiceJson({
      a: 1,
      b: 2,
    }),
  );
});

Deno.test("service base paths map nested directories and reject unsafe paths", () => {
  assertEquals(serviceBasePathToRelativePath("/api/v1"), "api/v1");
  assertEquals(serviceBasePathToRelativePath("/"), "$ROOT");
  assert(validateServiceBasePath("/app").ok);
  assert(validateServiceBasePath("/").ok);
  assertFalse(validateServiceBasePath("").ok);
  assertFalse(validateServiceBasePath("/../app").ok);
  assertFalse(validateServiceBasePath("/.well-known/restspace").ok);
  assertFalse(validateServiceBasePath("/.well-known/restspace/raw").ok);
});

Deno.test("runSync --init writes services.json and creates store service directories", async () => {
  await withTempHome(async () => {
    await withTempDir(async (parent) => {
      const workspace = join(parent, "workspace");
      const calls: Array<
        { url: string; method: string; cookie: string | null }
      > = [];
      const fetchStub = stub(globalThis, "fetch", async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          cookie: request.headers.get("cookie"),
        });
        if (request.url.endsWith("/.well-known/restspace/raw")) {
          return new Response(
            JSON.stringify({
              services: {
                "/": { source: "config" },
                "/app": { source: "config" },
                "/api/v1": { source: "config" },
                "/plain": { source: "config" },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "last-modified": "Tue, 12 May 2026 10:00:00 GMT",
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            services: {
              "/": { apis: ["store"] },
              "/app": { apis: ["store"] },
              "/api/v1": { apis: ["store-versioned"] },
              "/plain": { apis: ["query"] },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "last-modified": "Tue, 12 May 2026 10:00:00 GMT",
            },
          },
        );
      });
      const logStub = stub(console, "log", () => {});

      try {
        await runSync({ init: true }, workspace);
        const raw = await Deno.readTextFile(join(workspace, "services.json"));
        assertEquals(JSON.parse(raw).services["/app"], { source: "config" });
        assert((await Deno.stat(join(workspace, "$ROOT"))).isDirectory);
        assert((await Deno.stat(join(workspace, "app"))).isDirectory);
        assert((await Deno.stat(join(workspace, "api", "v1"))).isDirectory);
        await assertMissing(join(workspace, "plain"));
        assertEquals(calls, [
          {
            url: "https://tenant.restspace.io/.well-known/restspace/raw",
            method: "GET",
            cookie: "rs-auth=test-token",
          },
          {
            url:
              "https://tenant.restspace.io/.well-known/restspace/services/raw",
            method: "GET",
            cookie: "rs-auth=test-token",
          },
        ]);
      } finally {
        fetchStub.restore();
        logStub.restore();
      }
    });
  });
});

Deno.test("runSync multi-service skips missing service directories", async () => {
  await withTempHome(async () => {
    await withTempDir(async (workspace) => {
      await Deno.mkdir(join(workspace, "app"), { recursive: true });
      await Deno.mkdir(join(workspace, "$ROOT"), { recursive: true });
      const config = {
        services: {
          "/": { apis: ["store"] },
          "/app": { apis: ["store"] },
          "/missing": { apis: ["store"] },
        },
      };
      await Deno.writeTextFile(
        join(workspace, "services.json"),
        JSON.stringify(config, null, 2),
      );
      const calls: Array<{ url: string; method: string }> = [];
      const fetchStub = stub(globalThis, "fetch", async (input, init) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, method: request.method });
        if (request.url.endsWith("/.well-known/restspace/raw")) {
          return new Response(JSON.stringify(config), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "last-modified": "Tue, 12 May 2026 10:00:00 GMT",
            },
          });
        }
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const logMessages: string[] = [];
      const logStub = stub(console, "log", (message?: unknown) => {
        logMessages.push(String(message));
      });

      try {
        await runSync({ yes: true }, workspace);
        await assertMissing(join(workspace, "missing"));
        assertEquals(
          calls.filter((call) => call.url.includes("/missing/")),
          [],
        );
        assertEquals(
          calls.filter((call) => call.url.includes("/app/?$list=details"))
            .length,
          2,
        );
        assertEquals(
          calls.filter((call) =>
            call.url === "https://tenant.restspace.io/?$list=details"
          ).length,
          2,
        );
        const finalPayload = JSON.parse(logMessages.at(-1) ?? "{}");
        assertEquals(finalPayload.skipped, [{
          basePath: "/missing",
          reason: "local directory missing",
        }]);
        const state = JSON.parse(
          await Deno.readTextFile(join(workspace, ".rs-sync-state.json")),
        );
        assertEquals(state.version, 2);
      } finally {
        fetchStub.restore();
        logStub.restore();
      }
    });
  });
});

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`Expected ${path} to be missing`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
}
