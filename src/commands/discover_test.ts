import { assertEquals, assertExists } from "std/assert/mod.ts";
import { stub } from "std/testing/mock.ts";
import {
  discoverCommand,
  extractServiceJsonc,
  loadAgentDiscoveryJsonc,
  loadCatalogue,
  parseServicesJsoncSummaries,
} from "./discover.ts";

Deno.test("discoverCommand constructs without duplicate subcommand names", () => {
  const command = discoverCommand();

  assertExists(command);
});

Deno.test("loadCatalogue fetches the catalogue agent-discovery endpoint", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const payload = `{"services":[{"name":"Data Service"}]}`;
  const fetchStub = stub(globalThis, "fetch", async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
    });
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  try {
    const catalogue = await loadCatalogue("https://tenant.restspace.io");

    assertEquals(calls, [{
      url:
        "https://tenant.restspace.io/.well-known/restspace/catalogue/agent-discovery",
      method: "GET",
    }]);
    assertEquals(catalogue, payload);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("loadCatalogue fetches a named catalogue agent-discovery endpoint", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const payload = `{"name":"Data Service"}`;
  const fetchStub = stub(globalThis, "fetch", async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
    });
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  try {
    const catalogue = await loadCatalogue(
      "https://tenant.restspace.io",
      undefined,
      undefined,
      "Data Service",
    );

    assertEquals(calls, [{
      url:
        "https://tenant.restspace.io/.well-known/restspace/catalogue/agent-discovery/Data%20Service",
      method: "GET",
    }]);
    assertEquals(catalogue, payload);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("loadAgentDiscoveryJsonc fetches raw.jsonc and preserves comments", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const rawJsonc = `{\\n  // service comments\\n  "services": []\\n}`;
  const fetchStub = stub(globalThis, "fetch", async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
    });
    return new Response(rawJsonc, {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  try {
    const text = await loadAgentDiscoveryJsonc("https://tenant.restspace.io");

    assertEquals(calls, [{
      url: "https://tenant.restspace.io/.well-known/restspace/raw.jsonc",
      method: "GET",
    }]);
    assertEquals(text, rawJsonc);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("parseServicesJsoncSummaries prepends service comments to descriptions", () => {
  const rawJsonc = `{
  // Hosts a static site with options suitable for SPA routing
  // Uses fallback routing for client-side paths.
  "/admin": {
    "name": "Admin",
    "description": "Serves the admin application.",
  },
  "/logs": {
    "name": "Logs"
  }
}`;

  const services = parseServicesJsoncSummaries(rawJsonc);

  assertEquals(services, [
    {
      description:
        "Hosts a static site with options suitable for SPA routing\nUses fallback routing for client-side paths.\n\nServes the admin application.",
      name: "Admin",
      basePath: "/admin",
    },
    {
      description: "",
      name: "Logs",
      basePath: "/logs",
    },
  ]);
});

Deno.test("parseServicesJsoncSummaries supports wrapped services and block comments", () => {
  const rawJsonc = `{
  "services": {
    /*
     * Stores event data.
     * Powers reporting views.
     */
    "/events": {
      "name": "Events",
      "description": "Event database"
    }
  }
}`;

  const services = parseServicesJsoncSummaries(rawJsonc);

  assertEquals(services, [{
    description:
      "Stores event data.\nPowers reporting views.\n\nEvent database",
    name: "Events",
    basePath: "/events",
  }]);
});

Deno.test("extractServiceJsonc returns a single service snippet with its leading comment", () => {
  const rawJsonc = `{
  "services": {
    // Hosts a static site with options suitable for SPA routing
    "/admin": {
      "name": "Admin",
      "adapterConfig": {
        "basePath": "/site"
      }
    },
    "/logs": {
      "name": "Logs"
    }
  }
}`;

  const snippet = extractServiceJsonc(rawJsonc, "/admin");

  assertEquals(
    snippet,
    `    // Hosts a static site with options suitable for SPA routing
    "/admin": {
      "name": "Admin",
      "adapterConfig": {
        "basePath": "/site"
      }
    }`,
  );
});

Deno.test("extractServiceJsonc returns the matching service without a trailing comma", () => {
  const rawJsonc = `{
  "services": {
    "/admin": {
      "name": "Admin"
    },
    "/logs": {
      "name": "Logs"
    }
  }
}`;

  const snippet = extractServiceJsonc(rawJsonc, "/logs");

  assertEquals(
    snippet,
    `    "/logs": {
      "name": "Logs"
    }`,
  );
});
