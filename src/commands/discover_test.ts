import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stub } from "https://deno.land/std@0.224.0/testing/mock.ts";
import {
  discoverCommand,
  extractServiceJsonc,
  findCatalogueEntry,
  loadAgentDiscoveryJsonc,
  loadCatalogue,
  loadServicesJsonc,
  parseServicesJsoncSummaries,
  summarizeCatalogue,
} from "./discover.ts";
import type { ApiClient } from "../lib/api-client.ts";

Deno.test("discoverCommand constructs without duplicate subcommand names", () => {
  const command = discoverCommand();

  assertExists(command);
});

Deno.test("loadCatalogue fetches the service catalogue endpoint", async () => {
  const calls: Array<[string, string]> = [];
  const client = {
    request: async (method: string, path: string) => {
      calls.push([method, path]);
      return {
        status: 200,
        headers: {},
        data: {
          services: [{ name: "Data Service" }],
          adapters: [{ name: "MongoDbDataAdapter" }],
        },
        durationMs: 1,
      };
    },
  } as ApiClient;

  const catalogue = await loadCatalogue(client);

  assertEquals(calls, [["GET", "/.well-known/restspace/catalogue"]]);
  assertEquals(catalogue, {
    services: [{ name: "Data Service" }],
    adapters: [{ name: "MongoDbDataAdapter" }],
  });
});

Deno.test("loadAgentDiscoveryJsonc fetches raw.jsonc and preserves comments", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const rawJsonc = `{\\n  // service comments\\n  "services": []\\n}`;
  const fetchStub = stub(globalThis, "fetch", async (input, init) => {
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
      url:
        "https://tenant.restspace.io/.well-known/restspace/services/agent-discovery/raw.jsonc",
      method: "GET",
    }]);
    assertEquals(text, rawJsonc);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("summarizeCatalogue maps service and adapter names to descriptions", () => {
  const summary = summarizeCatalogue({
    services: [
      { name: "Data Service", description: "Read/write generic data." },
      { name: "File Service" },
      { description: "Ignored without a name." },
    ],
    adapters: [
      {
        name: "MongoDbDataAdapter",
        description: "Store data in MongoDB.",
      },
    ],
  });

  assertEquals(summary, {
    services: {
      "Data Service": "Read/write generic data.",
      "File Service": "",
    },
    adapters: {
      MongoDbDataAdapter: "Store data in MongoDB.",
    },
  });
});

Deno.test("summarizeCatalogue uses only catalogue services and adapters", () => {
  const summary = summarizeCatalogue({
    data: { name: "Legacy Data", description: "Ignored top-level entry." },
    services: {
      data: { name: "Data Service", description: "Read/write generic data." },
    },
    adapters: {
      mongo: { name: "MongoDbDataAdapter" },
    },
  });

  assertEquals(summary, {
    services: {
      "Data Service": "Read/write generic data.",
    },
    adapters: {
      MongoDbDataAdapter: "",
    },
  });
});

Deno.test("loadServicesJsonc fetches /services.jsonc and preserves comments", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const rawJsonc = `{
  // service comments
  "/admin": {
    "name": "Admin"
  }
}`;
  const fetchStub = stub(globalThis, "fetch", async (input, init) => {
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
    const text = await loadServicesJsonc("https://tenant.restspace.io");

    assertEquals(calls, [{
      url: "https://tenant.restspace.io/services.jsonc",
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

Deno.test("findCatalogueEntry finds entries by key, name, and basePath", () => {
  const objectCatalogue = {
    data: { name: "Data Service", basePath: "/data" },
    services: { name: "Services Service" },
  };
  const arrayCatalogue = [
    { key: "template", name: "Template Service", basePath: "/templates" },
  ];

  assertEquals(findCatalogueEntry(objectCatalogue, "data"), {
    key: "data",
    entry: { name: "Data Service", basePath: "/data" },
  });
  assertEquals(findCatalogueEntry(objectCatalogue, "Services Service"), {
    key: "services",
    entry: { name: "Services Service" },
  });
  assertEquals(findCatalogueEntry(arrayCatalogue, "/templates"), {
    key: "/templates",
    entry: {
      key: "template",
      name: "Template Service",
      basePath: "/templates",
    },
  });
});
